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
const { readSource, setUserEnv, writeDotenv, dotenvTarget, checkEnvName, setClipboard, getClipboard, pcSecret, recycle } = require('./lib/system');

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

// The window's key is never put inside a page. Each window Keyturn opens gets a one-time link (#k=...) that it
// trades for the key once. A second use of the same link means another program got there first.
let uiToken = K.token();
const cliToken = K.token(); // written to cli.token only once this copy is the one listening
const launches = new Map(); // one-time window links: code -> expiry
const usedLaunches = new Set();
let copied = null;          // fingerprint of the value Keyturn last put on the clipboard
const EXISTING_VAULT = `There is already a vault in ${DATA}, but its settings file (keyturn.json) is missing or damaged. Keyturn won’t replace your vault. Open it with your recovery code (“Lost your phone?”), or put keyturn.json back (keyturn.json.bak is the previous copy) and open Keyturn again.`;

let cfg = loadCfg();
let session = null;      // { K, vault, expiresAt, timer }
let pending = null;      // phone request in progress
let freshRecovery = null; // shown once in the app window
let request = null;      // the assistant asked for the vault to be opened
let recoveryTries = [];
const sseClients = new Set();
const sessionLog = [];

function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return null; } }
function saveCfg(scrub) {
  const tmp = CFG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  if (fs.existsSync(CFG)) fs.copyFileSync(CFG, CFG + '.bak');
  fs.renameSync(tmp, CFG);
  if (scrub) fs.copyFileSync(CFG, CFG + '.bak'); // the backup must not keep a phone or code that was just revoked
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
  if (pending && pending.kind !== 'unlock') cancelChannel(); // a phone link waiting for you dies with the session
  clearCopied();
  if (!session) return;
  clearTimeout(session.timer);
  try { cfg.summary = session.vault.summary(); saveCfg(); } catch { /* ignore */ }
  session.K.fill(0);
  session = null;
  log({ timer: 'system', assistant: 'assistant', tamper: 'system' }[reason] || 'you', reason === 'timer' ? 'Locked itself (time up)' : 'Locked');
}
function clearCopied() {
  const h = copied;
  copied = null;
  if (h) getClipboard().then((c) => (K.sha256(c.replace(/\r?\n$/, '')) === h ? setClipboard('') : null)).catch(() => { /* ignore */ });
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
  // Unlock: the code comes from the QR, so you can compare it before touching the sensor.
  // Linking a phone: the code comes from the phone that answered, and shows here only after it answers.
  const p = { kind, channel: c, salt, url, qr, code: kind === 'unlock' ? matchCode(c.id, c.pub) : null, answer: null, status: 'connecting', error: null, expiresAt: Date.now() + CHANNEL_MS };
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
    const link = p.kind !== 'unlock';
    let result;
    if (link && p.answer) result = { ok: false, message: 'Another phone already answered this code. Start again on your PC.' };
    else {
      p.status = 'verifying'; push();
      try { result = link ? takeLink(p, msg) : await handlePhone(p, msg); } catch (e) { result = { ok: false, message: e.expose ? e.message : 'Something went wrong on the PC.' }; if (!e.expose) console.error(e); }
    }
    try { ws.send(JSON.stringify({ type: 'result', ...result })); } catch { /* ignore */ }
    if (result.ok && !link) finishChannel(p, 'done');
    else if (!result.ok && pending === p && !p.answer) { p.status = 'phone'; p.error = result.message; push(); }
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

function readPhone(p, msg) {
  let data;
  try { data = K.openFromPhone(p.channel, msg); } catch { throw httpErr(400, 'That message could not be read.'); }
  if (K.b64u.dec(data.prf || '').length !== 32 || !K.b64u.dec(data.cred || '').length) throw httpErr(400, 'Your phone sent an incomplete answer.');
  return data;
}

// Linking a phone: take the first readable answer only, then wait for the owner to confirm the code on the PC.
function takeLink(p, msg) {
  const data = readPhone(p, msg);
  if (data.t !== 'enroll') throw httpErr(400, 'Wrong step.');
  if (p.kind === 'addphone' && cfg && cfg.devices.some((d) => d.cred === data.cred)) throw httpErr(409, 'This phone is already linked.');
  p.answer = data;
  p.code = K.linkCode(p.channel, msg);
  p.status = 'confirm';
  p.error = null;
  push();
  return { ok: true, message: 'Now check your PC', detail: 'confirm' };
}

async function confirmLink() {
  const p = pending;
  if (!p || p.status !== 'confirm' || !p.answer) throw httpErr(409, 'Nothing to confirm.');
  const data = p.answer;
  p.answer = null;
  const credId = K.b64u.dec(data.cred);
  const prf = K.b64u.dec(data.prf);
  try {
    if (p.kind === 'enroll') {
      if (cfg) throw httpErr(409, 'Already set up');
      if (fs.existsSync(VAULT)) throw httpErr(409, EXISTING_VAULT);
      const key = K.random(32);
      const vaultId = K.b64u.enc(K.random(16));
      const vault = await Vault.create(VAULT, key, 'Keyturn');
      const code = K.newRecoveryCode();
      const rec = await makeRecovery(code, key);
      vault.setRecovery(rec);
      await vault.save();
      cfg = {
        v: 2, product: 'Keyturn', vaultId, prfSalt: K.b64u.enc(p.salt), relay: RELAY, minutes: 15, created: new Date().toISOString(),
        devices: [await device(data, credId, prf, key, vaultId)],
        recovery: rec,
      };
      saveCfg();
      startSession(key, vault);
      freshRecovery = code;
      log('you', `Linked ${cfg.devices[0].name} and created the vault`);
    } else {
      if (!session) throw httpErr(423, 'The vault locked before you confirmed.');
      if (cfg.devices.some((d) => d.cred === data.cred)) throw httpErr(409, 'This phone is already linked.');
      const d = await device(data, credId, prf, session.K, cfg.vaultId);
      cfg.devices.push(d);
      saveCfg();
      log('you', `Linked another phone: ${d.name}`);
    }
  } catch (e) {
    if (pending === p) cancelChannel();
    throw e;
  } finally { prf.fill(0); }
  finishChannel(p, 'done');
}

async function handlePhone(p, msg) {
  const data = readPhone(p, msg);
  if (data.t !== 'unlock') throw httpErr(400, 'Wrong step.');
  const credId = K.b64u.dec(data.cred);
  const prf = K.b64u.dec(data.prf);
  const d = cfg.devices.find((x) => x.cred === data.cred);
  if (!d) throw httpErr(403, 'This passkey isn’t linked to this PC.');
  let key;
  let upgrade = false;
  try {
    if (d.v === 2) {
      const pcs = await secretOfPc(false);
      if (!pcs) throw httpErr(403, 'This PC no longer recognises your phone (its Keyturn secret is missing). Open Keyturn with your recovery code, then link your phone again.');
      key = K.openWith(K.phoneKey(prf, pcs, cfg.vaultId), d.box, credId);
    } else {
      key = K.aesUnwrap(K.prfWrapKey(prf, cfg.vaultId), d.box, credId);
      upgrade = true;
    }
  } catch (e) { prf.fill(0); throw e.expose ? e : httpErr(403, 'That key didn’t match.'); }
  let vault;
  try { vault = await Vault.open(VAULT, key); } catch (e) { key.fill(0); prf.fill(0); throw e; }
  if (pending !== p) { key.fill(0); prf.fill(0); throw httpErr(409, 'Cancelled on the PC.'); } // Cancel or Lock was pressed while this was being checked
  if (upgrade) {
    // First unlock since the update: re-seal this phone's box the new way (with this PC's secret).
    const nd = await device(data, credId, prf, key, cfg.vaultId);
    Object.assign(d, { v: 2, pub: nd.pub, box: nd.box });
    log('system', `Upgraded ${d.name} to the new lock`);
  }
  prf.fill(0);
  d.lastUsed = new Date().toISOString();
  startSession(key, vault);
  if (upgrade) saveCfg(true);
  log('you', `Unlocked with ${d.name}`);
  return { ok: true, message: 'Unlocked', detail: `for ${minutes()} minutes` };
}

let pcSecretCache = null;
async function secretOfPc(create) {
  if (!pcSecretCache) pcSecretCache = await pcSecret(path.join(LOCAL, 'pc.secret'), create);
  return pcSecretCache;
}

async function device(data, credId, prf, key, vaultId) {
  const pub = K.pubOf(K.phoneKey(prf, await secretOfPc(true), vaultId));
  return {
    id: K.b64u.enc(K.random(6)), name: String(data.device || 'Phone').slice(0, 30), cred: data.cred,
    created: new Date().toISOString(), lastUsed: null, v: 2, pub,
    box: K.sealTo(pub, key, credId),
  };
}

async function makeRecovery(code, key) {
  const salt = K.random(16);
  const pub = K.pubOf(await K.recoveryKey(code, salt));
  return { v: 2, salt: K.b64u.enc(salt), pub, box: K.sealTo(pub, key, Buffer.from('recovery')) };
}

// Opens the vault key with the paper code: from keyturn.json, or from the vault file's own header.
async function keyFromPaper(code) {
  const tries = [cfg && cfg.recovery, Vault.readRecovery(VAULT)].filter(Boolean);
  for (const rec of tries) {
    try {
      if (rec.v === 2) return { key: K.openWith(await K.recoveryKey(code, K.b64u.dec(rec.salt)), rec.box, Buffer.from('recovery')), rec };
      return { key: K.aesUnwrap(await K.recoveryWrapKey(code, K.b64u.dec(rec.salt)), rec.box, Buffer.from('recovery')), rec };
    } catch { /* wrong code, or this copy is older: try the next */ }
  }
  return null;
}

// New vault key, sealed again to every linked phone and the paper code. Old copies of keyturn.json (and of the
// vault) keep only the old key, so an unlinked phone or a replaced paper code no longer opens the current vault.
async function rekey({ newCode = false } = {}) {
  needOpen();
  const old = cfg.devices.filter((d) => d.v !== 2);
  if (old.length) throw httpErr(409, `Unlock once with ${old.map((d) => d.name).join(' and ')} first (that finishes its upgrade), or unlink it.`);
  if (!newCode && (!cfg.recovery || cfg.recovery.v !== 2)) throw httpErr(409, 'Check your recovery code once first: choose “Check my recovery code”.');
  const K2 = K.random(32);
  const code = newCode ? K.newRecoveryCode() : null;
  const rec = newCode ? await makeRecovery(code, K2) : { ...cfg.recovery, box: K.sealTo(cfg.recovery.pub, K2, Buffer.from('recovery')) };
  const devices = cfg.devices.map((d) => ({ ...d, box: K.sealTo(d.pub, K2, K.b64u.dec(d.cred)) }));
  session.vault.setKey(K2);
  session.vault.setRecovery(rec);
  await session.vault.save({ scrub: true }); // if Keyturn stopped right here, the paper code in the vault header still opens it
  cfg.recovery = rec;
  cfg.devices = devices;
  saveCfg(true);
  session.K.fill(0);
  session.K = K2;
  return code;
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
    devices: cfg ? cfg.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastUsed: d.lastUsed, upgraded: d.v === 2 })) : [],
    hasRecovery: !!(cfg && cfg.recovery),
    paperCheck: !!(cfg && cfg.recovery && cfg.recovery.v !== 2),       // old-style paper box: type the code once to upgrade it
    vaultOnly: !cfg && fs.existsSync(VAULT) && !!Vault.readRecovery(VAULT), // settings file lost: the paper code still opens the vault
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

    // A new window trades its one-time link for the window key
    if (p === '/api/hello' && req.method === 'POST') {
      const o = req.headers.origin;
      if (o && o !== `http://127.0.0.1:${PORT}` && o !== `http://localhost:${PORT}`) return send(res, 403, { error: 'Bad origin' });
      return send(res, 200, hello(String((await body(req)).k || '')));
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

function newLaunch() {
  const now = Date.now();
  for (const [k, t] of launches) if (t < now) launches.delete(k);
  const k = K.token();
  launches.set(k, now + 2 * 60000);
  return k;
}
function hello(k) {
  const exp = launches.get(k);
  if (exp && exp > Date.now()) {
    launches.delete(k);
    usedLaunches.add(k);
    if (usedLaunches.size > 50) usedLaunches.delete(usedLaunches.values().next().value);
    return { token: uiToken };
  }
  if (usedLaunches.has(k)) {
    // Someone used this window's link before the window did: shut every window out and lock.
    uiToken = K.token();
    for (const r of sseClients) { try { r.end(); } catch { /* ignore */ } }
    sseClients.clear();
    cancelChannel();
    lock('tamper');
    log('system', 'Another program on this PC used the Keyturn window’s link first. Keyturn locked itself and closed every window.');
    throw httpErr(409, 'Another program on this PC used this window’s link first, so Keyturn locked itself to be safe. Close this window and open Keyturn again from its icon.');
  }
  throw httpErr(403, 'This window link has expired. Open Keyturn from its desktop icon.');
}

function serveUi(res, p) {
  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8'); // no key in the page: see hello()
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
    case '/api/setup': if (cfg) throw httpErr(409, 'Already set up'); if (fs.existsSync(VAULT)) throw httpErr(409, EXISTING_VAULT); await startChannel('enroll'); return;
    case '/api/link/confirm': await confirmLink(); return;
    case '/api/ping': return { ok: true };
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
      if (!fs.existsSync(VAULT)) throw httpErr(409, 'There is no vault on this PC yet.');
      const found = await keyFromPaper(b.code);
      if (!found) throw httpErr(403, 'That code isn’t right. Check each group of four.');
      const vault = await Vault.open(VAULT, found.key);
      const hadPcSecret = fs.existsSync(path.join(LOCAL, 'pc.secret'));
      const notes = [];
      if (!cfg) {
        // keyturn.json was lost: rebuild it. Phones are linked again from inside the open vault.
        cfg = { v: 2, product: 'Keyturn', vaultId: K.b64u.enc(K.random(16)), prfSalt: K.b64u.enc(K.random(32)), relay: RELAY, minutes: 15, created: new Date().toISOString(), devices: [], recovery: found.rec };
        notes.push('Rebuilt the settings file from the vault');
      } else if (!hadPcSecret && cfg.devices.some((d) => d.v === 2)) {
        cfg.devices = cfg.devices.filter((d) => d.v !== 2); // sealed with a PC secret this PC doesn't have
        notes.push('This PC is new to Keyturn, so link your phone again');
      }
      if (found.rec.v !== 2 || cfg.recovery !== found.rec || !Vault.readRecovery(VAULT)) {
        // Bring the paper code's box up to date (new style, and in the vault header too).
        cfg.recovery = await makeRecovery(b.code, found.key);
        vault.setRecovery(cfg.recovery);
        await vault.save({ scrub: true });
      }
      saveCfg(true);
      startSession(found.key, vault);
      log('you', 'Unlocked with the recovery code');
      for (const n of notes) log('system', n);
      return;
    }
    case '/api/recovery/check': {
      // Type the paper code while open: proves it still works, and upgrades an old-style paper box.
      needOpen();
      const now = Date.now();
      recoveryTries = recoveryTries.filter((t) => now - t < 10 * 60000);
      if (recoveryTries.length >= 5) throw httpErr(429, 'Too many tries. Wait 10 minutes.');
      recoveryTries.push(now);
      const found = await keyFromPaper(b.code);
      if (!found || !K.same(found.key, session.K)) throw httpErr(403, 'That isn’t this vault’s recovery code. Check each group of four.');
      found.key.fill(0);
      if (cfg.recovery.v !== 2 || !Vault.readRecovery(VAULT)) {
        cfg.recovery = await makeRecovery(b.code, session.K);
        session.vault.setRecovery(cfg.recovery);
        await session.vault.save({ scrub: true });
        saveCfg(true);
        log('you', 'Checked the recovery code (and finished the upgrade)');
      } else log('you', 'Checked the recovery code: it works');
      return { ok: true };
    }
    case '/api/recovery/new': {
      needOpen();
      freshRecovery = await rekey({ newCode: true });
      log('you', 'Made a new recovery code. The old one no longer opens this vault, even from old backups');
      return;
    }
    case '/api/device/remove': {
      needOpen();
      const d = cfg.devices.find((x) => x.id === b.id);
      if (!d) throw httpErr(404, 'Not found');
      if (cfg.devices.length === 1 && !cfg.recovery) throw httpErr(409, 'This is your only way in.');
      const before = cfg.devices;
      cfg.devices = cfg.devices.filter((x) => x !== d);
      try { await rekey(); } catch (e) { cfg.devices = before; throw e; }
      log('you', `Unlinked ${d.name}. It no longer opens this vault, even from old backups`);
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
      copied = h;
      setTimeout(() => { if (copied === h) clearCopied(); }, 30000); // also cleared on lock
      return { ok: true, clearsIn: 30 };
    }
    default: throw httpErr(404, 'Not found');
  }
}

// ---------- assistant CLI: names only ----------
async function cli(req, cmd, b) {
  switch (cmd) {
    case 'status': return { setup: !!cfg, locked: !session, expiresAt: session && session.expiresAt, pending: pending && pending.status, request };
    case 'window': openWindow(); return { ok: true }; // the desktop icon, clicked while Keyturn is already running
    case 'open': {
      if (session) return { ok: true, message: 'Already open' };
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
    case 'take': {
      // Save a loose file (a downloaded key, a recovery-codes .txt) into the vault, then move the original to the
      // Recycle Bin. Only after the vault is saved. Files that programs read in place (.env, SSH keys) are refused.
      needOpen();
      if (!b.group || !b.title || !b.file) throw httpErr(400, 'group, title and file needed');
      const file = path.resolve(String(b.file));
      const base = path.basename(file).toLowerCase();
      const inSsh = file.toLowerCase().includes(`${path.sep}.ssh${path.sep}`);
      if (/^\.env(\.|$)/.test(base) || inSsh) throw httpErr(400, 'Programs read this file in place. Use add (keeps the file) instead of take.');
      for (const d of [DATA, LOCAL]) if (file.toLowerCase().startsWith(path.resolve(d).toLowerCase() + path.sep)) throw httpErr(400, "Not inside Keyturn's own folders");
      const src = await readSource(file);
      if (!src || !src.file) throw httpErr(404, 'File not found');
      const r = await session.vault.upsert({ group: b.group, title: b.title, value: src.value, file: src.file, source: src.label });
      await saveVault('assistant', r.created ? 'Saved' : 'Updated', [r.ref]);
      await recycle(file);
      log('assistant', 'Moved the original to the Recycle Bin', [path.basename(file)]);
      return { ...r, recycled: file };
    }
    case 'move': needOpen(); if (!session.vault.move(b.ref, b.group)) throw httpErr(404, 'Not found'); await saveVault('assistant', `Moved to ${b.group}`, [b.ref]); return { ok: true };
    case 'rename': needOpen(); if (!session.vault.rename(b.ref, b.title)) throw httpErr(404, 'Not found'); await saveVault('assistant', `Renamed to “${b.title}”`, [b.ref]); return { ok: true };
    case 'remove': needOpen(); if (!session.vault.remove(b.ref)) throw httpErr(404, 'Not found'); await saveVault('assistant', 'Moved to the recycle bin', [b.ref]); return { ok: true };
    case 'wire': {
      needOpen();
      const secret = session.vault.secretOf(b.ref);
      if (secret == null) throw httpErr(404, 'No single value to use for this key');
      const keyturnDirs = [DATA, LOCAL];
      try { checkEnvName(b.name); if (b.dotenv) dotenvTarget(b.dotenv, keyturnDirs); } catch (e) { throw httpErr(400, e.message); }
      let where;
      let label;
      if (b.dotenv) { await writeDotenv(b.dotenv, b.name, secret, keyturnDirs); where = `${b.dotenv} (${b.name})`; label = `${path.basename(path.dirname(b.dotenv))}${path.sep}${path.basename(b.dotenv)} (${b.name})`; }
      else { await setUserEnv(b.name, secret); where = `Windows setting ${b.name}`; label = where; }
      session.vault.markUsed(b.ref, where);
      await saveVault('assistant', `Put into ${label}`, [b.ref]);
      return { ok: true, where };
    }
    default: throw httpErr(404, 'Unknown command');
  }
}

function openWindow() {
  const url = `http://127.0.0.1:${PORT}/#k=${newLaunch()}`;
  if (process.env.KEYTURN_NO_WINDOW) { console.log(`Keyturn window link (test mode): ${url}`); return; }
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((f) => fs.existsSync(f));
  if (!edge) return;
  spawn(edge, [`--app=${url}`, `--user-data-dir=${path.join(LOCAL, 'window')}`, '--window-size=1180,820', '--no-first-run', '--no-default-browser-check', '--disable-sync'], { detached: true, stdio: 'ignore' }).unref();
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Keyturn is already running: ask it for a window (only it can make the window's one-time link).
    if (!process.argv.includes('--open')) process.exit(0);
    let t = '';
    try { t = fs.readFileSync(path.join(LOCAL, 'cli.token'), 'utf8').trim(); } catch { /* ignore */ }
    fetch(`http://127.0.0.1:${PORT}/api/cli/window`, { method: 'POST', headers: { 'x-keyturn-cli': t } }).catch(() => {}).finally(() => process.exit(0));
    return;
  }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(path.join(LOCAL, 'cli.token'), cliToken); // only now: a second launch must not replace the running copy's token
  console.log(`Keyturn on http://127.0.0.1:${PORT}  data=${DATA}  relay=${RELAY}`);
  if (process.argv.includes('--open')) openWindow();
});
module.exports = { server };
