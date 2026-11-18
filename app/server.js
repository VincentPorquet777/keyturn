'use strict';
// Keyturn local service. Listens on 127.0.0.1 only.
// - The app window (ui/) is what the owner uses: set up, unlock with phone, lock, copy, devices.
// - The CLI (keyturn.js) is what an assistant uses: names only, never values, and only while unlocked.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const K = require('./lib/kcrypto');
const { Vault } = require('./lib/vault');
const { readSource, setUserEnv, writeDotenv, setClipboard, getClipboard } = require('./lib/system');

const PORT = +process.env.KEYTURN_PORT || 7457;
const RELAY = (process.env.KEYTURN_RELAY || 'https://keys.aiforge.uk').replace(/\/$/, '');
const DATA = process.env.KEYTURN_DATA || path.join(os.homedir(), 'Documents', 'Keyturn');
const LOCAL = process.env.KEYTURN_LOCAL || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Keyturn');
const PC = (process.env.KEYTURN_PC_NAME || os.hostname()).slice(0, 40);
const CFG = path.join(DATA, 'keyturn.json');
const VAULT = path.join(DATA, 'vault.kdbx');
const ACTIVITY = path.join(DATA, 'activity.log');
const UI = path.join(__dirname, 'ui');
const CHANNEL_MS = 3 * 60 * 1000;

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LOCAL, { recursive: true });

const uiToken = K.token();
const cliToken = K.token();
fs.writeFileSync(path.join(LOCAL, 'cli.token'), cliToken);

let cfg = loadCfg();
let session = null;      // { K, vault, expiresAt, timer }
let pending = null;      // phone request in progress
let freshRecovery = null; // shown once in the app window
let request = null;      // the assistant asked for the vault to be opened
let recoveryTries = [];
const sseClients = new Set();
const sessionLog = [];

function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return null; } }
function saveCfg() {
  const tmp = CFG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  if (fs.existsSync(CFG)) fs.copyFileSync(CFG, CFG + '.bak');
  fs.renameSync(tmp, CFG);
}
const minutes = () => (cfg && cfg.minutes) || 15;

// ---------- activity ----------
function log(who, action, names = []) {
  const item = { time: new Date().toISOString(), who, action, names: [].concat(names).slice(0, 50) };
  sessionLog.unshift(item);
  sessionLog.length = Math.min(sessionLog.length, 200);
  try { fs.appendFileSync(ACTIVITY, JSON.stringify(item) + '\n'); } catch { /* ignore */ }
  push();
}

// ---------- session ----------
function startSession(key, vault) {
  if (session) clearTimeout(session.timer);
  session = { K: key, vault, expiresAt: Date.now() + minutes() * 60000, timer: null };
  arm();
  cfg.lastOpened = new Date().toISOString();
  cfg.summary = vault.summary();
  saveCfg();
  request = null;
}
function arm() {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => lock('timer'), Math.max(0, session.expiresAt - Date.now()));
}
function lock(reason) {
  if (!session) return;
  clearTimeout(session.timer);
  try { cfg.summary = session.vault.summary(); saveCfg(); } catch { /* ignore */ }
  session.K.fill(0);
  session = null;
  log(reason === 'timer' ? 'system' : reason === 'assistant' ? 'assistant' : 'you', reason === 'timer' ? 'Locked itself (time up)' : 'Locked');
}
async function saveVault(who, action, names) {
  await session.vault.save();
  cfg.summary = session.vault.summary();
  saveCfg();
  if (action) log(who, action, names);
}

// ---------- phone channel ----------
function matchCode(id, pub) {
  const h = require('crypto').createHash('sha256').update(id + '.' + pub).digest();
  return String(((h[0] << 8) | h[1]) % 10000).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1 $2');
}

async function startChannel(kind) {
  cancelChannel();
  if (kind === 'unlock' && !cfg) throw httpErr(409, 'Set up first');
  if (kind === 'addphone' && !session) throw httpErr(423, 'Unlock first');
  const c = K.newChannel();
  const salt = cfg ? K.b64u.dec(cfg.prfSalt) : K.random(32);
  const mode = kind === 'unlock' ? 'u' : 'e';
  const name = encodeURIComponent(PC).replace(/\./g, '%2E');
  const url = `${RELAY}/#v1.${mode}.${c.id}.${c.pub}.${K.b64u.enc(salt)}.${name}.${minutes()}`;
  const qr = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'Q', margin: 0, color: { dark: '#0C1016', light: '#0000' } });
  const p = { kind, channel: c, salt, url, qr, code: matchCode(c.id, c.pub), status: 'connecting', error: null, expiresAt: Date.now() + CHANNEL_MS };
  pending = p;
  p.timer = setTimeout(() => { if (pending === p) finishChannel(p, 'expired'); }, CHANNEL_MS);
  const ws = new WebSocket(RELAY.replace(/^http/, 'ws') + `/api/ch/${c.id}/ws`);
  p.ws = ws;
  ws.onopen = () => { if (pending === p) { p.status = 'waiting'; push(); } };
  ws.onerror = () => { if (pending === p && p.status === 'connecting') { p.status = 'offline'; p.error = 'Can’t reach keys.aiforge.uk. Check this PC is online.'; push(); } };
  ws.onclose = () => { if (pending === p && !['done', 'expired'].includes(p.status) && p.status !== 'offline') { p.status = 'offline'; p.error = 'Connection closed. Start again.'; push(); } };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (pending !== p) return;
    if (msg.type === 'hello') { if (p.status === 'waiting') { p.status = 'phone'; push(); } return; }
    if (msg.type !== 'payload') return;
    p.status = 'verifying'; push();
    let result;
    try { result = await handlePhone(p, msg); } catch (e) { result = { ok: false, message: e.expose ? e.message : 'Something went wrong on the PC.' }; if (!e.expose) console.error(e); }
    try { ws.send(JSON.stringify({ type: 'result', ...result })); } catch { /* ignore */ }
    if (result.ok) finishChannel(p, 'done');
    else { p.status = 'phone'; p.error = result.message; push(); }
  };
  push();
  return p;
}

function finishChannel(p, status) {
  clearTimeout(p.timer);
  p.status = status;
  setTimeout(() => { try { p.ws && p.ws.close(); } catch { /* ignore */ } }, 1500);
  if (pending === p) pending = status === 'done' ? null : p;
  push();
}
function cancelChannel() {
  if (!pending) return;
  clearTimeout(pending.timer);
  try { pending.ws && pending.ws.close(); } catch { /* ignore */ }
  pending = null;
  push();
}

async function handlePhone(p, msg) {
  let data;
  try { data = K.openFromPhone(p.channel, msg); } catch { throw httpErr(400, 'That message could not be read.'); }
  const credId = K.b64u.dec(data.cred || '');
  const prf = K.b64u.dec(data.prf || '');
  if (prf.length !== 32 || !credId.length) throw httpErr(400, 'Your phone sent an incomplete answer.');

  if (p.kind === 'enroll' && !cfg) {
    if (data.t !== 'enroll') throw httpErr(400, 'Wrong step.');
    const key = K.random(32);
    const vaultId = K.b64u.enc(K.random(16));
    const vault = await Vault.create(VAULT, key, 'Keyturn');
    const code = K.newRecoveryCode();
    const rsalt = K.random(16);
    cfg = {
      v: 1, product: 'Keyturn', vaultId, prfSalt: K.b64u.enc(p.salt), relay: RELAY, minutes: 15, created: new Date().toISOString(),
      devices: [device(data, credId, prf, key, vaultId)],
      recovery: { salt: K.b64u.enc(rsalt), box: K.aesWrap(await K.recoveryWrapKey(code, rsalt), key, Buffer.from('recovery')) },
    };
    saveCfg();
    startSession(key, vault);
    freshRecovery = code;
    log('you', `Linked ${cfg.devices[0].name} and created the vault`);
    return { ok: true, message: 'Linked', detail: '' };
  }
  if (p.kind === 'addphone') {
    if (!session) throw httpErr(423, 'The vault locked before the phone answered.');
    if (cfg.devices.some((d) => d.cred === data.cred)) throw httpErr(409, 'This phone is already linked.');
    const d = device(data, credId, prf, session.K, cfg.vaultId);
    cfg.devices.push(d);
    saveCfg();
    log('you', `Linked another phone: ${d.name}`);
    return { ok: true, message: 'Linked', detail: '' };
  }
  if (p.kind === 'unlock') {
    if (data.t !== 'unlock') throw httpErr(400, 'Wrong step.');
    const d = cfg.devices.find((x) => x.cred === data.cred);
    if (!d) throw httpErr(403, 'This passkey isn’t linked to this PC.');
    let key;
    try { key = K.aesUnwrap(K.prfWrapKey(prf, cfg.vaultId), d.box, credId); } catch { throw httpErr(403, 'That key didn’t match.'); }
    const vault = await Vault.open(VAULT, key);
    d.lastUsed = new Date().toISOString();
    startSession(key, vault);
    log('you', `Unlocked with ${d.name}`);
    return { ok: true, message: 'Unlocked', detail: `for ${minutes()} minutes` };
  }
  throw httpErr(400, 'Unknown request.');
}

function device(data, credId, prf, key, vaultId) {
  return {
    id: K.b64u.enc(K.random(6)), name: String(data.device || 'Phone').slice(0, 30), cred: data.cred,
    created: new Date().toISOString(), lastUsed: null,
    box: K.aesWrap(K.prfWrapKey(prf, vaultId), key, credId),
  };
}

// ---------- state for the app window ----------
function state() {
  return {
    pc: PC,
    setup: !!cfg,
    locked: !session,
    expiresAt: session ? session.expiresAt : null,
    minutes: minutes(),
    lastOpened: cfg && cfg.lastOpened,
    summary: session ? session.vault.summary() : (cfg && cfg.summary) || null,
    devices: cfg ? cfg.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastUsed: d.lastUsed })) : [],
    hasRecovery: !!(cfg && cfg.recovery),
    pending: pending && { kind: pending.kind, status: pending.status, error: pending.error, qr: pending.qr, url: pending.url, code: pending.code, expiresAt: pending.expiresAt },
    recovery: freshRecovery,
    request,
    entries: session ? session.vault.list() : [],
    log: sessionLog.slice(0, 60),
  };
}
let pushTimer = null;
function push() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const data = `data: ${JSON.stringify(state())}\n\n`;
    for (const res of sseClients) res.write(data);
  }, 30);
}

// ---------- HTTP ----------
function httpErr(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const okHost = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(httpErr(413, 'Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpErr(400, 'Bad JSON')); } });
  });
}
function needOpen() { if (!session) throw httpErr(423, 'Keyturn is locked. Ask the owner to unlock it with their phone.'); }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    if (!okHost(req.headers.host)) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === 'GET' && !p.startsWith('/api/')) return serveUi(res, p);

    // Assistant CLI
    if (p.startsWith('/api/cli/')) {
      if (req.headers['x-keyturn-cli'] !== cliToken) return send(res, 401, { error: 'Bad CLI token' });
      return send(res, 200, await cli(req, p.slice(9), req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams)));
    }

    // App window
    if (req.headers['x-keyturn-ui'] !== uiToken && !(p === '/api/events' && url.searchParams.get('t') === uiToken)) return send(res, 401, { error: 'Bad token' });
    if (req.method === 'POST') {
      const o = req.headers.origin;
      if (o && o !== `http://127.0.0.1:${PORT}` && o !== `http://localhost:${PORT}`) return send(res, 403, { error: 'Bad origin' });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(state())}\n\n`);
      sseClients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }
    const b = req.method === 'POST' ? await body(req) : {};
    return send(res, 200, (await ui(p, b)) || { ok: true });
  } catch (e) {
    if (!e.expose) console.error(e);
    send(res, e.status || 500, { error: e.expose ? e.message : 'Something went wrong' });
  }
});

function serveUi(res, p) {
  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8').replace('__TOKEN__', uiToken);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' });
    return res.end(html);
  }
  const f = path.normalize(path.join(UI, p));
  if (!f.startsWith(UI + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

async function ui(p, b) {
  switch (p) {
    case '/api/setup': if (cfg) throw httpErr(409, 'Already set up'); await startChannel('enroll'); return;
    case '/api/unlock': await startChannel('unlock'); return;
    case '/api/addphone': await startChannel('addphone'); return;
    case '/api/cancel': cancelChannel(); return;
    case '/api/lock': lock('you'); return;
    case '/api/extend': needOpen(); session.expiresAt = Math.min(session.expiresAt + 15 * 60000, Date.now() + 4 * 3600000); arm(); log('you', 'Added 15 minutes'); return;
    case '/api/dismiss-request': request = null; push(); return;
    case '/api/recovery/ack': freshRecovery = null; log('you', 'Saved the recovery code'); return;
    case '/api/recovery/unlock': {
      const now = Date.now();
      recoveryTries = recoveryTries.filter((t) => now - t < 10 * 60000);
      if (recoveryTries.length >= 5) throw httpErr(429, 'Too many tries. Wait 10 minutes.');
      recoveryTries.push(now);
      if (!cfg || !cfg.recovery) throw httpErr(409, 'No recovery code set');
      let key;
      try { key = K.aesUnwrap(await K.recoveryWrapKey(b.code, K.b64u.dec(cfg.recovery.salt)), cfg.recovery.box, Buffer.from('recovery')); } catch { throw httpErr(403, 'That code isn’t right. Check each group of four.'); }
      startSession(key, await Vault.open(VAULT, key));
      log('you', 'Unlocked with the recovery code');
      return;
    }
    case '/api/recovery/new': {
      needOpen();
      const code = K.newRecoveryCode();
      const rsalt = K.random(16);
      cfg.recovery = { salt: K.b64u.enc(rsalt), box: K.aesWrap(await K.recoveryWrapKey(code, rsalt), session.K, Buffer.from('recovery')) };
      saveCfg();
      freshRecovery = code;
      log('you', 'Made a new recovery code (the old one no longer works)');
      return;
    }
    case '/api/device/remove': {
      needOpen();
      const d = cfg.devices.find((x) => x.id === b.id);
      if (!d) throw httpErr(404, 'Not found');
      if (cfg.devices.length === 1 && !cfg.recovery) throw httpErr(409, 'This is your only way in.');
      cfg.devices = cfg.devices.filter((x) => x !== d);
      saveCfg();
      log('you', `Unlinked ${d.name}`);
      return;
    }
    case '/api/settings': {
      if (![5, 15, 30, 60].includes(+b.minutes)) throw httpErr(400, 'Choose 5, 15, 30 or 60');
      cfg.minutes = +b.minutes; saveCfg(); push(); return;
    }
    case '/api/copy': {
      needOpen();
      const secret = session.vault.secretOf(b.ref);
      if (secret == null) throw httpErr(404, 'Nothing to copy for this key');
      await setClipboard(secret);
      log('you', 'Copied', [b.ref]);
      const h = K.sha256(secret);
      setTimeout(async () => { try { if (K.sha256((await getClipboard()).replace(/\r?\n$/, '')) === h) await setClipboard(''); } catch { /* ignore */ } }, 30000);
      return { ok: true, clearsIn: 30 };
    }
    default: throw httpErr(404, 'Not found');
  }
}

// ---------- assistant CLI: names only ----------
async function cli(req, cmd, b) {
  switch (cmd) {
    case 'status': return { setup: !!cfg, locked: !session, expiresAt: session && session.expiresAt, pending: pending && pending.status, request };
    case 'open': {
      request = { reason: String(b.reason || 'Your assistant would like to sort your keys').slice(0, 140), at: new Date().toISOString() };
      if (cfg && !session && !pending) await startChannel('unlock');
      openWindow();
      log('assistant', `Asked to open the vault: ${request.reason}`);
      return { ok: true, message: 'Unlock window shown to the owner' };
    }
    case 'lock': needOpen(); lock('assistant'); return { ok: true };
    case 'list': needOpen(); return { entries: session.vault.list(), summary: session.vault.summary(), expiresAt: session.expiresAt };
    case 'dupes': {
      needOpen();
      const by = new Map();
      for (const f of session.vault.fingerprints()) for (const h of f.hashes) { if (!by.has(h)) by.set(h, new Set()); by.get(h).add(f.ref); }
      return { duplicates: [...by.values()].map((s) => [...s]).filter((g) => g.length > 1) };
    }
    case 'import': {
      needOpen();
      let items = b.items;
      if (b.manifest) items = JSON.parse(fs.readFileSync(b.manifest, 'utf8'));
      if (!Array.isArray(items)) throw httpErr(400, 'items or manifest needed');
      const out = { saved: [], skipped: [], failed: [] };
      for (const it of items) {
        const ref = `${it.group}/${it.title}`;
        try {
          const src = await readSource(it.source);
          if (!src) { out.skipped.push({ ref, why: 'not found' }); continue; }
          await session.vault.upsert({ group: it.group, title: it.title, value: src.value, file: src.file, source: src.label });
          out.saved.push(ref);
        } catch (e) { out.failed.push({ ref, why: e.message.slice(0, 120) }); }
      }
      await saveVault('assistant', `Saved ${out.saved.length} key${out.saved.length === 1 ? '' : 's'}${out.skipped.length ? `, ${out.skipped.length} not found` : ''}`, out.saved);
      return out;
    }
    case 'add': {
      needOpen();
      if (!b.group || !b.title || !b.source) throw httpErr(400, 'group, title and source needed');
      const src = await readSource(b.source);
      if (!src) throw httpErr(404, 'Source not found');
      const r = await session.vault.upsert({ group: b.group, title: b.title, value: src.value, file: src.file, source: src.label });
      await saveVault('assistant', r.created ? 'Saved' : 'Updated', [r.ref]);
      return r;
    }
    case 'move': needOpen(); if (!session.vault.move(b.ref, b.group)) throw httpErr(404, 'Not found'); await saveVault('assistant', `Moved to ${b.group}`, [b.ref]); return { ok: true };
    case 'rename': needOpen(); if (!session.vault.rename(b.ref, b.title)) throw httpErr(404, 'Not found'); await saveVault('assistant', `Renamed to “${b.title}”`, [b.ref]); return { ok: true };
    case 'remove': needOpen(); if (!session.vault.remove(b.ref)) throw httpErr(404, 'Not found'); await saveVault('assistant', 'Moved to the recycle bin', [b.ref]); return { ok: true };
    case 'wire': {
      needOpen();
      const secret = session.vault.secretOf(b.ref);
      if (secret == null) throw httpErr(404, 'No single value to use for this key');
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(b.name || '')) throw httpErr(400, 'Bad variable name');
      let where;
      let label;
      if (b.dotenv) { await writeDotenv(b.dotenv, b.name, secret); where = `${b.dotenv} (${b.name})`; label = `${path.basename(path.dirname(b.dotenv))}${path.sep}${path.basename(b.dotenv)} (${b.name})`; }
      else { await setUserEnv(b.name, secret); where = `Windows setting ${b.name}`; label = where; }
      session.vault.markUsed(b.ref, where);
      await saveVault('assistant', `Put into ${label}`, [b.ref]);
      return { ok: true, where };
    }
    default: throw httpErr(404, 'Unknown command');
  }
}

function openWindow() {
  if (process.env.KEYTURN_NO_WINDOW) return;
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((f) => fs.existsSync(f));
  if (!edge) return;
  spawn(edge, [`--app=http://127.0.0.1:${PORT}/`, `--user-data-dir=${path.join(LOCAL, 'window')}`, '--window-size=1180,820', '--no-first-run', '--no-default-browser-check', '--disable-sync'], { detached: true, stdio: 'ignore' }).unref();
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { if (process.argv.includes('--open')) openWindow(); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Keyturn on http://127.0.0.1:${PORT}  data=${DATA}  relay=${RELAY}`);
  if (process.argv.includes('--open')) openWindow();
});
module.exports = { server };
