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
const net = require('net');
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
const ARQ_AVISOS = path.join(PASTA_DADOS, 'me-avise.json');
const ARQ_GH_CACHE = path.join(PASTA_DADOS, 'github-cache.json');
const ARQ_VISTOS = path.join(PASTA_DADOS, 'jogos-vistos.json');
const ARQ_LOG = path.join(PASTA_DADOS, 'launcher.log');
const PASTA_DOCUMENTOS = path.join(os.homedir(), 'Documents', 'TLW Games');
let PASTA_PADRAO = PASTA_DOCUMENTOS; // vira ...\TLW Games\Games quando o launcher está instalado (veja mais abaixo)

// Configurações que a pessoa muda na aba Configurações.
const CONFIG_PADRAO = {
  iniciarComWindows: false,
  iniciarMinimizado: true,
  segundoPlano: true,
  avisarAtualizacoes: true,
  atualizarAuto: false,
  pausarAoJogar: true,      // downloads esperam o jogo fechar
  limiteMBs: 0,             // limite de velocidade de download (MB/s); 0 = sem limite
  minimizarAoJogar: true,
  discord: true,
  pastaJogos: '',
};
const lerConfig = () => ({ ...CONFIG_PADRAO, ...lerJSONSimples(ARQ_CONFIG) });
const pastaJogos = () => lerConfig().pastaJogos || PASTA_PADRAO;
const pastaTemp = () => path.join(pastaJogos(), '.baixando');
let limiteBytes = Math.max(0, Number(lerConfig().limiteMBs) || 0) * 1024 * 1024;

// Recursos que só existem na versão .exe (bandeja, iniciar com o Windows, avisos...).
// Rodando com "node launcher.js", fica null e essas opções aparecem desativadas.
const casca = global.tlwShell || null;

// Instalado pelo instalador (em Arquivos de Programas\TLW Games\Launcher)?
const PASTA_INSTALACAO = path.dirname(process.execPath);
const INSTALADO = !!(casca && !process.env.PORTABLE_EXECUTABLE_FILE
  && (process.env.TLW_TESTE_INSTALADO || (process.platform === 'win32'
    && fs.existsSync(path.join(PASTA_INSTALACAO, 'Uninstall TLW Games Launcher.exe')))));

function podeGravar(pasta) {
  try {
    fs.mkdirSync(pasta, { recursive: true });
    const teste = path.join(pasta, `.tlw-teste-${process.pid}`);
    fs.writeFileSync(teste, 'ok');
    fs.rmSync(teste, { force: true });
    return true;
  } catch { return false; }
}

// Instalado: os jogos ficam em ...\TLW Games\Games (o instalador libera essa pasta).
// Se por algum motivo não der pra gravar lá, usa Documentos\TLW Games.
if (INSTALADO) {
  const games = process.env.TLW_TESTE_INSTALADO || path.join(path.dirname(PASTA_INSTALACAO), 'Games');
  if (podeGravar(games)) PASTA_PADRAO = games;
}

const TOKEN = crypto.randomBytes(16).toString('hex');

let catalogo = [];
let online = false;
let visual = {}; // cores, nome e logo (seção "launcher" do jogos.json)
const downloads = new Map(); // id -> { fase, baixado, total, vel, posicao, controle, motivo, erro }
const fila = [];             // ids esperando a vez (um download por vez)
let ativo = null;            // id que está baixando/instalando agora
const concluidos = [];       // downloads que terminaram nesta sessão (pra aba Downloads)
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

// Registro do launcher (vai no "relatório de problema"). Fica pequeno: guarda só o fim.
function registrar(t) {
  try {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    fs.mkdirSync(PASTA_DADOS, { recursive: true });
    fs.appendFileSync(ARQ_LOG, `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}  ${t}\r\n`);
    if (fs.statSync(ARQ_LOG).size > 400 * 1024) {
      const txt = fs.readFileSync(ARQ_LOG, 'utf8');
      fs.writeFileSync(ARQ_LOG, txt.slice(txt.length - 200 * 1024).replace(/^[^\n]*\n/, ''));
    }
  } catch { /* ok */ }
}
process.on('uncaughtExceptionMonitor', (e) => registrar(`ERRO GRAVE: ${(e && e.stack) || e}`));

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
const pastaPadraoDoJogo = (id) => path.join(pastaJogos(), nomePasta(id));
// Um jogo pode estar fora da pasta dos jogos (se a pessoa moveu ou apontou onde ele estava).
function pastaDoJogo(id) {
  const inst = lerEstado()[id];
  return (inst && inst.pasta) || pastaPadraoDoJogo(id);
}
const mesmoCaminho = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Espaço livre no disco onde fica a pasta (null se não der pra saber).
async function espacoLivre(pasta) {
  let p = path.resolve(pasta);
  while (!fs.existsSync(p)) { const pai = path.dirname(p); if (pai === p) break; p = pai; }
  try { const s = await fsp.statfs(p); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

function textoBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
const letraDisco = (p) => (/^[a-z]:/i.test(path.resolve(p)) ? `${path.resolve(p).slice(0, 2).toUpperCase()} ` : '');

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

const DIAS_SELO = 7;

function anotarVistos() {
  const primeiraVez = !fs.existsSync(ARQ_VISTOS);
  const v = lerJSON(ARQ_VISTOS, {});
  const agora = Date.now();
  let mudou = primeiraVez;
  for (const j of catalogo) {
    const ant = v[j.id];
    if (!ant) { v[j.id] = { visto: primeiraVez ? 0 : agora, versao: j.versao || '', versaoEm: 0 }; mudou = true; }
    else if ((j.versao || '') !== ant.versao) { ant.versaoEm = ant.versao ? agora : 0; ant.versao = j.versao || ''; mudou = true; }
  }
  if (mudou) salvarJSON(ARQ_VISTOS, v);
}

function selo(j, breve) {
  if (breve || j.removido) return '';
  const limite = Date.now() - DIAS_SELO * 864e5;
  const recente = (iso) => { const t = Date.parse(iso || ''); return !Number.isNaN(t) && t > limite && t <= Date.now() + 864e5; };
  const v = lerJSON(ARQ_VISTOS, {})[j.id] || {};
  if (recente(j.lancadoEm) || recente(j.lancamento) || (!j.lancadoEm && v.visto > limite)) return 'novo';
  if (recente(j.atualizadoEm) || (!j.atualizadoEm && v.versaoEm > limite)) return 'atualizado';
  return '';
}

async function carregarCatalogo() {
  try {
    const dados = await buscarLista();
    catalogo = listaDeJogos(dados);
    visual = (dados && dados.launcher) || {};
    salvarJSON(ARQ_CACHE, dados);
    online = true;
    anotarVistos();
  } catch {
    const reserva = lerJSON(ARQ_CACHE, null) || lerJSON(arquivoDoApp('jogos.json') || '', []);
    catalogo = listaDeJogos(reserva);
    visual = (reserva && reserva.launcher) || {};
    online = false;
  }
}

// "Em breve" de verdade: com data de lançamento, o jogo libera sozinho na hora marcada
// (se o arquivo já estiver publicado). Sem data, vale a caixinha "Em breve" do Admin.
function emBreve(j) {
  const data = j.lancamento ? Date.parse(j.lancamento) : NaN;
  const temDownload = [].concat(j.download || []).filter(Boolean).length > 0;
  if (!Number.isNaN(data)) return Date.now() < data || !temDownload;
  return !!j.emBreve;
}

const lerAvisos = () => { const a = lerJSON(ARQ_AVISOS, []); return Array.isArray(a) ? a : []; };

function resumoDownload(id) {
  const d = downloads.get(id);
  if (!d) return null;
  return {
    fase: d.fase, baixado: d.baixado || 0, total: d.total || 0, vel: d.fase === 'baixando' ? Math.round(d.vel || 0) : 0,
    posicao: d.fase === 'fila' ? fila.indexOf(id) + 1 : 0, erro: d.erro || '', auto: !!d.auto,
  };
}

function combinar(j, inst) {
  const breve = emBreve(j);
  return {
    ...j,
    emBreve: breve,
    selo: selo(j, breve),
    avisar: lerAvisos().includes(j.id),
    download: resumoDownload(j.id),
    instalado: inst ? {
      versao: inst.versao,
      tempoJogado: inst.tempoJogado || 0,
      tamanho: inst.tamanho || 0,
      ultimaVez: inst.ultimaVez || null,
      atalho: !!(inst.atalho && fs.existsSync(inst.atalho)),
      pasta: pastaDoJogo(j.id),
      foraDaPasta: !!inst.pasta,
    } : null,
    atualizacao: !!(inst && !j.removido && !breve && compararVersao(j.versao, inst.versao) > 0),
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
  // Abre o arquivo antes: se a pasta não deixar gravar, dá um erro que dá pra tratar
  // (antes, esse erro derrubava o launcher inteiro).
  await fsp.writeFile(destino, '');
  const saida = fs.createWriteStream(destino);
  let erroGravar = null;
  saida.on('error', (e) => { erroGravar = e; });
  const leitor = r.body.getReader();
  let baixado = 0;
  let ultimoEnvio = 0;
  let ultimoBaixado = 0;
  let vel = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (erroGravar) throw erroGravar;
      baixado += value.length;
      if (!saida.write(value)) {
        await new Promise((res) => {
          const pronto = () => { saida.off('drain', pronto); saida.off('error', pronto); res(); };
          saida.on('drain', pronto);
          saida.on('error', pronto);
        });
      }
      const agora = Date.now();
      if (agora - ultimoEnvio >= 250) {
        if (ultimoEnvio) vel = ((baixado - ultimoBaixado) / (agora - ultimoEnvio)) * 1000;
        ultimoEnvio = agora;
        ultimoBaixado = baixado;
        aoProgredir(baixado, total, vel);
      }
    }
  } finally {
    await new Promise((res) => { if (saida.destroyed || erroGravar) res(); else saida.end(res); });
  }
  if (erroGravar) throw erroGravar;
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

// ───────────── downloads: fila, pausar e continuar ─────────────
// Um download por vez; os outros ficam na fila. O arquivo parcial fica em
// <pasta dos jogos>\.baixando, junto com um .json que diz de qual versão ele é.
// Pausar (ou a internet cair) guarda o que já baixou; continuar pede só o resto.

const ESPERAS_RECONECTAR = [2, 4, 8, 15, 30, 30, 60, 60]; // segundos

function avisarDownload(id) {
  const r = resumoDownload(id);
  enviar('progresso', r ? { id, ...r } : { id, fase: 'fim' });
}

function caminhosParcial(jogo, url) {
  const base = path.join(pastaTemp(), `${nomePasta(jogo.id)}-${nomeDoArquivo(jogo, url)}`);
  return { tmp: `${base}.parcial`, meta: `${base}.json` };
}

const esperar = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('abortado')); }, { once: true });
});

const erroDeRede = (e) => /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket|terminated|other side closed|incompleto/i
  .test(`${e && e.message} ${e && e.cause && (e.cause.code || e.cause.message)}`);

// Baixa (ou continua baixando) um link pro arquivo tmp. Devolve quando terminar.
async function baixarParte(url, tmp, d) {
  let inicio = 0;
  try { inicio = fs.statSync(tmp).size; } catch { inicio = 0; }
  const r = await fetch(url, {
    signal: d.controle.signal,
    redirect: 'follow',
    headers: inicio > 0 ? { Range: `bytes=${inicio}-` } : {},
  });
  if (r.status === 416) {
    // O servidor diz que não tem mais nada depois do que já temos: o arquivo já está completo.
    if (d.total && inicio === d.total) return;
    await fsp.rm(tmp, { force: true });
    throw Object.assign(new Error('incompleto'), { recomecar: true });
  }
  if (!r.ok) throw Object.assign(new Error(`O servidor respondeu com erro ${r.status}.`), { http: r.status });
  let anexar = false;
  if (r.status === 206) {
    const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
    d.total = m ? Number(m[1]) : inicio + (Number(r.headers.get('content-length')) || 0);
    anexar = true;
  } else {
    d.total = Number(r.headers.get('content-length')) || 0; // o servidor não aceita continuar: recomeça
    inicio = 0;
  }
  // Tem espaço? (o que falta baixar + o zip aberto, se for zip + uma folguinha)
  if (d.total) {
    const precisa = (d.total - inicio) + (d.zip ? d.total * 2 : 0) + 50 * 1024 * 1024;
    const livre = await espacoLivre(tmp);
    if (livre !== null && livre < precisa) {
      try { await r.body.cancel(); } catch { /* ok */ }
      throw Object.assign(new Error(`Falta espaço no disco ${letraDisco(tmp)}pra baixar esse jogo: precisa de ${textoBytes(precisa)} livres e tem ${textoBytes(livre)}. Libere espaço ou mude a pasta dos jogos em Configurações.`), { manterParcial: true, semEspaco: true });
    }
  }
  await fsp.writeFile(tmp, '', { flag: anexar ? 'a' : 'w' });
  const saida = fs.createWriteStream(tmp, { flags: anexar ? 'a' : 'w' });
  let erroGravar = null;
  saida.on('error', (e) => { erroGravar = e; });
  const leitor = r.body.getReader();
  d.baixado = inicio;
  let ultimoEnvio = 0;
  let ultimoBaixado = inicio;
  const janela = { inicio: Date.now(), bytes: 0, limite: limiteBytes };
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (erroGravar) throw erroGravar;
      d.baixado += value.length;
      // Limite de velocidade: se baixou rápido demais, espera um pouco antes de ler mais.
      if (janela.limite !== limiteBytes) { janela.inicio = Date.now(); janela.bytes = 0; janela.limite = limiteBytes; }
      if (limiteBytes > 0) {
        janela.bytes += value.length;
        const deveria = (janela.bytes / limiteBytes) * 1000;
        const passou = Date.now() - janela.inicio;
        if (deveria > passou) await esperar(Math.min(deveria - passou, 5000), d.controle.signal);
        if (Date.now() - janela.inicio > 3000) { janela.inicio = Date.now(); janela.bytes = 0; }
      }
      if (!saida.write(value)) {
        await new Promise((res) => {
          const pronto = () => { saida.off('drain', pronto); saida.off('error', pronto); res(); };
          saida.on('drain', pronto);
          saida.on('error', pronto);
        });
      }
      const agora = Date.now();
      if (agora - ultimoEnvio >= 250) {
        if (ultimoEnvio) {
          const instantanea = ((d.baixado - ultimoBaixado) / (agora - ultimoEnvio)) * 1000;
          d.vel = d.vel ? d.vel * 0.7 + instantanea * 0.3 : instantanea; // suaviza pra o "tempo restante" não pular
        }
        ultimoEnvio = agora;
        ultimoBaixado = d.baixado;
        d.fase = 'baixando';
        d.erro = '';
        avisarDownload(d.id);
      }
    }
  } finally {
    await new Promise((res) => { if (saida.destroyed || erroGravar) res(); else saida.end(res); });
  }
  if (erroGravar) throw erroGravar;
  if (d.total && d.baixado < d.total) throw new Error('O download veio incompleto.');
}

// Tenta os links (o 2º em diante é reserva) e, se a internet cair, espera e continua de onde parou.
async function baixarComRetomada(urls, jogo, d) {
  let tentativa = 0;
  let iUrl = 0;
  for (;;) {
    const { tmp } = caminhosParcial(jogo, urls[0]);
    try {
      d.fase = 'baixando';
      avisarDownload(d.id);
      await baixarParte(urls[iUrl], tmp, d);
      return tmp;
    } catch (e) {
      if (d.controle.signal.aborted) throw e;
      if (e.http && e.http >= 400 && e.http < 500 && iUrl < urls.length - 1) { iUrl++; await fsp.rm(tmp, { force: true }); continue; }
      if (e.recomecar) continue;
      if (!erroDeRede(e) && !(e.http >= 500)) throw e;
      if (tentativa >= ESPERAS_RECONECTAR.length) {
        if (iUrl < urls.length - 1) { iUrl++; tentativa = 0; await fsp.rm(tmp, { force: true }); continue; }
        throw Object.assign(new Error('A internet caiu e não voltou. O que já baixou ficou guardado: é só clicar em Continuar.'), { manterParcial: true });
      }
      const seg = ESPERAS_RECONECTAR[tentativa++];
      d.fase = 'reconectando';
      d.erro = `Sem conexão. Tentando de novo em ${seg}s…`;
      d.vel = 0;
      avisarDownload(d.id);
      await esperar(seg * 1000, d.controle.signal);
    }
  }
}

async function instalarArquivo(jogo, tmp, nomeArq) {
  const id = jogo.id;
  const pasta = pastaDoJogo(id);
  const nova = `${pasta}.novo`;
  try {
    await fsp.rm(nova, { recursive: true, force: true });
    await fsp.mkdir(nova, { recursive: true });
    const tipo = jogo.tipo || (/\.zip$/i.test(nomeArq) ? 'zip' : 'exe');
    let executavel;
    if (tipo === 'zip') {
      await extrairZip(tmp, nova);
      await fsp.rm(tmp, { force: true });
      executavel = jogo.executavel ? path.normalize(jogo.executavel) : await acharExe(nova);
      if (!executavel || !fs.existsSync(path.join(nova, executavel))) {
        throw new Error('Não achei o .exe do jogo dentro do zip. Coloque o campo "executavel" no jogos.json.');
      }
    } else {
      await moverItem(tmp, path.join(nova, nomeArq));
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
      ...(antes.atalho ? { atalho: antes.atalho } : {}),
      ...(antes.pasta ? { pasta: antes.pasta } : {}),
      info: infoBasica(jogo),
    };
    salvarEstado(est);
    await salvarManifesto(id).catch(() => {});
    if (antes.atalho) await refazerAtalho(id).catch(() => {});
    return { ok: true, atualizou: !!antes.versao };
  } catch (e) {
    await fsp.rm(nova, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

function traduzirErro(e) {
  if (e && ['EPERM', 'EACCES', 'ENOTDIR', 'EROFS', 'EBUSY'].includes(e.code)) {
    return new Error(`Não tenho permissão pra salvar na pasta dos jogos (${pastaJogos()}). Mude a pasta em Configurações.`);
  }
  if (e && e.code === 'ENOSPC') return new Error('Não tem espaço suficiente no disco pra instalar esse jogo.');
  return e;
}

async function executarDownload(id, d) {
  const jogo = catalogo.find((j) => j.id === id);
  if (!jogo || emBreve(jogo)) throw new Error(jogo ? 'Esse jogo ainda não foi lançado.' : 'Esse jogo não está na lista.');
  const urls = [].concat(jogo.download || []).filter(Boolean);
  if (!urls.length) throw new Error('Esse jogo não tem link de download no jogos.json.');
  if (rodando.has(id)) throw new Error('Feche o jogo antes de atualizar.');

  const { tmp, meta } = caminhosParcial(jogo, urls[0]);
  d.zip = (jogo.tipo || (/\.zip$/i.test(nomeDoArquivo(jogo, urls[0])) ? 'zip' : 'exe')) === 'zip';
  await fsp.mkdir(pastaTemp(), { recursive: true });
  const antigo = lerJSON(meta, null);
  if (!antigo || antigo.versao !== jogo.versao) await fsp.rm(tmp, { force: true });
  salvarJSON(meta, { id, versao: jogo.versao, urls });

  try {
    await baixarComRetomada(urls, jogo, d);
  } catch (e) {
    if (!d.controle.signal.aborted && !e.manterParcial) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      await fsp.rm(meta, { force: true }).catch(() => {});
    }
    throw e;
  }
  d.fase = 'instalando';
  avisarDownload(id);
  const r = await instalarArquivo(jogo, tmp, nomeDoArquivo(jogo, urls[0]));
  await fsp.rm(tmp, { force: true }).catch(() => {});
  await fsp.rm(meta, { force: true }).catch(() => {});
  return r;
}

// Com um jogo aberto, os downloads esperam (se a opção estiver ligada). As atualizações
// automáticas sempre esperam, pra nunca dar lag no meio da partida.
function esperaJogo(d) {
  return rodando.size > 0 && (lerConfig().pausarAoJogar || (d && d.auto));
}

async function processarFila() {
  if (ativo || !fila.length) return;
  const i = fila.findIndex((x) => !esperaJogo(downloads.get(x)));
  for (const x of fila) {
    const dx = downloads.get(x);
    const msg = esperaJogo(dx) ? 'Esperando você fechar o jogo' : '';
    if (dx && dx.erro !== msg && (msg || dx.erro === 'Esperando você fechar o jogo')) { dx.erro = msg; avisarDownload(x); }
  }
  if (i < 0) return;
  const [id] = fila.splice(i, 1);
  const d = downloads.get(id);
  if (!d) { processarFila(); return; }
  ativo = id;
  d.controle = new AbortController();
  d.motivo = '';
  d.erro = '';
  fila.forEach((x) => avisarDownload(x));
  try {
    const r = await executarDownload(id, d);
    downloads.delete(id);
    const jogo = catalogo.find((j) => j.id === id) || {};
    concluidos.unshift({ id, nome: jogo.nome || id, versao: jogo.versao || '', em: Date.now(), atualizou: !!(r && r.atualizou), auto: !!d.auto });
    concluidos.splice(20);
    registrar(`download ok: ${id} v${jogo.versao}${d.auto ? ' (automático)' : ''}`);
    d.resolver(r);
  } catch (e) {
    if (d.controle.signal.aborted && (d.motivo === 'fila' || d.motivo === 'jogo')) {
      // Saiu da vez (outro jogo passou na frente, ou um jogo abriu): volta pra fila.
      d.fase = 'fila'; d.vel = 0;
      d.erro = d.motivo === 'jogo' ? 'Esperando você fechar o jogo' : '';
      fila.splice(d.motivo === 'fila' ? Math.min(1, fila.length) : 0, 0, id);
    } else if (d.controle.signal.aborted && d.motivo === 'pausa') {
      d.fase = 'pausado'; d.vel = 0; d.erro = '';
      d.resolver({ ok: false, pausado: true });
    } else if (d.controle.signal.aborted) {
      await apagarParcial(id);
      downloads.delete(id);
      d.resolver({ ok: false, cancelado: true });
    } else if (e.manterParcial) {
      d.fase = 'pausado'; d.vel = 0; d.erro = e.message;
      if (d.auto && casca && e.semEspaco) casca.notificar('Sem espaço pra atualizar', e.message);
      d.rejeitar(e);
    } else {
      downloads.delete(id);
      d.rejeitar(traduzirErro(e));
    }
    if (!d.controle.signal.aborted || d.motivo === 'cancelar') registrar(`download parou: ${id}: ${e && e.message}`);
  } finally {
    ativo = null;
    avisarDownload(id);
    avisarMudanca();
    processarFila();
  }
}

async function apagarParcial(id) {
  const jogo = catalogo.find((j) => j.id === id);
  if (!jogo) return;
  const urls = [].concat(jogo.download || []).filter(Boolean);
  if (!urls.length) return;
  const { tmp, meta } = caminhosParcial(jogo, urls[0]);
  await fsp.rm(tmp, { force: true }).catch(() => {});
  await fsp.rm(meta, { force: true }).catch(() => {});
}

// Instalar, atualizar ou continuar um download pausado. A promessa termina quando o
// jogo estiver instalado (ou for pausado/cancelado).
function instalar(id, opc = {}) {
  const atual = downloads.get(id);
  if (atual && atual.fase !== 'pausado') return Promise.resolve({ ok: false, jaNaFila: true });
  const jogo = catalogo.find((j) => j.id === id);
  if (!jogo) return Promise.reject(new Error('Esse jogo não está na lista.'));
  if (emBreve(jogo)) return Promise.reject(new Error('Esse jogo ainda não foi lançado.'));
  if (rodando.has(id)) return Promise.reject(new Error('Feche o jogo antes de atualizar.'));
  const d = atual || { id, baixado: 0, total: 0, vel: 0 };
  d.fase = 'fila';
  d.erro = '';
  d.auto = !!opc.auto && !(atual && !atual.auto); // a pessoa mandou: deixa de ser automático
  downloads.set(id, d);
  const promessa = new Promise((res, rej) => { d.resolver = res; d.rejeitar = rej; });
  fila.push(id);
  avisarDownload(id);
  avisarMudanca();
  processarFila();
  return promessa;
}

function pausar(id) {
  const d = downloads.get(id);
  if (!d) return {};
  if (ativo === id) {
    if (d.fase === 'instalando') return {}; // já está terminando
    d.motivo = 'pausa';
    d.controle.abort();
  } else if (d.fase === 'fila') {
    fila.splice(fila.indexOf(id), 1);
    d.fase = 'pausado';
    if (d.resolver) d.resolver({ ok: false, pausado: true });
    avisarDownload(id);
    fila.forEach((x) => avisarDownload(x));
  }
  return {};
}

async function cancelar(id) {
  const d = downloads.get(id);
  if (!d) return {};
  if (ativo === id) {
    if (d.fase === 'instalando') return {};
    d.motivo = 'cancelar';
    d.controle.abort();
    return {};
  }
  if (d.fase === 'fila') fila.splice(fila.indexOf(id), 1);
  if (d.resolver) d.resolver({ ok: false, cancelado: true });
  downloads.delete(id);
  await apagarParcial(id);
  avisarDownload(id);
  fila.forEach((x) => avisarDownload(x));
  avisarMudanca();
  return {};
}

// Muda a ordem da fila (aba Downloads). "agora" passa na frente de quem está baixando.
function moverNaFila(id, para) {
  const d = downloads.get(id);
  if (!d || d.fase !== 'fila') return {};
  const i = fila.indexOf(id);
  if (i < 0) return {};
  if (para === 'cima' && i > 0) [fila[i - 1], fila[i]] = [fila[i], fila[i - 1]];
  else if (para === 'baixo' && i < fila.length - 1) [fila[i + 1], fila[i]] = [fila[i], fila[i + 1]];
  else if (para === 'agora') {
    fila.splice(i, 1);
    fila.unshift(id);
    d.auto = false;
    const a = ativo && downloads.get(ativo);
    if (a && a.fase !== 'instalando' && !esperaJogo(d)) { a.motivo = 'fila'; a.controle.abort(); }
  }
  fila.forEach((x) => avisarDownload(x));
  avisarMudanca();
  return {};
}

// Lista completa pra aba Downloads.
async function listaDownloads() {
  const est = lerEstado();
  const item = (id) => {
    const j = catalogo.find((x) => x.id === id) || (est[id] && est[id].info) || { id, nome: id };
    return { id, nome: j.nome || id, capa: j.capa || '', versao: j.versao || '', atualizando: !!est[id], ...resumoDownload(id) };
  };
  const ids = [...(ativo ? [ativo] : []), ...fila, ...[...downloads.keys()].filter((x) => x !== ativo && !fila.includes(x))];
  return {
    itens: ids.filter((x) => downloads.has(x)).map(item),
    concluidos: concluidos.map((c) => ({ ...c, capa: ((catalogo.find((x) => x.id === c.id) || {}).capa) || '', instalado: !!est[c.id] })),
    espacoLivre: await espacoLivre(pastaJogos()),
    disco: letraDisco(pastaJogos()).trim(),
    limiteMBs: lerConfig().limiteMBs,
    jogando: rodando.size > 0,
    pausarAoJogar: lerConfig().pausarAoJogar,
  };
}

// Ao abrir: downloads que ficaram pela metade aparecem como "Pausado".
async function restaurarPausados() {
  let itens = [];
  try { itens = await fsp.readdir(pastaTemp()); } catch { return; }
  for (const nome of itens.filter((n) => n.endsWith('.json'))) {
    const meta = lerJSON(path.join(pastaTemp(), nome), null);
    const jogo = meta && catalogo.find((j) => j.id === meta.id);
    if (!jogo || meta.versao !== jogo.versao || downloads.has(jogo.id)) continue;
    const { tmp } = caminhosParcial(jogo, [].concat(jogo.download || [])[0] || '');
    let baixado = 0;
    try { baixado = fs.statSync(tmp).size; } catch { continue; }
    downloads.set(jogo.id, { id: jogo.id, fase: 'pausado', baixado, total: 0, vel: 0, erro: '' });
  }
  avisarMudanca();
}

// ───────────── contador de downloads (releases do GitHub) ─────────────

function repoDoJogo(j) {
  const link = [].concat(j.download || []).find((u) => /github\.com\/[^/]+\/[^/]+\/releases\//.test(u || ''));
  const m = link && /github\.com\/([^/]+)\/([^/]+)\/releases\//.exec(link);
  if (m) return `${m[1]}/${m[2]}`;
  if (j.repo) return j.repo.includes('/') ? j.repo : `${REPO.split('/')[0]}/${j.repo}`;
  return null;
}

async function extrasDoJogo(id) {
  const j = catalogo.find((x) => x.id === id) || ((lerEstado()[id] || {}).info);
  const repo = j && repoDoJogo(j);
  if (!repo) return {};
  const cache = lerJSON(ARQ_GH_CACHE, {});
  const c = cache[repo];
  if (c && Date.now() - c.em < 60 * 60 * 1000) return c.dados; // guarda por 1 hora
  try {
    const r = await fetch(`${GH_API}/repos/${repo}/releases?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TLW-Games-Launcher' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const releases = (await r.json()).filter((x) => !x.draft);
    const dados = {
      downloads: releases.reduce((n, x) => n + (x.assets || []).reduce((m, a) => m + (a.download_count || 0), 0), 0),
    };
    cache[repo] = { em: Date.now(), dados };
    salvarJSON(ARQ_GH_CACHE, cache);
    return dados;
  } catch {
    return c ? c.dados : {};
  }
}

// ───────────── "Me avise" ─────────────

const timersLancamento = new Map();

function avisar(id, ligado) {
  const lista = new Set(lerAvisos());
  if (ligado) lista.add(id); else lista.delete(id);
  salvarJSON(ARQ_AVISOS, [...lista]);
  agendarLancamentos();
  avisarMudanca();
  return { avisar: !!ligado };
}

function conferirLancamentos() {
  const lista = lerAvisos();
  const sobra = [];
  for (const id of lista) {
    const j = catalogo.find((x) => x.id === id);
    if (!j) continue;
    if (emBreve(j)) { sobra.push(id); continue; }
    if (casca) casca.notificar(`${j.nome} chegou! 🎉`, 'Já dá pra instalar no TLW Games Launcher.');
    enviar('lancou', { id, nome: j.nome });
  }
  if (sobra.length !== lista.length) { salvarJSON(ARQ_AVISOS, sobra); avisarMudanca(); }
}

// Se um jogo com "Me avise" sai nas próximas 24h, marca um despertador pra hora exata.
function agendarLancamentos() {
  for (const id of lerAvisos()) {
    const j = catalogo.find((x) => x.id === id);
    const quando = j && j.lancamento ? Date.parse(j.lancamento) : NaN;
    const falta = quando - Date.now();
    if (Number.isNaN(quando) || falta <= 0 || falta > 24 * 3600 * 1000 || timersLancamento.has(id)) continue;
    timersLancamento.set(id, setTimeout(async () => {
      timersLancamento.delete(id);
      await carregarCatalogo().catch(() => {});
      conferirLancamentos();
      avisarMudanca();
    }, falta + 3000));
  }
}

// ───────────── jogar ─────────────

async function jogar(id) {
  if (rodando.has(id)) return {};
  const inst = lerEstado()[id];
  if (!inst) throw new Error('Esse jogo não está instalado.');
  const exe = path.join(pastaDoJogo(id), inst.executavel);
  if (!fs.existsSync(exe)) throw new Error('O arquivo do jogo sumiu (talvez o antivírus tenha removido). Use "Verificar e reparar arquivos" no menu ⚙ do jogo.');

  const inicio = Date.now();
  const filho = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
  try {
    await new Promise((res, rej) => { filho.once('spawn', res); filho.once('error', rej); });
  } catch (e) {
    registrar(`não abriu o jogo ${id}: ${e && e.message}`);
    throw new Error('Não consegui abrir o jogo. O antivírus pode ter bloqueado o arquivo.');
  }
  rodando.set(id, filho);
  registrar(`jogo aberto: ${id}`);
  const a = ativo && downloads.get(ativo);
  if (a && a.fase !== 'instalando' && esperaJogo(a)) { a.motivo = 'jogo'; a.controle.abort(); }
  avisarMudanca();
  if (casca && lerConfig().minimizarAoJogar) casca.minimizar();
  discordMostrar(catalogo.find((j) => j.id === id) || inst.info || { id, nome: id }, inicio).catch(() => {});

  filho.once('exit', () => {
    rodando.delete(id);
    if (!rodando.size) discordLimpar();
    const est = lerEstado();
    if (est[id]) {
      est[id].tempoJogado = (est[id].tempoJogado || 0) + (Date.now() - inicio);
      est[id].ultimaVez = Date.now();
      salvarEstado(est);
    }
    atualizarRecentes();
    avisarMudanca();
    processarFila(); // downloads que estavam esperando o jogo fechar
  });
  return {};
}

async function desinstalar(id) {
  if (rodando.has(id)) throw new Error('Feche o jogo antes de desinstalar.');
  if (downloads.has(id)) throw new Error('Espere o download terminar ou cancele antes.');
  const est = lerEstado();
  if (!est[id]) return { ok: false };
  await fsp.rm(pastaDoJogo(id), { recursive: true, force: true });
  if (est[id].atalho) await fsp.rm(est[id].atalho, { force: true }).catch(() => {});
  await fsp.rm(arqManifesto(id), { force: true }).catch(() => {});
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
    // Link de uma versão reduzida (com qualidade) da imagem: sem serrilhado nas miniaturas.
    mini: (u, w, h, modo) => (/^https?:\/\//i.test(u || '')
      ? `/mini?t=${TOKEN}&w=${Math.round(w)}&h=${Math.round(h)}&m=${modo || 'cover'}&u=${encodeURIComponent(u)}`
      : u),
    aoEvento: (nome, cb) => fonte.addEventListener(nome, (e) => cb(JSON.parse(e.data))),
    aoProgresso: (cb) => fonte.addEventListener('progresso', (e) => cb(JSON.parse(e.data))),
    aoMudar: (cb) => fonte.addEventListener('mudou', () => cb()),
    pausar: (id) => api('pausar', { id }),
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

// ───────────── atalho na área de trabalho ─────────────

function rodarPowerShell(script, env) {
  return new Promise((res, rej) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, env: { ...process.env, ...env } }, (err, saida) => (err ? rej(err) : res(String(saida).trim())));
  });
}

async function pastaDesktop() {
  if (casca && casca.pastaDesktop) return casca.pastaDesktop();
  try { return await rodarPowerShell("[Environment]::GetFolderPath('Desktop')"); } catch { return path.join(os.homedir(), 'Desktop'); }
}

async function gravarAtalho(lnk, alvo, descricao) {
  if (casca && casca.criarAtalho) {
    if (!casca.criarAtalho(lnk, { target: alvo, cwd: path.dirname(alvo), icon: alvo, iconIndex: 0, description: descricao })) {
      throw new Error('falhou');
    }
    return;
  }
  await rodarPowerShell(
    '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:TLW_LNK);$s.TargetPath=$env:TLW_ALVO;'
    + '$s.WorkingDirectory=$env:TLW_PASTA;$s.IconLocation=$env:TLW_ALVO+",0";$s.Description=$env:TLW_DESC;$s.Save()',
    { TLW_LNK: lnk, TLW_ALVO: alvo, TLW_PASTA: path.dirname(alvo), TLW_DESC: descricao },
  );
}

async function criarAtalho(id) {
  if (process.platform !== 'win32') throw new Error('Atalhos na área de trabalho só funcionam no Windows.');
  const est = lerEstado();
  const inst = est[id];
  if (!inst) throw new Error('Esse jogo não está instalado.');
  const alvo = path.join(pastaDoJogo(id), inst.executavel);
  if (!fs.existsSync(alvo)) throw new Error('O arquivo do jogo sumiu. Use "Verificar e reparar arquivos" primeiro.');
  const nome = String((inst.info && inst.info.nome) || id).replace(/[\\/:*?"<>|]/g, '').trim() || id;
  const lnk = path.join(await pastaDesktop(), `${nome}.lnk`);
  try {
    await gravarAtalho(lnk, alvo, `${nome} (TLW Games)`);
  } catch {
    throw new Error('Não consegui criar o atalho na área de trabalho.');
  }
  est[id].atalho = lnk;
  salvarEstado(est);
  avisarMudanca();
  return { atalho: lnk };
}

// Depois de atualizar ou mudar a pasta, o atalho é refeito pra continuar funcionando.
async function refazerAtalho(id) {
  const inst = lerEstado()[id];
  if (!inst || !inst.atalho || !fs.existsSync(inst.atalho)) return;
  await criarAtalho(id);
}

// ───────────── verificar e reparar arquivos ─────────────
// Na instalação, o launcher guarda a lista de arquivos do jogo e o tamanho de cada um.
// "Verificar" compara essa lista com o que está no disco.

const arqManifesto = (id) => path.join(PASTA_DADOS, 'arquivos', `${nomePasta(id)}.json`);

async function listarArquivos(pasta, base = '', saida = {}) {
  for (const item of await fsp.readdir(path.join(pasta, base), { withFileTypes: true })) {
    const rel = path.join(base, item.name);
    if (item.isDirectory()) await listarArquivos(pasta, rel, saida);
    else if (item.isFile()) saida[rel.split(path.sep).join('/')] = (await fsp.stat(path.join(pasta, rel))).size;
  }
  return saida;
}

async function salvarManifesto(id) {
  salvarJSON(arqManifesto(id), await listarArquivos(pastaDoJogo(id)));
}

async function verificar(id) {
  if (rodando.has(id)) throw new Error('Feche o jogo antes de verificar os arquivos.');
  if (downloads.has(id)) throw new Error('Espere o download terminar.');
  const inst = lerEstado()[id];
  if (!inst) throw new Error('Esse jogo não está instalado.');
  const pasta = pastaDoJogo(id);
  const exeOk = fs.existsSync(path.join(pasta, inst.executavel));
  const lista = lerJSON(arqManifesto(id), null);
  if (!lista) return { semLista: true, ok: exeOk, problemas: exeOk ? 0 : 1, total: 1 };
  let problemas = 0;
  for (const [rel, tamanho] of Object.entries(lista)) {
    try {
      if ((await fsp.stat(path.join(pasta, ...rel.split('/')))).size !== tamanho) problemas++;
    } catch { problemas++; }
  }
  return { ok: problemas === 0, problemas, total: Object.keys(lista).length };
}

// ───────────── Discord ("Jogando ...") ─────────────
// Conversa com o Discord aberto no PC (pela conexão local dele). Não usa servidor.
// Precisa de um "ID do aplicativo" do Discord, que você coloca no Admin (aba Visual,
// ou um por jogo em Avançado). O nome desse aplicativo é o que aparece em "Jogando ...".

const discordEstado = { sock: null, id: null };

function caminhoDiscord(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return path.join(base, `discord-ipc-${i}`);
}

function quadroDiscord(op, dados) {
  const json = Buffer.from(JSON.stringify(dados), 'utf8');
  const cab = Buffer.alloc(8);
  cab.writeInt32LE(op, 0);
  cab.writeInt32LE(json.length, 4);
  return Buffer.concat([cab, json]);
}

function tentarDiscord(i, clientId) {
  return new Promise((resolver) => {
    const sock = net.createConnection(caminhoDiscord(i));
    let buf = Buffer.alloc(0);
    let pronto = false;
    const fim = (ok) => {
      if (pronto) return;
      pronto = true;
      clearTimeout(tempo);
      if (!ok) sock.destroy();
      resolver(ok ? sock : null);
    };
    const tempo = setTimeout(() => fim(false), 3000);
    sock.on('error', () => fim(false));
    sock.on('close', () => { if (discordEstado.sock === sock) discordEstado.sock = null; fim(false); });
    sock.on('connect', () => sock.write(quadroDiscord(0, { v: 1, client_id: clientId })));
    sock.on('data', (pedaco) => {
      buf = Buffer.concat([buf, pedaco]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const tam = buf.readInt32LE(4);
        if (buf.length < 8 + tam) break;
        let msg = {};
        try { msg = JSON.parse(buf.subarray(8, 8 + tam).toString('utf8')); } catch { /* ignora */ }
        buf = buf.subarray(8 + tam);
        if (op === 3) sock.write(quadroDiscord(4, msg)); // ping -> pong
        else if (op === 2) fim(false);                    // Discord recusou (ID errado?)
        else if (msg.evt === 'READY') fim(true);
      }
    });
  });
}

async function conectarDiscord(clientId) {
  if (discordEstado.sock && discordEstado.id === clientId && !discordEstado.sock.destroyed) return discordEstado.sock;
  discordFechar();
  for (let i = 0; i < 10; i++) {
    const sock = await tentarDiscord(i, clientId);
    if (sock) {
      discordEstado.sock = sock;
      discordEstado.id = clientId;
      return sock;
    }
  }
  return null; // Discord fechado
}

function discordFechar() {
  if (discordEstado.sock) discordEstado.sock.destroy();
  discordEstado.sock = null;
  discordEstado.id = null;
}

async function discordMostrar(jogo, inicio) {
  if (!lerConfig().discord) return;
  const doJogo = String(jogo.discord || '').trim();
  const id = doJogo || String(visual.discord || '').trim();
  if (!/^\d{15,22}$/.test(id)) return;
  const sock = await conectarDiscord(id);
  if (!sock) return;
  const capa = /^https:\/\//i.test(jogo.capa || '') ? jogo.capa : '';
  const atividade = {
    // Com aplicativo próprio do jogo, o nome do jogo já aparece no "Jogando".
    details: doJogo ? (jogo.genero || undefined) : jogo.nome,
    state: 'pelo TLW Games Launcher',
    timestamps: { start: inicio },
    ...(capa ? { assets: { large_image: capa, large_text: jogo.nome } } : {}),
  };
  const link = String(visual.discordLink || '').trim();
  if (/^https:\/\//i.test(link)) atividade.buttons = [{ label: 'Baixar o TLW Games Launcher', url: link }];
  sock.write(quadroDiscord(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: atividade }, nonce: crypto.randomUUID() }));
}

function discordLimpar() {
  const sock = discordEstado.sock;
  if (!sock || sock.destroyed) return;
  sock.write(quadroDiscord(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() }));
  setTimeout(discordFechar, 500);
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
    if (k === 'pastaJogos' || !(k in mudancas)) continue;
    atual[k] = typeof CONFIG_PADRAO[k] === 'number'
      ? Math.max(0, Math.min(1000, Number(mudancas[k]) || 0))
      : !!mudancas[k];
  }
  salvarJSON(ARQ_CONFIG, atual);
  limiteBytes = atual.limiteMBs * 1024 * 1024;
  processarFila(); // se desligou "esperar o jogo fechar", a fila anda
  if (!atual.discord) discordLimpar();
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
  if (downloads.size) throw new Error('Termine ou cancele os downloads (inclusive os pausados) antes de mudar a pasta.');
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
    for (const [id, inst] of Object.entries(lerEstado())) {
      if (inst.pasta) continue; // jogo que a pessoa colocou em outro lugar: fica onde está
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
  for (const [id, inst] of Object.entries(lerEstado())) {
    if (inst.atalho) await refazerAtalho(id).catch(() => {});
  }
  enviar('pasta', { fase: 'fim' });
  avisarMudanca();
  return verConfig();
}

// ───────────── achar jogo já baixado / mover jogo ─────────────

async function escolherPastaOu(pasta, escolher, inicial, titulo) {
  if (!escolher) return pasta ? String(pasta).trim() : '';
  if (!casca) throw new Error('Escolher pasta só funciona na versão .exe.');
  try {
    const { dialog, BrowserWindow } = require('electron');
    const dono = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(dono, { title: titulo, defaultPath: inicial, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
  } catch {
    return (await casca.escolherPasta(inicial)) || '';
  }
}

// A pessoa já tem o jogo no PC (formatou, trocou de disco...): aponta a pasta e o launcher reconhece.
async function localizarJogo({ id, pasta, escolher }) {
  const jogo = catalogo.find((j) => j.id === id);
  if (!jogo) throw new Error('Esse jogo não está na lista.');
  if (emBreve(jogo)) throw new Error('Esse jogo ainda não foi lançado.');
  if (lerEstado()[id]) throw new Error('Esse jogo já está instalado.');
  if (downloads.has(id)) throw new Error('Cancele o download desse jogo antes.');
  pasta = await escolherPastaOu(pasta, escolher, pastaJogos(), `Onde está ${jogo.nome}? Escolha a pasta do jogo`);
  if (!pasta) return { cancelado: true };
  pasta = path.resolve(pasta);

  const urls = [].concat(jogo.download || []).filter(Boolean);
  const nomeArq = nomeDoArquivo(jogo, urls[0] || '');
  const tipo = jogo.tipo || (/\.zip$/i.test(nomeArq) ? 'zip' : 'exe');
  // A pessoa pode ter escolhido a pasta do jogo ou a pasta de cima (ex.: "Games").
  const candidatas = [pasta, path.join(pasta, nomePasta(id))];
  let achou = null;
  for (const c of candidatas) {
    if (!fs.existsSync(c)) continue;
    if (tipo === 'exe') {
      if (fs.existsSync(path.join(c, nomeArq))) { achou = { pasta: c, executavel: nomeArq }; break; }
    } else {
      const exe = jogo.executavel ? path.normalize(jogo.executavel) : await acharExe(c);
      if (exe && fs.existsSync(path.join(c, exe))) { achou = { pasta: c, executavel: exe }; break; }
    }
  }
  if (!achou) {
    throw new Error(tipo === 'exe'
      ? `Não achei o arquivo "${nomeArq}" nessa pasta. Escolha a pasta onde está o jogo.`
      : 'Não achei o .exe do jogo nessa pasta. Escolha a pasta onde está o jogo.');
  }
  if (path.relative(pastaTemp(), achou.pasta).split(path.sep)[0] !== '..') throw new Error('Escolha a pasta onde está o jogo.');

  // Versão: no jogo .exe dá pra comparar o tamanho com o do arquivo publicado.
  let versao = jogo.versao;
  let antiga = false;
  if (tipo === 'exe' && urls[0]) {
    try {
      const r = await fetch(urls[0], { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'TLW-Games-Launcher' }, signal: AbortSignal.timeout(10000) });
      const tam = Number(r.headers.get('content-length')) || 0;
      if (r.ok && tam && tam !== fs.statSync(path.join(achou.pasta, achou.executavel)).size) { versao = '0'; antiga = true; }
    } catch { /* sem internet: considera a versão atual */ }
  }

  const est = lerEstado();
  est[id] = {
    versao,
    executavel: achou.executavel,
    tamanho: await tamanhoPasta(achou.pasta),
    instaladoEm: Date.now(),
    tempoJogado: 0,
    ultimaVez: null,
    ...(mesmoCaminho(achou.pasta, pastaPadraoDoJogo(id)) ? {} : { pasta: achou.pasta }),
    info: infoBasica(jogo),
  };
  salvarEstado(est);
  await salvarManifesto(id).catch(() => {});
  registrar(`jogo localizado: ${id} em ${achou.pasta}${antiga ? ' (versão antiga)' : ''}`);
  avisarMudanca();
  return { ok: true, antiga, pasta: achou.pasta };
}

// Muda só um jogo de lugar (ex.: do C: pro D:).
async function moverJogo({ id, pasta, escolher }) {
  const inst = lerEstado()[id];
  if (!inst) throw new Error('Esse jogo não está instalado.');
  if (rodando.has(id)) throw new Error('Feche o jogo antes de mover.');
  if (downloads.has(id)) throw new Error('Espere o download desse jogo terminar (ou cancele) antes de mover.');
  const atual = pastaDoJogo(id);
  let base = await escolherPastaOu(pasta, escolher, path.dirname(atual), `Pra onde mover ${(inst.info && inst.info.nome) || id}?`);
  if (!base) return { cancelado: true };
  base = path.resolve(base);
  const destino = path.basename(base).toLowerCase() === nomePasta(id).toLowerCase() ? base : path.join(base, nomePasta(id));
  if (mesmoCaminho(destino, atual)) return { pasta: atual };
  const rel = path.relative(atual, destino);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('A pasta nova não pode ficar dentro da pasta do jogo.');
  if (fs.existsSync(destino) && fs.readdirSync(destino).length) throw new Error(`Já existe uma pasta "${nomePasta(id)}" com arquivos nesse lugar. Escolha outro.`);
  if (!podeGravar(path.dirname(destino))) throw new Error('Não tenho permissão pra salvar nessa pasta. Escolha outra.');
  const livre = await espacoLivre(path.dirname(destino));
  const tamanho = inst.tamanho || await tamanhoPasta(atual);
  let outroDisco = true;
  try { outroDisco = fs.statSync(atual).dev !== fs.statSync(path.dirname(destino)).dev; } catch { /* ok */ }
  if (outroDisco && livre !== null && livre < tamanho + 50 * 1024 * 1024) {
    throw new Error(`Falta espaço no disco ${letraDisco(destino)}: o jogo ocupa ${textoBytes(tamanho)} e tem ${textoBytes(livre)} livres.`);
  }

  enviar('mover', { id, fase: 'movendo' });
  try {
    if (fs.existsSync(destino)) await fsp.rm(destino, { recursive: true, force: true });
    await moverItem(atual, destino);
  } catch (e) {
    if (fs.existsSync(atual)) await fsp.rm(destino, { recursive: true, force: true }).catch(() => {});
    enviar('mover', { id, fase: 'fim' });
    registrar(`não moveu ${id}: ${e.message}`);
    throw new Error('Não consegui mover o jogo pra lá. Nada foi mudado.');
  }
  const est = lerEstado();
  if (mesmoCaminho(destino, pastaPadraoDoJogo(id))) delete est[id].pasta;
  else est[id].pasta = destino;
  salvarEstado(est);
  if (est[id].atalho) await refazerAtalho(id).catch(() => {});
  registrar(`jogo movido: ${id} → ${destino}`);
  enviar('mover', { id, fase: 'fim' });
  avisarMudanca();
  return { pasta: destino };
}

// ───────────── relatório de problema ─────────────
// Junta tudo num .txt na área de trabalho, pra pessoa mandar quando algo der errado.

function fimDoArquivo(arquivo, linhas) {
  try { return fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean).slice(-linhas).join('\r\n'); } catch { return '(vazio)'; }
}

async function gerarRelatorio() {
  const est = lerEstado();
  const cfg = lerConfig();
  const livre = await espacoLivre(pastaJogos());
  const agora = new Date();
  const linhas = [
    '=== TLW Games Launcher - relatório de problema ===',
    `Gerado em: ${agora.toLocaleString('pt-BR')}`,
    `Versão do launcher: ${casca && casca.versaoApp ? casca.versaoApp() : 'teste'} (build ${versaoDoExe() || '?'})`,
    `Windows: ${os.release()} ${os.arch()} · ${INSTALADO ? 'instalado' : (process.env.PORTABLE_EXECUTABLE_FILE ? 'portátil' : 'pasta/teste')}`,
    `Programa: ${process.execPath}`,
    `Pasta dos dados: ${PASTA_DADOS}`,
    `Pasta dos jogos: ${pastaJogos()} (livre: ${livre === null ? '?' : textoBytes(livre)})`,
    `Lista de jogos: ${online ? 'online' : 'SEM CONEXÃO (usando a cópia guardada)'} · ${catalogo.length} jogos`,
    '',
    '--- Configurações ---',
    ...Object.entries(cfg).map(([k, v]) => `${k}: ${v}`),
    '',
    '--- Jogos instalados ---',
    ...(Object.keys(est).length ? Object.entries(est).map(([id, inst]) => {
      const j = catalogo.find((x) => x.id === id);
      const exe = path.join(pastaDoJogo(id), inst.executavel || '');
      return `${id}: versão ${inst.versao}${j && j.versao !== inst.versao ? ` (publicada: ${j.versao})` : ''} · ${textoBytes(inst.tamanho || 0)} · ${pastaDoJogo(id)} · exe ${fs.existsSync(exe) ? 'ok' : 'NÃO ENCONTRADO'}${rodando.has(id) ? ' · aberto agora' : ''}`;
    }) : ['(nenhum)']),
    '',
    '--- Downloads ---',
    ...(downloads.size ? [...downloads.keys()].map((id) => { const r = resumoDownload(id); return `${id}: ${r.fase} ${r.total ? `${Math.round((r.baixado / r.total) * 100)}%` : ''} ${r.erro}`; }) : ['(nenhum)']),
    ...concluidos.slice(0, 5).map((c) => `concluído: ${c.id} v${c.versao} às ${new Date(c.em).toLocaleTimeString('pt-BR')}`),
    '',
    '--- Registro do launcher (fim) ---',
    fimDoArquivo(ARQ_LOG, 150),
    '',
    '--- Registro da atualização do launcher (fim) ---',
    fimDoArquivo(path.join(os.tmpdir(), 'TLW-Games-Launcher-atualizacao.log'), 60),
    '',
  ];
  const z = (n) => String(n).padStart(2, '0');
  const nome = `TLW Games Launcher - relatório ${agora.getFullYear()}-${z(agora.getMonth() + 1)}-${z(agora.getDate())} ${z(agora.getHours())}h${z(agora.getMinutes())}.txt`;
  let pasta = PASTA_DADOS;
  try { const d = await pastaDesktop(); if (d && fs.existsSync(d)) pasta = d; } catch { /* ok */ }
  const arquivo = path.join(pasta, nome);
  fs.writeFileSync(arquivo, `﻿${linhas.join('\r\n')}`, 'utf8');
  if (process.platform === 'win32') spawn('explorer.exe', [`/select,${arquivo}`], { detached: true, stdio: 'ignore' }).unref();
  return { arquivo };
}

// ───────────── atualizações dos jogos em segundo plano ─────────────
// Só na versão .exe: confere ao abrir e a cada 30 minutos.

const avisados = new Set();

async function verificarJogos() {
  await carregarCatalogo();
  conferirLancamentos();
  agendarLancamentos();
  const cfg = lerConfig();
  const visivel = casca && casca.janelaVisivel();
  const pendentes = montarLista().filter((j) => j.atualizacao && !j.rodando && !downloads.has(j.id));
  for (const j of pendentes) {
    if (cfg.atualizarAuto) {
      registrar(`atualização automática na fila: ${j.id} v${j.versao}`);
      instalar(j.id, { auto: true }).then((r) => {
        if (r && r.ok && casca && !casca.janelaVisivel()) casca.notificar(`${j.nome} atualizado`, `A versão ${j.versao} já está instalada. Bora jogar!`);
      }).catch(() => { /* tenta de novo na próxima vez */ });
    } else if (cfg.avisarAtualizacoes && casca && !visivel && !avisados.has(`${j.id}@${j.versao}`)) {
      avisados.add(`${j.id}@${j.versao}`);
      casca.notificar('Atualização disponível', `${j.nome} tem a versão ${j.versao}. Abra o launcher pra atualizar.`);
    }
  }
  avisarMudanca();
}

// ───────────── jogar pelo ícone perto do relógio ─────────────

function atualizarRecentes() {
  if (!casca || !casca.definirRecentes) return;
  const est = lerEstado();
  const lista = Object.entries(est)
    .filter(([, inst]) => inst.ultimaVez)
    .sort((a, b) => b[1].ultimaVez - a[1].ultimaVez)
    .slice(0, 5)
    .map(([id, inst]) => ({ id, nome: (inst.info && inst.info.nome) || id }));
  casca.definirRecentes(lista);
}

global.tlwJogar = (id) => jogar(id).catch((e) => { if (casca) casca.notificar('Não consegui abrir o jogo', e.message); });

// ───────────── servidor local ─────────────

const ACOES = {
  catalogo: async () => { await carregarCatalogo(); return { jogos: montarLista(), online, visual }; },
  lista: async () => ({ jogos: montarLista(), online, visual }),
  instalar: ({ id }) => instalar(id),
  cancelar: ({ id }) => cancelar(id),
  pausar: async ({ id }) => pausar(id),
  extras: ({ id }) => extrasDoJogo(id),
  avisar: async ({ id, ligado }) => avisar(id, ligado),
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
  atalho: ({ id }) => criarAtalho(id),
  downloads: () => listaDownloads(),
  'fila-mover': async ({ id, para }) => moverNaFila(id, para),
  'jogo-localizar': (dados) => localizarJogo(dados || {}),
  'jogo-mover': (dados) => moverJogo(dados || {}),
  relatorio: () => gerarRelatorio(),
  verificar: ({ id }) => verificar(id),
};

function responder(res, status, tipo, corpo) {
  res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(corpo);
}

// ───────────── miniaturas sem serrilhado ─────────────
// O navegador reduz uma capa de 1920px pra 44px de um jeito "serrilhado". Aqui a imagem é
// reduzida com o filtro de alta qualidade do Electron, no tamanho exato, e guardada no PC.

const PASTA_MINI = path.join(PASTA_DADOS, 'miniaturas');
const miniEmAndamento = new Map();

async function gerarMiniatura(u, w, h, modo, arquivo) {
  let electron = null;
  try { electron = require('electron'); } catch { /* fora do .exe */ }
  if (!electron || !electron.nativeImage) return null;
  const r = await fetch(u, { headers: { 'User-Agent': 'TLW-Games-Launcher' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 30 * 1024 * 1024) return null;
  const img = electron.nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null; // formato que o Electron não lê (GIF, WebP...): usa a original
  const { width: iw, height: ih } = img.getSize();
  const escala = modo === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const saida = escala >= 1 ? buf : img.resize({
    width: Math.max(1, Math.round(iw * escala)),
    height: Math.max(1, Math.round(ih * escala)),
    quality: 'best',
  }).toPNG();
  fs.mkdirSync(PASTA_MINI, { recursive: true });
  fs.writeFileSync(`${arquivo}.tmp`, saida);
  fs.renameSync(`${arquivo}.tmp`, arquivo);
  return arquivo;
}

async function servirMiniatura(res, q) {
  const u = q.get('u') || '';
  const w = Math.min(4000, Math.max(8, Number(q.get('w')) || 0));
  const h = Math.min(4000, Math.max(8, Number(q.get('h')) || 0));
  const modo = q.get('m') === 'contain' ? 'contain' : 'cover';
  const original = () => { res.writeHead(302, { Location: u, 'Cache-Control': 'no-store' }); res.end(); };
  if (!/^https?:\/\//i.test(u) || !w || !h) return original();
  const chave = crypto.createHash('sha1').update(`${u}|${w}|${h}|${modo}|1`).digest('hex');
  const arquivo = path.join(PASTA_MINI, `${chave}.img`);
  let pronto = fs.existsSync(arquivo) ? arquivo : null;
  if (!pronto) {
    if (!miniEmAndamento.has(chave)) {
      miniEmAndamento.set(chave, gerarMiniatura(u, w, h, modo, arquivo).catch(() => null)
        .finally(() => miniEmAndamento.delete(chave)));
    }
    pronto = await miniEmAndamento.get(chave);
  }
  if (!pronto) return original();
  const dados = fs.readFileSync(pronto);
  const tipo = dados[0] === 0x89 ? 'image/png' : dados[0] === 0xff ? 'image/jpeg' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': dados.length, 'Cache-Control': 'private, max-age=31536000' });
  return res.end(dados);
}

// Apaga miniaturas velhas (mais de 60 dias sem uso), pra pasta não crescer pra sempre.
function limparMiniaturas() {
  try {
    const limite = Date.now() - 60 * 24 * 3600 * 1000;
    for (const n of fs.readdirSync(PASTA_MINI)) {
      const f = path.join(PASTA_MINI, n);
      try { if (fs.statSync(f).atimeMs < limite && fs.statSync(f).mtimeMs < limite) fs.rmSync(f, { force: true }); } catch { /* ok */ }
    }
  } catch { /* ok */ }
}
setTimeout(limparMiniaturas, 30000).unref();

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

  if (req.method === 'GET' && url.pathname === '/mini') {
    if (url.searchParams.get('t') !== TOKEN) return responder(res, 403, 'text/plain', 'Proibido');
    servirMiniatura(res, url.searchParams).catch(() => { try { res.writeHead(500); res.end(); } catch { /* ok */ } });
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
  registrar(`launcher aberto (build ${versaoDoExe() || '?'}, ${INSTALADO ? 'instalado' : 'não instalado'}, pasta dos jogos ${pastaJogos()})`);
  await carregarCatalogo();
  await restaurarPausados().catch(() => {});
  agendarLancamentos();
  atualizarRecentes();
  if (casca || process.env.TLW_TESTE_VERIFICAR) {
    if (casca) casca.aplicarConfig(lerConfig());
    setTimeout(() => verificarJogos().catch(() => {}), Number(process.env.TLW_TESTE_VERIFICAR) || 5000);
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
    for (const d of downloads.values()) { if (d.controle) { d.motivo = 'pausa'; d.controle.abort(); } }
    setTimeout(() => process.exit(0), 300);
  }
}, 3000);
ultimoCliente = Date.now() + 20000; // dá um tempo pra janela abrir na primeira vez

// ═════════════════════════════════════════════════════════════
//  ATUALIZAÇÃO DO PRÓPRIO LAUNCHER (pelo instalador)
//  Quando você publica um instalador novo pelo Admin (aba Launcher), ele fica
//  no campo "instalador" do app/versao.json, com o número da versão.
//  Ao abrir, o launcher compara com a versão dele. Se for mais nova:
//   • instalado: baixa o instalador (com a janelinha) e roda ele sozinho,
//     sem perguntas (só o aviso de permissão do Windows), e reabre;
//   • .exe portátil antigo: baixa e abre o instalador normal, pra pessoa
//     passar a usar a versão instalada.
// ═════════════════════════════════════════════════════════════

const exeAtual = () => process.env.PORTABLE_EXECUTABLE_FILE || '';
const podeAtualizarLauncher = () => !!(casca && (INSTALADO || exeAtual())
  && (process.platform === 'win32' || process.env.TLW_TESTE_EXE)
  && !process.argv.includes('--pular-atualizacao'));

// Versão do .exe que está rodando (o MONTAR-EXE.bat grava a data/hora da montagem).
function versaoDoExe() {
  for (const p of [process.env.TLW_PASTA_EMBUTIDA, __dirname].filter(Boolean)) {
    const v = Number((lerJSON(path.join(p, 'package.json'), {}).tlw || {}).versaoApp);
    if (v) return v;
  }
  return 0;
}

// Restos das tentativas antigas de trocar o .exe portátil.
function limparRestos() {
  // Instaladores que já foram usados (versão igual ou mais velha que a que está rodando).
  try {
    const minha = versaoDoExe();
    for (const nome of fs.readdirSync(os.tmpdir())) {
      const m = /^TLW-Games-Launcher-Setup-(\d+)\.exe$/.exec(nome);
      if ((m && minha && Number(m[1]) <= minha) || nome === 'TLW Games Launcher - atualizar.lnk'
        || nome === 'TLW-Games-Launcher-atualizar.ps1' || nome === 'TLW-Games-Launcher-atualizar.ok') {
        try { fs.rmSync(path.join(os.tmpdir(), nome), { force: true }); } catch { /* em uso: fica pra próxima */ }
      }
    }
  } catch { /* ok */ }
  const exe = exeAtual();
  if (!exe) return;
  for (const f of [`${exe}.novo`, `${exe.replace(/\.exe$/i, '')}.antigo.exe`]) {
    try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* sem permissão: deixa */ }
  }
}

async function infoInstaladorPublicado() {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/app/versao.json`, {
    headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'TLW-Games-Launcher' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const inst = (await r.json()).instalador;
  return inst && /^https?:\/\//.test(inst.url || '') && /^[a-f0-9]{64}$/.test(inst.sha256 || '') && Number(inst.versao) ? inst : null;
}

function hashArquivo(arquivo) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(arquivo).on('data', (c) => h.update(c)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

// Roda o instalador depois que o launcher fechar. Se a pessoa recusar o aviso de
// permissão do Windows, reabre o launcher atual (sem tentar atualizar de novo agora).
function logAtualizacao(t) {
  try {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    const quando = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
    fs.appendFileSync(path.join(os.tmpdir(), 'TLW-Games-Launcher-atualizacao.log'), `${quando}  [launcher] ${t}\r\n`);
    registrar(`atualização do launcher: ${t}`);
  } catch { /* ok */ }
}

// Abre o instalador do jeito normal do Windows (como um clique duplo), pra o aviso de permissão
// aparecer na frente. Não usa PowerShell nem script escondido: o antivírus costuma barrar isso.
//   • instalado: instala quietinho (/S) e o próprio instalador reabre o launcher (--force-run);
//   • portátil antigo: abre o instalador normal, com as telas.
// Só fecha o launcher se o instalador abriu de verdade. Senão devolve false e o launcher abre normal.
async function rodarInstaladorEFechar(setup, versao, avisar) {
  const mostrar = avisar || (() => {});
  let electron = null;
  try { electron = require('electron'); } catch { /* fora do .exe */ }
  if (process.platform === 'win32' && electron && electron.shell) {
    const { shell } = electron;
    let alvo = setup;
    if (INSTALADO) {
      // Atalho temporário com os parâmetros (o "abrir" do Windows não aceita parâmetros direto).
      const lnk = path.join(os.tmpdir(), 'TLW Games Launcher - atualizar.lnk');
      try {
        fs.rmSync(lnk, { force: true });
        if (shell.writeShortcutLink(lnk, 'create', { target: setup, args: '/S --updated --force-run', cwd: os.tmpdir() })) alvo = lnk;
        else logAtualizacao('não consegui criar o atalho temporário; abrindo o instalador com as telas');
      } catch (e) { logAtualizacao(`atalho temporário: ${e.message}`); }
    }
    logAtualizacao(`versão ${versao}: abrindo ${alvo === setup ? 'o instalador' : 'o instalador silencioso'} (${setup})`);
    mostrar(INSTALADO ? 'Instalando… (se o Windows pedir permissão, clique em Sim)' : 'Abrindo o instalador…', 1);
    let erro = '';
    try { erro = await shell.openPath(alvo); } catch (e) { erro = e.message || String(e); }
    if (erro) {
      logAtualizacao(`o instalador não abriu: ${erro}`);
      return false;
    }
    logAtualizacao('instalador aberto; fechando o launcher');
    if (INSTALADO) {
      mostrar('Instalando a versão nova… o launcher reabre sozinho', 1);
      try {
        if (casca) casca.notificar('Atualizando o TLW Games Launcher', 'Ele reabre sozinho em alguns segundos. Se não abrir em 1 minuto, abra pelo atalho.');
      } catch { /* ok */ }
    }
    await new Promise((r) => setTimeout(r, 1500));
  } else {
    // (só pra testar fora do Windows)
    spawn('sh', ['-c', 'sleep 1; chmod +x "$0"; "$0" "$@" &', setup, ...(INSTALADO ? ['/S', '--updated', '--force-run'] : [])],
      { detached: true, stdio: 'ignore' }).unref();
  }
  try { servidor.close(); } catch { /* ok */ }
  setTimeout(() => {
    try { require('electron').app.exit(0); } catch { process.exit(0); }
  }, 300);
  return true;
}

// Devolve true se achou versão nova (o launcher vai fechar e o instalador assume).
// mostrar(texto, fração de 0 a 1 ou null) atualiza a janelinha.
async function atualizarLauncher(mostrar) {
  if (!podeAtualizarLauncher()) return false;
  limparRestos();
  let info;
  try { info = await infoInstaladorPublicado(); } catch { return false; }
  if (!info || Number(info.versao) <= versaoDoExe()) return false;

  const avisar = mostrar || (() => {});
  const setup = path.join(os.tmpdir(), `TLW-Games-Launcher-Setup-${info.versao}.exe`);
  try {
    const pronto = fs.existsSync(setup) && (await hashArquivo(setup)) === info.sha256;
    if (!pronto) {
      avisar('Baixando o launcher novo…', 0);
      await baixarUm(info.url, setup, new AbortController().signal, (baixado, total) => {
        const mb = (n) => (n / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
        avisar(`Baixando o launcher novo… ${mb(baixado)} de ${mb(total || info.tamanho || baixado)} MB`, total ? baixado / total : null);
      });
      if ((await hashArquivo(setup)) !== info.sha256) throw new Error('arquivo diferente do publicado');
    }
  } catch {
    try { fs.rmSync(setup, { force: true }); } catch { /* ok */ }
    return false; // sem internet etc.: segue com o launcher atual
  }
  if (await rodarInstaladorEFechar(setup, info.versao, avisar)) return true;
  avisar('Não deu pra atualizar agora. Abrindo…', 1);
  await new Promise((r) => setTimeout(r, 1200));
  return false;
}

// Janelinha própria, usada só quando o launcher roda dentro de um .exe antigo
// (que ainda não tinha a janelinha de atualização).
function janelinhaPropria() {
  const { BrowserWindow } = require('electron');
  let ico = '';
  let icoArquivo = '';
  for (const p of [process.env.TLW_PASTA_EMBUTIDA, __dirname].filter(Boolean)) {
    try {
      icoArquivo = path.join(p, 'icone.png');
      ico = `data:image/png;base64,${fs.readFileSync(icoArquivo).toString('base64')}`;
      break;
    } catch { icoArquivo = ''; }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}html,body{height:100%;overflow:hidden;user-select:none;-webkit-app-region:drag}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:26px 30px;font:13px "Segoe UI",system-ui,sans-serif;color:#e9ebf1;
  border:1px solid #2a2f3d;background:radial-gradient(circle at 50% 0%,rgba(166,0,255,.22),transparent 60%),#0b0d12}
  img{width:74px;height:74px;object-fit:contain;filter:drop-shadow(0 6px 18px rgba(140,0,255,.45))}
  h1{font:900 15px "Segoe UI Black","Arial Black",sans-serif;letter-spacing:.14em;text-transform:uppercase}
  .txt{width:100%;display:flex;justify-content:space-between;gap:10px;color:#8a93a8;font-size:12px}#t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .trilho{width:100%;height:7px;border-radius:99px;background:#1e2330;overflow:hidden}
  #b{height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#4400ff,#a600ff);transition:width .2s}
  #b.indet{width:40%!important;animation:vai 1.1s ease-in-out infinite}@keyframes vai{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
  </style></head><body>${ico ? `<img src="${ico}">` : ''}<h1>TLW Games Launcher</h1>
  <div class="trilho"><div id="b" class="indet"></div></div><div class="txt"><span id="t">Atualizando o launcher…</span><span id="p"></span></div>
  <script>window.mostrar=(t,f)=>{document.getElementById('t').textContent=t;const b=document.getElementById('b');
  if(f==null){b.classList.add('indet');document.getElementById('p').textContent='';}
  else{b.classList.remove('indet');b.style.width=Math.round(f*100)+'%';document.getElementById('p').textContent=Math.round(f*100)+'%';}};</script></body></html>`;
  const w = new BrowserWindow({
    width: 380, height: 250, frame: false, resizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#0b0d12', center: true, alwaysOnTop: true, show: true, title: 'TLW Games Launcher',
    ...(icoArquivo ? { icon: icoArquivo } : {}),
  });
  w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  let ultimo = null;
  w.webContents.on('did-finish-load', () => { if (ultimo) w.webContents.executeJavaScript(ultimo).catch(() => {}); });
  const mostrar = (texto, fracao) => {
    if (w.isDestroyed()) return;
    ultimo = `window.mostrar && window.mostrar(${JSON.stringify(texto)}, ${fracao == null ? 'null' : Number(fracao)})`;
    w.webContents.executeJavaScript(ultimo).catch(() => {});
  };
  mostrar.fechar = () => { if (!w.isDestroyed()) w.destroy(); };
  return mostrar;
}

if (casca && casca.temGanchos) {
  // .exe novo: a casca chama isto antes de abrir a tela, usando a janelinha dela.
  global.tlwAntesDeAbrir = (mostrar) => atualizarLauncher(mostrar);
} else if (podeAtualizarLauncher()) {
  // .exe antigo: confere sozinho e, se tiver .exe novo, esconde a tela e mostra a nossa janelinha.
  (async () => {
    let janelinha = null;
    let escondidas = [];
    const oculto = process.argv.includes('--oculto');
    const atualizou = await atualizarLauncher((texto, fracao) => {
      if (!janelinha && !oculto) {
        try {
          escondidas = require('electron').BrowserWindow.getAllWindows().filter((w) => w.isVisible());
          escondidas.forEach((w) => w.hide());
        } catch { /* ok */ }
        janelinha = janelinhaPropria();
      }
      if (janelinha) janelinha(texto, fracao);
    }).catch(() => false);
    if (!atualizou && janelinha) {
      // Deu errado (internet caiu etc.): fecha a janelinha e volta pro launcher normal.
      janelinha.fechar();
      escondidas.forEach((w) => { if (!w.isDestroyed()) w.show(); });
    }
  })().catch(() => {});
}

// Quem já tinha jogos em Documentos\TLW Games (antes do instalador) continua com eles lá.
// Dá pra mudar pra pasta nova em Configurações → "Voltar pro padrão".
(() => {
  const cfg = lerConfig();
  if (cfg.pastaJogos || PASTA_PADRAO === PASTA_DOCUMENTOS) return;
  const temJogoLa = Object.keys(lerEstado()).some((id) => fs.existsSync(path.join(PASTA_DOCUMENTOS, nomePasta(id))));
  if (temJogoLa) salvarJSON(ARQ_CONFIG, { ...cfg, pastaJogos: PASTA_DOCUMENTOS });
})();
