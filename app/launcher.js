'use strict';
// ═════════════════════════════════════════════════════════════
//  TLW Games Launcher — MOTOR
//  Este arquivo baixa, instala e abre os jogos.
//  A TELA fica no index.html (é lá que você edita o visual).
//  Testar:  node launcher.js   (precisa do Node.js 18 ou mais novo)
// ═════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

function lerJSONSimples(arquivo) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return {}; }
}

// Repositório do GitHub onde ficam o jogos.json e as atualizações do launcher
// (o mesmo que você usa no Admin). Fica no package.json, no campo "tlw" → "repo".
const REPO = process.env.TLW_REPO
  || (lerJSONSimples(path.join(__dirname, 'package.json')).tlw || {}).repo
  || 'yantlw/tlw-launcher';
const GH_API = process.env.TLW_GH_API || 'https://api.github.com';
const JOGOS_URL = process.env.TLW_JOGOS_URL || `https://raw.githubusercontent.com/${REPO}/main/jogos.json`;

// O index.html e o jogos.json (lista reserva) ficam na mesma pasta deste arquivo (ou do .exe).
const PASTAS_APP = [__dirname, process.env.TLW_PASTA_EMBUTIDA, path.dirname(process.execPath), process.cwd()].filter(Boolean);
function arquivoDoApp(nome) {
  for (const p of PASTAS_APP) {
    const f = path.join(p, nome);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const PORTA = 47821;
const PASTA_DADOS = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'TLW Games Launcher');
const ARQ_ESTADO = path.join(PASTA_DADOS, 'instalados.json');
const ARQ_CACHE = path.join(PASTA_DADOS, 'jogos-cache.json');
const ARQ_CONFIG = path.join(PASTA_DADOS, 'config.json');
const PASTA_PADRAO = path.join(os.homedir(), 'Documents', 'TLW Games');

// Configurações que a pessoa muda na aba Configurações.
const CONFIG_PADRAO = {
  iniciarComWindows: false,
  iniciarMinimizado: true,
  segundoPlano: true,
  avisarAtualizacoes: true,
  atualizarAuto: false,
  minimizarAoJogar: true,
  pastaJogos: '',
};
const lerConfig = () => ({ ...CONFIG_PADRAO, ...lerJSONSimples(ARQ_CONFIG) });
const pastaJogos = () => lerConfig().pastaJogos || PASTA_PADRAO;
const pastaTemp = () => path.join(pastaJogos(), '.baixando');

// Recursos que só existem na versão .exe (bandeja, iniciar com o Windows, avisos...).
// Rodando com "node launcher.js", fica null e essas opções aparecem desativadas.
const casca = global.tlwShell || null;

const TOKEN = crypto.randomBytes(16).toString('hex');

let catalogo = [];
let online = false;
let visual = {}; // cores, nome e logo (seção "launcher" do jogos.json)
const downloads = new Map(); // id -> AbortController
const rodando = new Map();   // id -> processo do jogo
const clientes = new Set();  // janelas abertas (eventos)

// ───────────── utilidades ─────────────

function lerJSON(arquivo, padrao) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}

function salvarJSON(arquivo, dados) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2));
}

const lerEstado = () => lerJSON(ARQ_ESTADO, {});
const salvarEstado = (e) => salvarJSON(ARQ_ESTADO, e);

function enviar(canal, dados) {
  const msg = `event: ${canal}\ndata: ${JSON.stringify(dados || {})}\n\n`;
  for (const res of clientes) res.write(msg);
}
const avisarMudanca = () => enviar('mudou');

function listaDeJogos(dados) {
  const lista = Array.isArray(dados) ? dados : (dados && Array.isArray(dados.jogos) ? dados.jogos : []);
  return lista.filter((j) => j && j.id && j.nome);
}

function compararVersao(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const nomePasta = (id) => String(id).replace(/[^a-z0-9_-]/gi, '_');
const pastaDoJogo = (id) => path.join(pastaJogos(), nomePasta(id));

function nomeDoArquivo(jogo, url) {
  let nome = jogo.arquivo;
  if (!nome) {
    try { nome = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { /* ignora */ }
  }
  return path.basename(nome || 'jogo.zip');
}

const infoBasica = (j) => ({
  id: j.id, nome: j.nome, descricao: j.descricao, capa: j.capa,
  desenvolvedor: j.desenvolvedor, genero: j.genero, versao: j.versao,
});

async function tamanhoPasta(pasta) {
  let total = 0;
  for (const item of await fsp.readdir(pasta, { withFileTypes: true })) {
    const p = path.join(pasta, item.name);
    if (item.isDirectory()) total += await tamanhoPasta(p);
    else total += (await fsp.stat(p)).size;
  }
  return total;
}

async function acharExe(pasta, base = '', nivel = 0) {
  const itens = await fsp.readdir(path.join(pasta, base), { withFileTypes: true });
  const exe = itens.find((i) => i.isFile() && /\.exe$/i.test(i.name) && !/unins|crashhandler|setup/i.test(i.name));
  if (exe) return path.join(base, exe.name);
  if (nivel >= 2) return null;
  for (const i of itens.filter((x) => x.isDirectory())) {
    const achado = await acharExe(pasta, path.join(base, i.name), nivel + 1);
    if (achado) return achado;
  }
  return null;
}

function rodar(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 20 }, (err) => (err ? rej(err) : res()));
  });
}

async function extrairZip(zip, destino) {
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(tar)) {
      try { return await rodar(tar, ['-xf', zip, '-C', destino]); } catch { /* tenta o PowerShell */ }
    }
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    return rodar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(destino)} -Force`]);
  }
  return rodar('unzip', ['-o', '-q', zip, '-d', destino]);
}

// ───────────── catálogo ─────────────

async function buscarLista() {
  if (!process.env.TLW_JOGOS_URL) {
    // 1º: pela API do GitHub, que entrega sempre a versão mais nova (sem o cache de ~5 minutos).
    try {
      const r = await fetch(`${GH_API}/repos/${REPO}/contents/jogos.json`, {
        headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'TLW-Games-Launcher' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) return await r.json();
    } catch { /* tenta pelo link normal */ }
  }
  // 2º: pelo link normal (raw.githubusercontent.com).
  const r = await fetch(`${JOGOS_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function carregarCatalogo() {
  try {
    const dados = await buscarLista();
    catalogo = listaDeJogos(dados);
    visual = (dados && dados.launcher) || {};
    salvarJSON(ARQ_CACHE, dados);
    online = true;
  } catch {
    const reserva = lerJSON(ARQ_CACHE, null) || lerJSON(arquivoDoApp('jogos.json') || '', []);
    catalogo = listaDeJogos(reserva);
    visual = (reserva && reserva.launcher) || {};
    online = false;
  }
}

function combinar(j, inst) {
  return {
    ...j,
    instalado: inst ? {
      versao: inst.versao,
      tempoJogado: inst.tempoJogado || 0,
      tamanho: inst.tamanho || 0,
      ultimaVez: inst.ultimaVez || null,
    } : null,
    atualizacao: !!(inst && !j.removido && !j.emBreve && compararVersao(j.versao, inst.versao) > 0),
    rodando: rodando.has(j.id),
    baixando: downloads.has(j.id),
  };
}

function montarLista() {
  const est = lerEstado();
  const ids = new Set();
  const lista = catalogo.map((j) => { ids.add(j.id); return combinar(j, est[j.id]); });
  for (const [id, inst] of Object.entries(est)) {
    if (!ids.has(id) && inst.info) lista.push(combinar({ ...inst.info, removido: true }, inst));
  }
  return lista;
}

// ───────────── download ─────────────

async function baixarUm(url, destino, signal, aoProgredir) {
  const r = await fetch(url, { signal, redirect: 'follow' });
  if (!r.ok) throw new Error(`O servidor respondeu com erro ${r.status}.`);
  const total = Number(r.headers.get('content-length')) || 0;
  const saida = fs.createWriteStream(destino);
  const leitor = r.body.getReader();
  let baixado = 0;
  let ultimoEnvio = 0;
  let ultimoBaixado = 0;
  let vel = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      baixado += value.length;
      if (!saida.write(value)) await new Promise((res) => saida.once('drain', res));
      const agora = Date.now();
      if (agora - ultimoEnvio >= 250) {
        if (ultimoEnvio) vel = ((baixado - ultimoBaixado) / (agora - ultimoEnvio)) * 1000;
        ultimoEnvio = agora;
        ultimoBaixado = baixado;
        aoProgredir(baixado, total, vel);
      }
    }
  } finally {
    await new Promise((res) => saida.end(res));
  }
  if (total && baixado !== total) throw new Error('O download veio incompleto.');
  aoProgredir(baixado, total || baixado, vel);
}

async function baixarComReserva(urls, destino, signal, aoProgredir) {
  let erro;
  for (const url of urls) {
    try { return await baixarUm(url, destino, signal, aoProgredir); } catch (e) {
      if (signal.aborted) throw e;
      erro = e;
    }
  }
  if (erro && /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(String(erro.message || erro.cause))) {
    throw new Error('Não consegui baixar. Confira sua internet e tente de novo.');
  }
  throw erro;
}

// ───────────── ações ─────────────

async function instalar(id) {
  if (downloads.has(id)) return { ok: false };
  if (rodando.has(id)) throw new Error('Feche o jogo antes de atualizar.');
  const jogo = catalogo.find((j) => j.id === id);
  if (!jogo) throw new Error('Esse jogo não está na lista.');
  if (jogo.emBreve) throw new Error('Esse jogo ainda não foi lançado.');
  const urls = [].concat(jogo.download || []).filter(Boolean);
  if (!urls.length) throw new Error('Esse jogo não tem link de download no jogos.json.');

  const controle = new AbortController();
  downloads.set(id, controle);
  avisarMudanca();

  const pasta = pastaDoJogo(id);
  const nova = `${pasta}.novo`;
  const nomeArq = nomeDoArquivo(jogo, urls[0]);
  let tmp = path.join(pastaTemp(), `${path.basename(pasta)}-${nomeArq}`);

  try {
    await fsp.mkdir(pastaTemp(), { recursive: true });
    await baixarComReserva(urls, tmp, controle.signal, (baixado, total, vel) =>
      enviar('progresso', { id, fase: 'baixando', baixado, total, vel }));

    enviar('progresso', { id, fase: 'instalando' });
    await fsp.rm(nova, { recursive: true, force: true });
    await fsp.mkdir(nova, { recursive: true });

    const tipo = jogo.tipo || (/\.zip$/i.test(nomeArq) ? 'zip' : 'exe');
    let executavel;
    if (tipo === 'zip') {
      await extrairZip(tmp, nova);
      executavel = jogo.executavel ? path.normalize(jogo.executavel) : await acharExe(nova);
      if (!executavel || !fs.existsSync(path.join(nova, executavel))) {
        throw new Error('Não achei o .exe do jogo dentro do zip. Coloque o campo "executavel" no jogos.json.');
      }
    } else {
      await fsp.rename(tmp, path.join(nova, nomeArq));
      tmp = null;
      executavel = nomeArq;
    }

    await fsp.rm(pasta, { recursive: true, force: true });
    await fsp.rename(nova, pasta);

    const est = lerEstado();
    const antes = est[id] || {};
    est[id] = {
      versao: jogo.versao,
      executavel,
      tamanho: await tamanhoPasta(pasta),
      instaladoEm: Date.now(),
      tempoJogado: antes.tempoJogado || 0,
      ultimaVez: antes.ultimaVez || null,
      info: infoBasica(jogo),
    };
    salvarEstado(est);
    return { ok: true, atualizou: !!antes.versao };
  } catch (e) {
    await fsp.rm(nova, { recursive: true, force: true }).catch(() => {});
    if (controle.signal.aborted) return { ok: false, cancelado: true };
    throw e;
  } finally {
    if (tmp) await fsp.rm(tmp, { force: true }).catch(() => {});
    downloads.delete(id);
    enviar('progresso', { id, fase: 'fim' });
    avisarMudanca();
  }
}

async function jogar(id) {
  if (rodando.has(id)) return {};
  const inst = lerEstado()[id];
  if (!inst) throw new Error('Esse jogo não está instalado.');
  const exe = path.join(pastaDoJogo(id), inst.executavel);
  if (!fs.existsSync(exe)) throw new Error('O arquivo do jogo sumiu (talvez o antivírus tenha removido). Desinstale e instale de novo.');

  const inicio = Date.now();
  const filho = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
  try {
    await new Promise((res, rej) => { filho.once('spawn', res); filho.once('error', rej); });
  } catch {
    throw new Error('Não consegui abrir o jogo. O antivírus pode ter bloqueado o arquivo.');
  }
  rodando.set(id, filho);
  avisarMudanca();
  if (casca && lerConfig().minimizarAoJogar) casca.minimizar();

  filho.once('exit', () => {
    rodando.delete(id);
    const est = lerEstado();
    if (est[id]) {
      est[id].tempoJogado = (est[id].tempoJogado || 0) + (Date.now() - inicio);
      est[id].ultimaVez = Date.now();
      salvarEstado(est);
    }
    avisarMudanca();
  });
  return {};
}

async function desinstalar(id) {
  if (rodando.has(id)) throw new Error('Feche o jogo antes de desinstalar.');
  if (downloads.has(id)) throw new Error('Espere o download terminar ou cancele antes.');
  const est = lerEstado();
  if (!est[id]) return { ok: false };
  await fsp.rm(pastaDoJogo(id), { recursive: true, force: true });
  delete est[id];
  salvarEstado(est);
  avisarMudanca();
  return { ok: true };
}

async function abrirPasta(id) {
  const pasta = pastaDoJogo(id);
  await fsp.mkdir(pastaJogos(), { recursive: true });
  const alvo = id && fs.existsSync(pasta) ? pasta : pastaJogos();
  const cmd = process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  spawn(cmd, [alvo], { detached: true, stdio: 'ignore' }).unref();
  return {};
}

// ───────────── janela ─────────────

function acharNavegador() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidatos = [];
  for (const b of bases) {
    candidatos.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    candidatos.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return candidatos.find((p) => fs.existsSync(p));
}

function abrirJanela() {
  if (process.env.TLW_SEM_JANELA) return;
  const url = `http://127.0.0.1:${PORTA}/`;
  const nav = acharNavegador();
  if (nav) {
    // Modo "app": abre como janela de programa, sem barra de endereço nem abas.
    spawn(nav, [
      `--app=${url}`,
      `--user-data-dir=${path.join(PASTA_DADOS, 'janela')}`,
      '--window-size=1200,760',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ───────────── ponte com a tela ─────────────
// Esta função é colocada dentro do index.html quando a janela abre.
// Ela cria o "tlw", que a tela usa pra conversar com este motor.

function ponteDoNavegador(TOKEN) {
  const fonte = new EventSource(`/api/eventos?t=${TOKEN}`);

  async function api(rota, corpo) {
    let r;
    try {
      r = await fetch(`/api/${rota}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TLW-Token': TOKEN },
        body: JSON.stringify(corpo || {}),
      });
    } catch {
      throw new Error('O launcher foi fechado. Abra ele de novo.');
    }
    const d = await r.json();
    if (d.erro) throw new Error(d.erro);
    return d.dados;
  }

  window.tlw = {
    catalogo: () => api('catalogo'),
    lista: () => api('lista'),
    instalar: (id) => api('instalar', { id }),
    cancelar: (id) => api('cancelar', { id }),
    jogar: (id) => api('jogar', { id }),
    desinstalar: async (id, nome) => {
      const ok = window.confirm(`Desinstalar ${nome || 'este jogo'}?\n\nOs arquivos do jogo vão ser apagados do seu computador. Dá pra instalar de novo quando quiser.`);
      return ok ? api('desinstalar', { id }) : { ok: false };
    },
    abrirPasta: (id) => api('abrir-pasta', { id }),
    chamar: api,
    aoEvento: (nome, cb) => fonte.addEventListener(nome, (e) => cb(JSON.parse(e.data))),
    aoProgresso: (cb) => fonte.addEventListener('progresso', (e) => cb(JSON.parse(e.data))),
    aoMudar: (cb) => fonte.addEventListener('mudou', () => cb()),
  };

  // Avisa na tela se o motor for fechado.
  let caiuEm = null;
  fonte.addEventListener('open', () => { caiuEm = null; document.body.classList.remove('desconectado'); });
  fonte.addEventListener('error', () => {
    caiuEm = caiuEm || Date.now();
    setTimeout(() => {
      if (caiuEm && Date.now() - caiuEm >= 3000) document.body.classList.add('desconectado');
    }, 3100);
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function servirTela(res) {
  const arq = arquivoDoApp('index.html');
  if (!arq) {
    return responder(res, 500, 'text/html; charset=utf-8',
      '<body style="font-family:sans-serif;background:#0b0d12;color:#eee;padding:40px">'
      + '<h2>Não achei o index.html</h2><p>Ele precisa ficar na mesma pasta do launcher.</p></body>');
  }
  const ponte = `<script>(${ponteDoNavegador.toString()})(${JSON.stringify(TOKEN)});</script>\n`;
  let html = fs.readFileSync(arq, 'utf8');
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${ponte}</head>`) : ponte + html;
  return responder(res, 200, 'text/html; charset=utf-8', html);
}

// Imagens, sons, fontes etc. que ficarem na pasta do index.html (ex.: capa.png).
function servirArquivo(res, caminho) {
  const arqTela = arquivoDoApp('index.html');
  const tipo = TIPOS[path.extname(caminho).toLowerCase()];
  if (!arqTela || !tipo) return false;
  const base = path.dirname(arqTela);
  let alvo;
  try { alvo = path.resolve(base, `.${decodeURIComponent(caminho)}`); } catch { return false; }
  if (!alvo.startsWith(base + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) return false;
  responder(res, 200, tipo, fs.readFileSync(alvo));
  return true;
}

// ───────────── configurações ─────────────

function verConfig() {
  return {
    config: lerConfig(),
    pastaAtual: pastaJogos(),
    pastaPadrao: PASTA_PADRAO,
    exe: !!casca,
    versaoApp: casca ? casca.versaoApp() : null,
  };
}

function salvarConfig(mudancas) {
  const atual = lerConfig();
  for (const k of Object.keys(CONFIG_PADRAO)) {
    if (k !== 'pastaJogos' && k in mudancas) atual[k] = !!mudancas[k];
  }
  salvarJSON(ARQ_CONFIG, atual);
  if (casca) casca.aplicarConfig(atual);
  return verConfig();
}

async function moverItem(de, para) {
  try {
    await fsp.rename(de, para);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // outro disco: copia e apaga
    await fsp.cp(de, para, { recursive: true });
    await fsp.rm(de, { recursive: true, force: true });
  }
}

async function mudarPasta({ pasta, escolher }) {
  if (escolher) {
    if (!casca) throw new Error('Escolher pasta só funciona na versão .exe.');
    pasta = await casca.escolherPasta(pastaJogos());
    if (!pasta) return verConfig(); // cancelou
  }
  if (!pasta || !String(pasta).trim()) throw new Error('Escolha uma pasta.');
  pasta = path.resolve(String(pasta).trim());
  const antiga = path.resolve(pastaJogos());
  if (antiga.toLowerCase() === pasta.toLowerCase()) return verConfig();
  if (downloads.size) throw new Error('Espere os downloads terminarem antes de mudar a pasta.');
  if (rodando.size) throw new Error('Feche os jogos antes de mudar a pasta.');
  const dentro = path.relative(antiga, pasta);
  if (dentro && !dentro.startsWith('..') && !path.isAbsolute(dentro)) {
    throw new Error('A pasta nova não pode ficar dentro da pasta atual dos jogos.');
  }

  try {
    await fsp.mkdir(pasta, { recursive: true });
    const teste = path.join(pasta, `.tlw-teste-${Date.now()}`);
    await fsp.writeFile(teste, 'ok');
    await fsp.rm(teste, { force: true });
  } catch {
    throw new Error('Não tenho permissão pra salvar nessa pasta. Escolha outra.');
  }

  enviar('pasta', { fase: 'movendo' });
  const movidos = [];
  try {
    for (const id of Object.keys(lerEstado())) {
      const de = path.join(antiga, nomePasta(id));
      const para = path.join(pasta, nomePasta(id));
      if (!fs.existsSync(de)) continue;
      if (fs.existsSync(para)) await fsp.rm(para, { recursive: true, force: true });
      await moverItem(de, para);
      movidos.push([de, para]);
    }
  } catch {
    for (const [de, para] of movidos.reverse()) await moverItem(para, de).catch(() => {});
    enviar('pasta', { fase: 'fim' });
    throw new Error('Não consegui mover os jogos pra essa pasta (pode faltar espaço). Nada foi mudado.');
  }
  await fsp.rm(path.join(antiga, '.baixando'), { recursive: true, force: true }).catch(() => {});

  const cfg = lerConfig();
  cfg.pastaJogos = pasta.toLowerCase() === path.resolve(PASTA_PADRAO).toLowerCase() ? '' : pasta;
  salvarJSON(ARQ_CONFIG, cfg);
  enviar('pasta', { fase: 'fim' });
  avisarMudanca();
  return verConfig();
}

// ───────────── atualizações dos jogos em segundo plano ─────────────
// Só na versão .exe: confere ao abrir e a cada 30 minutos.

const avisados = new Set();

async function verificarJogos() {
  await carregarCatalogo();
  const cfg = lerConfig();
  const visivel = casca && casca.janelaVisivel();
  const pendentes = montarLista().filter((j) => j.atualizacao && !j.rodando && !downloads.has(j.id));
  for (const j of pendentes) {
    if (cfg.atualizarAuto) {
      try {
        await instalar(j.id);
        if (casca && !visivel) casca.notificar(`${j.nome} atualizado`, `A versão ${j.versao} já está instalada. Bora jogar!`);
      } catch { /* tenta de novo na próxima vez */ }
    } else if (cfg.avisarAtualizacoes && casca && !visivel && !avisados.has(`${j.id}@${j.versao}`)) {
      avisados.add(`${j.id}@${j.versao}`);
      casca.notificar('Atualização disponível', `${j.nome} tem a versão ${j.versao}. Abra o launcher pra atualizar.`);
    }
  }
  avisarMudanca();
}

// ───────────── servidor local ─────────────

const ACOES = {
  catalogo: async () => { await carregarCatalogo(); return { jogos: montarLista(), online, visual }; },
  lista: async () => ({ jogos: montarLista(), online, visual }),
  instalar: ({ id }) => instalar(id),
  cancelar: async ({ id }) => { const c = downloads.get(id); if (c) c.abort(); return {}; },
  jogar: ({ id }) => jogar(id),
  desinstalar: ({ id }) => desinstalar(id),
  'abrir-pasta': ({ id }) => abrirPasta(id),
  'config-ver': async () => verConfig(),
  'config-salvar': async ({ mudancas }) => salvarConfig(mudancas || {}),
  'config-pasta': (dados) => mudarPasta(dados || {}),
  'app-procurar': async () => {
    if (!casca) throw new Error('Isso só funciona na versão .exe.');
    try {
      const r = await fetch(`${GH_API}/repos/${REPO}/contents/app/versao.json`, {
        method: 'HEAD',
        headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'TLW-Games-Launcher' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 404) return { nova: null, msg: 'nenhuma atualização publicada ainda' };
    } catch { /* deixa a casca tentar e explicar o erro */ }
    return casca.procurarAtualizacao();
  },
  'app-reiniciar': async () => { if (casca) casca.reiniciar(); return {}; },
};

function responder(res, status, tipo, corpo) {
  res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(corpo);
}

let ultimoCliente = Date.now();

const servidor = http.createServer((req, res) => {
  // Só aceita a própria janela do launcher (protege contra sites tentando usar o launcher).
  if (req.headers.host !== `127.0.0.1:${PORTA}`) return responder(res, 403, 'text/plain', 'Proibido');
  const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return servirTela(res);

  if (req.method === 'GET' && url.pathname === '/api/eventos') {
    if (url.searchParams.get('t') !== TOKEN) return responder(res, 403, 'text/plain', 'Proibido');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    clientes.add(res);
    req.on('close', () => { clientes.delete(res); ultimoCliente = Date.now(); });
    return undefined;
  }

  const acao = url.pathname.startsWith('/api/') && ACOES[url.pathname.slice(5)];
  if (req.method === 'POST' && acao) {
    if (req.headers['x-tlw-token'] !== TOKEN) return responder(res, 403, 'text/plain', 'Proibido');
    let corpo = '';
    req.on('data', (c) => { corpo += c; if (corpo.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      let dados;
      try { dados = await acao(JSON.parse(corpo || '{}')); responder(res, 200, 'application/json', JSON.stringify({ dados })); } catch (e) {
        responder(res, 200, 'application/json', JSON.stringify({ erro: (e && e.message) || String(e) }));
      }
    });
    return undefined;
  }

  if (req.method === 'GET' && !url.pathname.startsWith('/api/') && servirArquivo(res, url.pathname)) return undefined;
  return responder(res, 404, 'text/plain', 'Não encontrado');
});

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // O launcher já está aberto: só mostra a janela de novo.
    abrirJanela();
    setTimeout(() => process.exit(0), 500);
  } else {
    console.error(e);
    process.exit(1);
  }
});

servidor.listen(PORTA, '127.0.0.1', async () => {
  await carregarCatalogo();
  if (casca) {
    casca.aplicarConfig(lerConfig());
    setTimeout(() => verificarJogos().catch(() => {}), 5000);
    setInterval(() => verificarJogos().catch(() => {}), 30 * 60 * 1000);
  }
  console.log(`TLW Games Launcher rodando. Pode fechar esta janela preta quando fechar o launcher.`);
  abrirJanela();
});

// Fecha sozinho quando a janela do launcher é fechada
// (mas espera o jogo fechar pra poder contar o tempo jogado).
setInterval(() => {
  if (process.env.TLW_SEM_JANELA) return;
  const ocioso = clientes.size === 0 && Date.now() - ultimoCliente > 10000;
  if (ocioso && rodando.size === 0) {
    for (const c of downloads.values()) c.abort();
    setTimeout(() => process.exit(0), 300);
  }
}, 3000);
ultimoCliente = Date.now() + 20000; // dá um tempo pra janela abrir na primeira vez
