'use strict';
// Test harness for the Keyturn red-team tests.
// - Runs a TEST instance of app/server.js on port 17457 with its own data folders under audit-tests/.runtime.
// - A tiny local relay stub stands in for keys.aiforge.uk (KEYTURN_RELAY=http://127.0.0.1:<port>).
// - The phone is simulated with WebCrypto, using the functions copied verbatim out of relay/public/app.js at run time.
// Never touches port 7457, %LOCALAPPDATA%\Keyturn, Documents\Keyturn or keys.aiforge.uk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const RUNTIME = path.join(__dirname, '.runtime');
const PORT = 17457;
const BASE = `http://127.0.0.1:${PORT}`;
if (PORT === 7457) throw new Error('refusing to touch the live port');

const K = require(path.join(APP, 'lib', 'kcrypto.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = K.b64u;

// ---------------- minimal WebSocket relay stub ----------------
function parseFrame(b) {
  if (b.length < 2) return null;
  const op = b[0] & 15; const masked = b[1] & 128; let len = b[1] & 127; let off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4; }
  if (b.length < off + len) return null;
  const p = Buffer.from(b.subarray(off, off + len));
  if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
  return { op, payload: p, size: off + len };
}
function frame(p, op = 1) {
  const n = p.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}

function startRelay() {
  const chans = new Map();
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, sock) => {
    const m = req.url.match(/^\/api\/ch\/([A-Za-z0-9_-]{22})\/ws$/);
    if (!m) return sock.destroy();
    const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    const ch = { id: m[1], sock, listeners: new Set(), closed: false, received: [] };
    chans.set(m[1], ch);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const f = parseFrame(buf); if (!f) break; buf = buf.subarray(f.size);
        if (f.op === 8) { ch.closed = true; try { sock.end(frame(Buffer.alloc(0), 8)); } catch { /* */ } break; }
        if (f.op === 9) { sock.write(frame(f.payload, 10)); continue; }
        if (f.op === 1) { const t = f.payload.toString('utf8'); ch.received.push(t); for (const l of [...ch.listeners]) l(t); }
      }
    });
    sock.on('close', () => { ch.closed = true; });
    sock.on('error', () => { ch.closed = true; });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const relay = {
      url: `http://127.0.0.1:${srv.address().port}`,
      chans,
      async waitChannel(id, ms = 5000) { const until = Date.now() + ms; while (Date.now() < until) { const c = chans.get(id); if (c && !c.closed) return c; await sleep(20); } throw new Error('PC never connected to channel ' + id); },
      inject(id, obj) { const c = chans.get(id); if (!c || c.closed) throw new Error('channel closed'); c.sock.write(frame(Buffer.from(JSON.stringify(obj)))); },
      // What the real worker does for a phone POST: forward {type:'payload'} and wait for the PC's {type:'result'}.
      async phonePost(id, sealed, ms = 25000) {
        const c = await relay.waitChannel(id);
        return new Promise((resolve) => {
          const t = setTimeout(() => { c.listeners.delete(on); resolve({ ok: false, message: 'timeout (relay stub)' }); }, ms);
          const on = (txt) => { let m; try { m = JSON.parse(txt); } catch { return; } if (m.type === 'result') { clearTimeout(t); c.listeners.delete(on); resolve(m); } };
          c.listeners.add(on);
          relay.inject(id, { type: 'payload', pub: sealed.pub, iv: sealed.iv, ct: sealed.ct });
        });
      },
      close() { for (const c of chans.values()) try { c.sock.destroy(); } catch { /* */ } srv.close(); },
    };
    resolve(relay);
  }));
}

// ---------------- the phone, reusing relay/public/app.js ----------------
function extractBlock(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
  }
  throw new Error('unbalanced');
}
function loadPhoneLib() {
  const src = fs.readFileSync(path.join(ROOT, 'relay', 'public', 'app.js'), 'utf8');
  const parts = [];
  const grab = (re, name) => { const m = src.match(re); if (!m) return false; parts.push(extractBlock(src, m.index) + (name === 'b64u' ? ';' : '')); return true; };
  grab(/const b64u = \{/, 'b64u');
  parts.push(src.match(/const te = new TextEncoder\(\);/)[0]);
  parts.push(src.match(/const rand = .*;/)[0]);
  const names = ['parse', 'matchCode', 'prepare', 'linkCode', 'seal'];
  const have = names.filter((n) => grab(new RegExp(`(async )?function ${n}\\(`), n));
  const body = `const location = L;\n${parts.join('\n')}\nreturn { ${have.join(', ')} };`;
  // eslint-disable-next-line no-new-func
  const factory = new Function('L', 'crypto', 'TextEncoder', 'btoa', 'atob', body);
  const L = { hash: '' };
  const lib = factory(L, globalThis.crypto, TextEncoder, btoa, atob);
  lib.parseUrl = (u) => { L.hash = new URL(u).hash; return lib.parse(); };
  return lib;
}
const PHONE = loadPhoneLib();

function newPhone(device = 'Pixel 9') { return { cred: b64u.enc(crypto.randomBytes(16)), prf: crypto.randomBytes(32), device }; }

// The code the phone page shows for this QR, and the sealed answer it sends (same ephemeral key for both).
async function phoneAnswer(url, phone, t) {
  const p = PHONE.parseUrl(url);
  if (!p) throw new Error('phone page could not read ' + url);
  let code;
  if (p.mode !== 'u' && PHONE.linkCode) { await PHONE.prepare(p); code = await PHONE.linkCode(p); } else code = await PHONE.matchCode(p);
  const payload = { t, cred: phone.cred, prf: b64u.enc(phone.prf) };
  if (t === 'enroll') payload.device = phone.device;
  const sealed = await PHONE.seal(p, payload);
  return { p, code, sealed };
}

// ---------------- the TEST service ----------------
async function startInstance(name, { relay, open = true, keep = false, extraEnv = {} } = {}) {
  const root = path.join(RUNTIME, name);
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data'); const local = path.join(root, 'local');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(local, { recursive: true });
  const env = { ...process.env, KEYTURN_PORT: String(PORT), KEYTURN_DATA: data, KEYTURN_LOCAL: local, KEYTURN_NO_WINDOW: '1', KEYTURN_RELAY: relay.url, KEYTURN_PC_NAME: 'AUDIT-PC', ...extraEnv };
  const child = spawn(process.execPath, [path.join(APP, 'server.js'), ...(open ? ['--open'] : [])], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const inst = { name, root, data, local, child, out: '', links: [], env, exited: false };
  const onOut = (d) => { inst.out += d.toString(); for (const m of d.toString().matchAll(/(http:\/\/127\.0\.0\.1:\d+\/#k=[A-Za-z0-9_-]+)/g)) inst.links.push(m[1]); };
  child.stdout.on('data', onOut); child.stderr.on('data', (d) => { inst.out += d.toString(); });
  child.on('exit', () => { inst.exited = true; });
  const until = Date.now() + 10000;
  while (!/Keyturn on http/.test(inst.out)) { if (inst.exited || Date.now() > until) throw new Error('server did not start:\n' + inst.out); await sleep(25); }
  await sleep(150);
  inst.stop = async () => { if (!inst.exited) { child.kill(); const u = Date.now() + 5000; while (!inst.exited && Date.now() < u) await sleep(20); } };
  inst.cliToken = () => fs.readFileSync(path.join(local, 'cli.token'), 'utf8').trim();
  return inst;
}

async function req(method, p, { token, cli, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h['x-keyturn-ui'] = token;
  if (cli) h['x-keyturn-cli'] = cli;
  const r = await fetch(BASE + p, { method, headers: h, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text, headers: r.headers };
}
// Raw request, so tests can send any Host / Origin header like a browser would.
function raw(method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
async function getState(token) {
  const ac = new AbortController();
  const r = await fetch(`${BASE}/api/events?t=${encodeURIComponent(token)}`, { signal: ac.signal });
  if (r.status !== 200) { ac.abort(); return null; }
  const reader = r.body.getReader(); let s = '';
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; s += Buffer.from(value).toString('utf8'); const i = s.indexOf('\n\n'); if (i >= 0) { s = s.slice(0, i); break; } }
  } finally { ac.abort(); }
  return JSON.parse(s.replace(/^data: /, ''));
}

// The owner's window gets its key. Fixed builds: one-time link printed in test mode. Original build: scrape GET /.
async function ownerToken(inst) {
  if (inst.links.length) {
    const k = new URL(inst.links.shift()).hash.replace(/^#k=/, '');
    const r = await req('POST', '/api/hello', { body: { k } });
    if (r.status !== 200) throw new Error('owner window could not get its key: ' + r.text);
    return r.json.token;
  }
  const r = await raw('GET', '/', { host: `127.0.0.1:${PORT}` });
  const m = r.text.match(/name="kt-token" content="([^"]+)"/);
  if (!m) throw new Error('no way to get the owner token');
  return m[1];
}

async function waitFor(fn, ms = 5000, step = 40) { const until = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) return v; await sleep(step); } }

async function ownerEnroll(inst, relay, token, phone) {
  const r = await req('POST', '/api/setup', { token }); if (r.status !== 200) throw new Error('setup: ' + r.text);
  const st = await getState(token);
  const a = await phoneAnswer(st.pending.url, phone, 'enroll');
  const res = await relay.phonePost(a.p.ch, a.sealed);
  if (!res.ok) throw new Error('enroll failed: ' + res.message);
  let s = await getState(token);
  if (s.pending && s.pending.status === 'confirm') {
    if (s.pending.code !== a.code) throw new Error('match codes differ in honest enroll');
    const c = await req('POST', '/api/link/confirm', { token }); if (c.status !== 200) throw new Error('confirm: ' + c.text);
    s = await getState(token);
  }
  const recovery = s.recovery;
  await req('POST', '/api/recovery/ack', { token });
  return { recovery };
}
async function ownerAddPhone(relay, token, phone) {
  await req('POST', '/api/addphone', { token });
  const st = await getState(token);
  const a = await phoneAnswer(st.pending.url, phone, 'enroll');
  const res = await relay.phonePost(a.p.ch, a.sealed);
  if (!res.ok) throw new Error('addphone failed: ' + res.message);
  const s = await getState(token);
  if (s.pending && s.pending.status === 'confirm') {
    if (s.pending.code !== a.code) throw new Error('match codes differ in honest add-phone');
    await req('POST', '/api/link/confirm', { token });
  }
}
async function ownerUnlock(relay, token, phone) {
  const r = await req('POST', '/api/unlock', { token }); if (r.status !== 200) throw new Error('unlock: ' + r.text);
  const st = await getState(token);
  const a = await phoneAnswer(st.pending.url, phone, 'unlock');
  return relay.phonePost(a.p.ch, a.sealed);
}

// What anyone holding a copy of keyturn.json can do with a phone's PRF output (or a recovery code).
// v2 phone boxes also need this PC's secret: pass the instance's local folder only to act as the owner on this PC.
function pcSecretOf(local) {
  const f = path.join(local, 'pc.secret');
  if (!fs.existsSync(f)) return null;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String((Get-Content -Raw -LiteralPath $env:KT_F).Trim()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')))"],
  { encoding: 'utf8', env: { ...process.env, KT_F: f } });
  return Buffer.from(out.trim(), 'base64');
}
function kFromPrf(cfgText, phone, local) {
  const cfg = JSON.parse(cfgText);
  const d = cfg.devices.find((x) => x.cred === phone.cred);
  if (!d) return null;
  try {
    if (d.v === 2) { const pcs = local && pcSecretOf(local); if (!pcs) return null; return K.openWith(K.phoneKey(phone.prf, pcs, cfg.vaultId), d.box, b64u.dec(phone.cred)); }
    return K.aesUnwrap(K.prfWrapKey(phone.prf, cfg.vaultId), d.box, b64u.dec(phone.cred));
  } catch { return null; }
}
async function kFromRecovery(cfgText, code) {
  const cfg = JSON.parse(cfgText);
  const rec = cfg.recovery;
  if (!rec) return null;
  try {
    if (rec.v === 2) return K.openWith(await K.recoveryKey(code, b64u.dec(rec.salt)), rec.box, Buffer.from('recovery'));
    return K.aesUnwrap(await K.recoveryWrapKey(code, b64u.dec(rec.salt)), rec.box, Buffer.from('recovery'));
  } catch { return null; }
}
async function openVaultFile(file, key) {
  const { Vault } = require(path.join(APP, 'lib', 'vault.js'));
  return Vault.open(file, key);
}

function ps(script) { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { encoding: 'utf8' }); }
const clipboard = {
  read: () => ps('$c=Get-Clipboard -Raw; if($c){[Console]::Out.Write($c)}').replace(/\r?\n$/, ''),
  formats: () => ps('Add-Type -AssemblyName System.Windows.Forms; ([Windows.Forms.Clipboard]::GetDataObject().GetFormats()) -join ","').trim().split(','),
  clear: () => ps('Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::Clear()'),
};

module.exports = { ROOT, APP, RUNTIME, PORT, BASE, K, b64u, sleep, startRelay, PHONE, newPhone, phoneAnswer, startInstance, req, raw, getState, ownerToken, waitFor, ownerEnroll, ownerAddPhone, ownerUnlock, kFromPrf, kFromRecovery, openVaultFile, clipboard };
