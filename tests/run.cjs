'use strict';
// Keyturn red-team tests. Usage: node audit-tests/run.cjs <label> [test ids...]
// "secure" tests assert the safe behaviour: PASS = safe, FAIL = vulnerable.
// "limit" tests demonstrate a known limitation that cannot be fixed in code; DEMONSTRATED = still true.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const H = require('./harness.cjs');
const { req, raw, getState, sleep } = H;

const SECRET = 'sk-audit-FAKE-' + crypto.randomBytes(8).toString('hex');
const HOST = { host: `127.0.0.1:${H.PORT}` };

let tracked = [];
async function start(name, relay, opts) { const i = await H.startInstance(name, { relay, ...opts }); tracked.push(i); return i; }
async function openVault(name, relay, opts = {}) {
  const inst = await start(name, relay, opts);
  const token = await H.ownerToken(inst);
  const owner = H.newPhone('Owner Pixel');
  const { recovery } = await H.ownerEnroll(inst, relay, token, owner);
  const cli = inst.cliToken();
  const src = path.join(inst.root, 'src'); fs.mkdirSync(src, { recursive: true });
  const f = path.join(src, 'openai.txt'); fs.writeFileSync(f, SECRET);
  const r = await req('POST', '/api/cli/add', { cli, body: { group: 'AI', title: 'OpenAI', source: f } });
  if (r.status !== 200) throw new Error('add: ' + r.text);
  return { inst, token, owner, recovery, cli, src, cfgFile: path.join(inst.data, 'keyturn.json'), vaultFile: path.join(inst.data, 'vault.kdbx') };
}
const stolenTokenFrom = (html) => { const m = html.match(/name="kt-token" content="([^"]+)"/); return m && m[1] !== '__TOKEN__' ? m[1] : null; };
async function secretFrom(vaultFile, key) { try { const v = await H.openVaultFile(vaultFile, key); return v.secretOf('AI/OpenAI'); } catch { return null; } }

const TESTS = [
  {
    id: 'F1', kind: 'secure', title: 'Any local program (or another Windows user) gets the window key from GET / and takes the vault',
    async run(relay) {
      const v = await openVault('f1', relay);
      const page = await raw('GET', '/', HOST);
      const stolen = stolenTokenFrom(page.text);
      const hello = await req('POST', '/api/hello', { body: {} });
      if (!stolen) return { ok: true, detail: `GET / carries no key (status ${page.status}); /api/hello without a one-time code -> ${hello.status}` };
      const st = await getState(stolen);
      if (!st) return { ok: true, detail: 'token in page but rejected' };
      const steps = [];
      const c = await req('POST', '/api/copy', { token: stolen, body: { ref: 'AI/OpenAI' } });
      if (c.status === 200) { await sleep(200); steps.push(H.clipboard.read() === SECRET ? 'copied AI/OpenAI and read the value back from the clipboard' : 'copy accepted'); }
      await req('POST', '/api/recovery/new', { token: stolen });
      const minted = (await getState(stolen)).recovery;
      if (minted) steps.push('made a new recovery code and read it from the event stream');
      await req('POST', '/api/recovery/ack', { token: stolen });
      await req('POST', '/api/lock', { token: stolen });
      const u = await req('POST', '/api/recovery/unlock', { token: stolen, body: { code: minted } });
      if (u.status === 200) steps.push('locked, then re-opened the vault with that code (no phone)');
      await req('POST', '/api/lock', { token: stolen });
      const o = await req('POST', '/api/recovery/unlock', { token: stolen, body: { code: v.recovery } });
      if (o.status === 403) steps.push("the owner's paper code no longer works");
      H.clipboard.clear();
      return { ok: false, detail: steps.join('; ') };
    },
  },
  {
    id: 'F1b', kind: 'secure', title: 'One-time window link: a program that grabs it first is detected and shut out',
    async run(relay) {
      const v = await openVault('f1b', relay);
      const r = await req('POST', '/api/cli/window', { cli: v.cli });
      await sleep(200);
      if (r.status !== 200 || !v.inst.links.length) return { na: true, detail: 'this build has no one-time window link' };
      const k = new URL(v.inst.links.shift()).hash.replace('#k=', '');
      const atk = await req('POST', '/api/hello', { body: { k } });
      const win = await req('POST', '/api/hello', { body: { k } });
      const atkAfter = atk.json && atk.json.token ? await req('GET', '/api/ping', { token: atk.json.token }) : { status: 0 };
      const ownerAfter = await req('GET', '/api/ping', { token: v.token });
      const status = await req('GET', '/api/cli/status', { cli: v.cli });
      const ok = win.status === 409 && atkAfter.status === 401 && ownerAfter.status === 401 && status.json.locked === true;
      return { ok, detail: `attacker redeemed first (${atk.status}); real window then got ${win.status}; attacker key now ${atkAfter.status}; vault locked: ${status.json.locked}` };
    },
  },
  {
    id: 'F2', kind: 'secure', title: 'Someone who sees the "Link another phone" QR links their own passkey; match code cannot tell',
    async run(relay) {
      const v = await openVault('f2', relay);
      await req('POST', '/api/addphone', { token: v.token });
      const st = await getState(v.token);
      const url = st.pending.url;
      const atk = H.newPhone('iPhone');
      const ownerNew = H.newPhone('Owner iPhone');
      const ownerView = await H.phoneAnswer(url, ownerNew, 'enroll');
      const a = await H.phoneAnswer(url, atk, 'enroll');
      await H.relayPost(relay, a);
      const st2 = await getState(v.token);
      const linkedNow = st2.devices.length > 1;
      const pcCode = st2.pending && st2.pending.code ? st2.pending.code : st.pending.code;
      const ownerRes = await relay.phonePost(ownerView.p.ch, ownerView.sealed, 2500).catch(() => ({ ok: false }));
      const noticed = pcCode !== ownerView.code;
      if (st2.pending && st2.pending.status === 'confirm') await req('POST', noticed ? '/api/cancel' : '/api/link/confirm', { token: v.token });
      await req('POST', '/api/lock', { token: v.token });
      const ur = await H.ownerUnlock(relay, v.token, atk);
      const unlocked = ur.ok && !(await getState(v.token)).locked;
      const kAtk = H.kFromPrf(fs.readFileSync(v.cfgFile, 'utf8'), atk);
      return {
        ok: !linkedNow && noticed && !unlocked && !kAtk,
        detail: `attacker linked at once as "iPhone": ${linkedNow}; codes PC=${pcCode} ownerPhone=${ownerView.code} attackerPhone=${a.code}; owner's phone then got: ${ownerRes.message || ownerRes.ok}; attacker later unlocked with its own passkey: ${unlocked}; attacker passkey + keyturn.json -> vault key: ${!!kAtk}`,
      };
    },
  },
  {
    id: 'F2b', kind: 'secure', title: 'Someone who sees the first set-up QR becomes the vault\'s phone',
    async run(relay) {
      const inst = await start('f2b', relay);
      const token = await H.ownerToken(inst);
      await req('POST', '/api/setup', { token });
      const st = await getState(token);
      const atk = H.newPhone('Pixel 9');
      const owner = H.newPhone('Owner Pixel');
      const ownerView = await H.phoneAnswer(st.pending.url, owner, 'enroll');
      const a = await H.phoneAnswer(st.pending.url, atk, 'enroll');
      await H.relayPost(relay, a);
      const st2 = await getState(token);
      const setupWithoutConfirm = st2.setup;
      const pcCode = st2.pending && st2.pending.code ? st2.pending.code : st.pending.code;
      const noticed = pcCode !== ownerView.code;
      if (st2.pending && st2.pending.status === 'confirm') {
        await req('POST', noticed ? '/api/cancel' : '/api/link/confirm', { token });
        if (noticed) await H.ownerEnroll(inst, relay, token, owner); // owner starts again and links their own phone
      } else await req('POST', '/api/recovery/ack', { token });
      await req('POST', '/api/lock', { token });
      const ur = await H.ownerUnlock(relay, token, atk);
      const unlocked = ur.ok && !(await getState(token)).locked;
      return { ok: !setupWithoutConfirm && noticed && !unlocked, detail: `vault created for the attacker's passkey without a check: ${setupWithoutConfirm}; codes PC=${pcCode} ownerPhone=${ownerView.code}; attacker can unlock later: ${unlocked}` };
    },
  },
  {
    id: 'F2c', kind: 'secure', title: 'Hostile relay delivers two "add phone" answers at once: both get linked',
    async run(relay) {
      const v = await openVault('f2c', relay);
      await req('POST', '/api/addphone', { token: v.token });
      const st = await getState(v.token);
      const a1 = await H.phoneAnswer(st.pending.url, H.newPhone('Evil 1'), 'enroll');
      const a2 = await H.phoneAnswer(st.pending.url, H.newPhone('Evil 2'), 'enroll');
      await relay.waitChannel(a1.p.ch);
      relay.inject(a1.p.ch, { type: 'payload', ...a1.sealed });
      relay.inject(a1.p.ch, { type: 'payload', ...a2.sealed });
      await sleep(600);
      const s = await getState(v.token);
      return { ok: s.devices.length === 1, detail: `phones linked without the owner confirming: ${s.devices.length - 1}` };
    },
  },
  {
    id: 'F3', kind: 'secure', title: 'Assistant tool: wire --dotenv writes a value into any file (or Keyturn\'s own folder)',
    async run(relay) {
      const v = await openVault('f3', relay);
      const notes = path.join(v.inst.root, 'notes.txt');
      const settings = path.join(v.inst.root, 'settings.json'); fs.writeFileSync(settings, '{"theme":"dark"}\n');
      const own = path.join(v.inst.data, '.env');
      const r = [];
      for (const f of [notes, settings, own]) r.push(await req('POST', '/api/cli/wire', { cli: v.cli, body: { ref: 'AI/OpenAI', name: 'OPENAI_API_KEY', dotenv: f } }));
      const leaked = [notes, settings, own].filter((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(SECRET)).map((f) => path.basename(f));
      return { ok: leaked.length === 0, detail: `statuses ${r.map((x) => x.status).join('/')}; value written into: ${leaked.join(', ') || 'nothing'}` };
    },
  },
  {
    id: 'F3b', kind: 'secure', title: '.env target check rejects network paths, non-.env names and Keyturn folders',
    async run() {
      const sys = require(path.join(H.APP, 'lib', 'system.js'));
      if (!sys.dotenvTarget) return { na: true, detail: 'no path check in this build' };
      const okDir = path.join(H.RUNTIME, 'f3b', 'proj'); fs.mkdirSync(okDir, { recursive: true });
      const forbid = [path.join(H.RUNTIME, 'f3b')];
      const bad = ['\\\\attacker.example\\share\\.env', '\\\\?\\C:\\tmp\\.env', '//attacker.example/share/.env', path.join(okDir, 'notes.txt'), path.join(okDir, '.envrc'), path.join(H.RUNTIME, 'f3b', '.env')];
      const res = bad.map((f) => { try { sys.dotenvTarget(f, forbid); return f + ' ACCEPTED'; } catch { return null; } }).filter(Boolean);
      let good = false; try { good = !!sys.dotenvTarget(path.join(okDir, '.env.local'), []); } catch { /* */ }
      return { ok: !res.length && good, detail: res.length ? res.join('; ') : 'all bad targets refused; proj/.env.local allowed' };
    },
  },
  {
    id: 'F3c', kind: 'secure', title: 'wire refuses to overwrite system variables like PATH',
    async run() {
      const sys = require(path.join(H.APP, 'lib', 'system.js'));
      if (!sys.checkEnvName) return { na: true, detail: 'no name check in this build (not run live: it would overwrite the real PATH)' };
      const bad = ['PATH', 'Path', 'TEMP', 'NODE_OPTIONS', 'COMSPEC'].filter((n) => { try { sys.checkEnvName(n); return true; } catch { return false; } });
      let good = false; try { sys.checkEnvName('OPENAI_API_KEY'); good = true; } catch { /* */ }
      return { ok: !bad.length && good, detail: bad.length ? 'accepted: ' + bad.join(',') : 'system names refused' };
    },
  },
  {
    id: 'F4', kind: 'secure', title: 'Unlinked phone + keyturn.json.bak still opens the vault (until the next lock; forever if the PC shuts down first)',
    async run(relay) {
      const v = await openVault('f4', relay);
      const B = H.newPhone('Old phone');
      await H.ownerAddPhone(relay, v.token, B);
      const st = await getState(v.token);
      const dB = st.devices.find((d) => d.name === 'Old phone');
      await req('POST', '/api/device/remove', { token: v.token, body: { id: dB.id } });
      await v.inst.stop(); // PC switched off / service killed before the vault locked
      let hit = null;
      for (const f of fs.readdirSync(v.inst.data).filter((x) => x.startsWith('keyturn.json'))) {
        const k = H.kFromPrf(fs.readFileSync(path.join(v.inst.data, f), 'utf8'), B);
        if (k) hit = `${f} -> ${await secretFrom(v.vaultFile, k) === SECRET ? 'AI/OpenAI value' : 'key'}`;
      }
      return { ok: !hit, detail: `files left in the Keyturn folder that still open the vault for the unlinked phone: ${hit || 'none'}` };
    },
  },
  {
    id: 'F4b', kind: 'secure', title: '"The old recovery code no longer works" is false while keyturn.json.bak holds it',
    async run(relay) {
      const v = await openVault('f4b', relay);
      await req('POST', '/api/recovery/new', { token: v.token });
      await req('POST', '/api/recovery/ack', { token: v.token });
      await v.inst.stop();
      let hit = null;
      for (const f of fs.readdirSync(v.inst.data).filter((x) => x.startsWith('keyturn.json'))) {
        const k = await H.kFromRecovery(fs.readFileSync(path.join(v.inst.data, f), 'utf8'), v.recovery);
        if (k) hit = `${f} -> ${await secretFrom(v.vaultFile, k) === SECRET ? 'AI/OpenAI value' : 'key'}`;
      }
      return { ok: !hit, detail: `old code opens the vault via: ${hit || 'nothing in the Keyturn folder'}` };
    },
  },
  {
    id: 'F4c', kind: 'limit', title: 'An older copy of keyturn.json (backup, OneDrive history) + unlinked phone or old code still opens today\'s vault',
    async run(relay) {
      const v = await openVault('f4c', relay);
      const B = H.newPhone('Old phone');
      await H.ownerAddPhone(relay, v.token, B);
      const oldCopy = fs.readFileSync(v.cfgFile, 'utf8');
      const st = await getState(v.token);
      await req('POST', '/api/device/remove', { token: v.token, body: { id: st.devices.find((d) => d.name === 'Old phone').id } });
      await req('POST', '/api/recovery/new', { token: v.token }); await req('POST', '/api/recovery/ack', { token: v.token });
      await req('POST', '/api/lock', { token: v.token });
      const k1 = H.kFromPrf(oldCopy, B); const k2 = await H.kFromRecovery(oldCopy, v.recovery);
      const s1 = k1 && await secretFrom(v.vaultFile, k1); const s2 = k2 && await secretFrom(v.vaultFile, k2);
      return { ok: s1 === SECRET && s2 === SECRET, detail: `old copy + unlinked phone -> ${s1 ? 'value' : 'no'}; old copy + replaced code -> ${s2 ? 'value' : 'no'} (the vault key never changes)` };
    },
  },
  {
    id: 'F5', kind: 'secure', title: 'Damaged/missing keyturn.json -> "Set up" overwrites the existing vault',
    async run(relay) {
      const v = await openVault('f5', relay);
      await req('POST', '/api/lock', { token: v.token });
      await v.inst.stop();
      const before = fs.readFileSync(v.vaultFile);
      fs.writeFileSync(v.cfgFile, '{ "v": 1, "devices": [ broken');
      const inst = await start('f5', relay, { keep: true });
      const token = await H.ownerToken(inst);
      const r = await req('POST', '/api/setup', { token });
      if (r.status === 200) {
        const st = await getState(token);
        const a = await H.phoneAnswer(st.pending.url, v.owner, 'enroll');
        await relay.phonePost(a.p.ch, a.sealed);
        const s = await getState(token);
        if (s.pending && s.pending.status === 'confirm') await req('POST', '/api/link/confirm', { token });
      }
      const replaced = !fs.readFileSync(v.vaultFile).equals(before);
      return { ok: r.status !== 200 && !replaced, detail: `set-up allowed: ${r.status === 200}${r.status !== 200 ? ` (${r.json && r.json.error})` : ''}; vault.kdbx replaced by an empty one: ${replaced}` };
    },
  },
  {
    id: 'F5b', kind: 'limit', title: 'The paper code is useless without keyturn.json (its wrapped key lives only there)',
    async run(relay) {
      const v = await openVault('f5b', relay);
      await req('POST', '/api/lock', { token: v.token });
      await v.inst.stop();
      for (const f of fs.readdirSync(v.inst.data).filter((x) => x.startsWith('keyturn.json'))) fs.rmSync(path.join(v.inst.data, f));
      const inst = await start('f5b', relay, { keep: true });
      const token = await H.ownerToken(inst);
      const r = await req('POST', '/api/recovery/unlock', { token, body: { code: v.recovery } });
      return { ok: r.status !== 200, detail: `recovery with the right paper code and vault.kdbx present -> ${r.status} ${r.json && r.json.error}` };
    },
  },
  {
    id: 'F6', kind: 'secure', title: 'Pressing Cancel while the phone answer is being checked still opens the vault',
    async run(relay) {
      const v = await openVault('f6', relay);
      await req('POST', '/api/lock', { token: v.token });
      const kdbxweb = require(path.join(H.APP, 'node_modules', 'kdbxweb'));
      const key = H.kFromPrf(fs.readFileSync(v.cfgFile, 'utf8'), v.owner);
      const vault = await H.openVaultFile(v.vaultFile, key);
      const T = kdbxweb.VarDictionary.ValueType;
      vault.db.header.kdfParameters.set('M', T.UInt64, kdbxweb.Int64.from(64 * 1024 * 1024));
      vault.db.header.kdfParameters.set('I', T.UInt64, kdbxweb.Int64.from(12));
      await vault.save();
      const t0 = Date.now(); await H.openVaultFile(v.vaultFile, key); const openMs = Date.now() - t0;
      await req('POST', '/api/unlock', { token: v.token });
      const st = await getState(v.token);
      const a = await H.phoneAnswer(st.pending.url, v.owner, 'unlock');
      await relay.waitChannel(a.p.ch);
      relay.inject(a.p.ch, { type: 'payload', ...a.sealed });
      await sleep(Math.min(150, openMs / 4));
      const c = await req('POST', '/api/cancel', { token: v.token });
      await sleep(openMs * 2 + 500);
      const s = await getState(v.token);
      return { ok: s.locked, detail: `vault open took ~${openMs} ms; Cancel -> ${c.status}; vault ended up ${s.locked ? 'locked' : 'OPEN'}` };
    },
  },
  {
    id: 'F7', kind: 'secure', title: 'Clipboard: copied value goes into Windows clipboard history/cloud and survives "Lock now"',
    async run(relay) {
      const v = await openVault('f7', relay);
      await req('POST', '/api/copy', { token: v.token, body: { ref: 'AI/OpenAI' } });
      await sleep(300);
      const val = H.clipboard.read(); const fm = H.clipboard.formats();
      const excluded = fm.includes('ExcludeClipboardContentFromMonitorProcessing') && fm.includes('CanIncludeInClipboardHistory') && fm.includes('CanUploadToCloudClipboard');
      await req('POST', '/api/lock', { token: v.token });
      await sleep(2000);
      const after = H.clipboard.read();
      H.clipboard.clear();
      return { ok: val === SECRET && excluded && after !== SECRET, detail: `copied ok: ${val === SECRET}; kept out of clipboard history/cloud: ${excluded}; still on clipboard after Lock: ${after === SECRET}` };
    },
  },
  {
    id: 'F8', kind: 'secure', title: 'Assistant overwrites a key\'s value and the old value is gone (no KeePass history)',
    async run(relay) {
      const v = await openVault('f8', relay);
      const f = path.join(v.src, 'new.txt'); fs.writeFileSync(f, 'sk-attacker-chosen-value');
      const r = await req('POST', '/api/cli/add', { cli: v.cli, body: { group: 'AI', title: 'OpenAI', source: f } });
      await req('POST', '/api/lock', { token: v.token });
      const key = H.kFromPrf(fs.readFileSync(v.cfgFile, 'utf8'), v.owner);
      const vault = await H.openVaultFile(v.vaultFile, key);
      const e = vault.find('AI/OpenAI').entry;
      const hist = e.history.map((h) => { const p = h.fields.get('Password'); return p && (p.getText ? p.getText() : String(p)); });
      return { ok: hist.includes(SECRET), detail: `overwrite ${r.json && r.json.created === false ? 'accepted' : r.status}; current value replaced: ${vault.secretOf('AI/OpenAI') !== SECRET}; old value kept in history: ${hist.includes(SECRET)}` };
    },
  },
  {
    id: 'F9', kind: 'secure', title: 'Malicious web page: DNS rebinding, cross-origin POST, CORS preflight, framing',
    async run(relay) {
      const v = await openVault('f9', relay);
      const a = await raw('GET', '/', { host: `evil.example:${H.PORT}` });
      const b = await raw('GET', `/api/events?t=${v.token}`, { host: `rebind.evil.example:${H.PORT}` });
      const c = await raw('POST', '/api/lock', { ...HOST, origin: 'https://evil.example', 'x-keyturn-ui': v.token, 'content-type': 'application/json' }, '{}');
      const d = await raw('OPTIONS', '/api/copy', { ...HOST, origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-keyturn-ui,content-type' });
      const e = await raw('GET', '/', HOST);
      const ok = a.status === 403 && b.status === 403 && c.status === 403 && !d.headers['access-control-allow-origin'] && !e.headers['access-control-allow-origin'] && e.headers['x-frame-options'] === 'DENY';
      return { ok, detail: `rebinding GET / ${a.status}, rebinding SSE ${b.status}, cross-origin POST ${c.status}, preflight ACAO ${d.headers['access-control-allow-origin'] || 'none'}, XFO ${e.headers['x-frame-options']}` };
    },
  },
  {
    id: 'F10', kind: 'secure', title: 'Relay replays a captured unlock answer into a later unlock',
    async run(relay) {
      const v = await openVault('f10', relay);
      await req('POST', '/api/lock', { token: v.token });
      await req('POST', '/api/unlock', { token: v.token });
      const st = await getState(v.token);
      const a = await H.phoneAnswer(st.pending.url, v.owner, 'unlock');
      const first = await relay.phonePost(a.p.ch, a.sealed);
      await req('POST', '/api/lock', { token: v.token });
      await req('POST', '/api/unlock', { token: v.token });
      const st2 = await getState(v.token);
      const p2 = H.PHONE.parseUrl(st2.pending.url);
      const replay = await relay.phonePost(p2.ch, a.sealed, 3000);
      const s = await getState(v.token);
      return { ok: first.ok && !replay.ok && s.locked, detail: `genuine unlock ${first.ok}; replay into new channel -> ${replay.message}; vault ${s.locked ? 'locked' : 'OPEN'}` };
    },
  },
  {
    id: 'F11', kind: 'secure', title: 'QR viewer answers an unlock QR without the real passkey',
    async run(relay) {
      const v = await openVault('f11', relay);
      await req('POST', '/api/lock', { token: v.token });
      await req('POST', '/api/unlock', { token: v.token });
      const st = await getState(v.token);
      const fake = { cred: v.owner.cred, prf: crypto.randomBytes(32), device: 'x' };
      const a = await H.phoneAnswer(st.pending.url, fake, 'unlock');
      const r = await relay.phonePost(a.p.ch, a.sealed, 5000);
      const s = await getState(v.token);
      return { ok: !r.ok && s.locked, detail: `answer -> ${r.message}; vault ${s.locked ? 'locked' : 'OPEN'}` };
    },
  },
  {
    id: 'F12', kind: 'limit', title: 'Assistant confirms a guessed value with add + dupes',
    async run(relay) {
      const v = await openVault('f12', relay);
      const g1 = path.join(v.src, 'g1.txt'); fs.writeFileSync(g1, 'sk-wrong-guess');
      const g2 = path.join(v.src, 'g2.txt'); fs.writeFileSync(g2, SECRET);
      await req('POST', '/api/cli/add', { cli: v.cli, body: { group: 'Scratch', title: 'guess1', source: g1 } });
      await req('POST', '/api/cli/add', { cli: v.cli, body: { group: 'Scratch', title: 'guess2', source: g2 } });
      const d = await req('GET', '/api/cli/dupes', { cli: v.cli });
      const groups = (d.json.duplicates || []).map((g) => g.join('+'));
      const hit = groups.some((g) => g.includes('AI/OpenAI') && g.includes('guess2'));
      const miss = !groups.some((g) => g.includes('guess1'));
      return { ok: hit && miss, detail: `dupes: ${groups.join(' | ') || 'none'}` };
    },
  },
  {
    id: 'F13', kind: 'limit', title: 'Assistant wires a key into its own project .env and reads it back',
    async run(relay) {
      const v = await openVault('f13', relay);
      const proj = path.join(v.inst.root, 'proj'); fs.mkdirSync(proj, { recursive: true });
      const r = await req('POST', '/api/cli/wire', { cli: v.cli, body: { ref: 'AI/OpenAI', name: 'OPENAI_API_KEY', dotenv: path.join(proj, '.env') } });
      const read = fs.readFileSync(path.join(proj, '.env'), 'utf8');
      return { ok: r.status === 200 && read.includes(SECRET), detail: `wire ${r.status}; value readable in proj/.env: ${read.includes(SECRET)}` };
    },
  },
  {
    id: 'F14', kind: 'limit', title: 'Phishing link built from any seen QR captures the passkey secret; with a copy of the vault files it opens everything',
    async run(relay) {
      const v = await openVault('f14', relay);
      await req('POST', '/api/lock', { token: v.token });
      await req('POST', '/api/unlock', { token: v.token });
      const seen = H.PHONE.parseUrl((await getState(v.token)).pending.url);
      await req('POST', '/api/cancel', { token: v.token });
      const ch = H.K.newChannel();
      const link = `https://phone-page.invalid/#v1.u.${ch.id}.${ch.pub}.${seen.salt}.${encodeURIComponent(seen.name)}.15`;
      const tapped = await H.phoneAnswer(link, v.owner, 'unlock'); // the owner taps the link and touches the sensor
      const got = H.K.openFromPhone(ch, tapped.sealed);
      const key = H.kFromPrf(fs.readFileSync(v.cfgFile, 'utf8'), { cred: got.cred, prf: H.b64u.dec(got.prf) });
      const s = key && await secretFrom(v.vaultFile, key);
      return { ok: s === SECRET, detail: `attacker decrypted the passkey secret: ${!!got.prf}; + copies of keyturn.json and vault.kdbx -> ${s === SECRET ? 'AI/OpenAI value' : 'nothing'}` };
    },
  },
  {
    id: 'F15', kind: 'secure', title: 'Double-clicking Keyturn again breaks the assistant tool (cli.token overwritten)',
    async run(relay) {
      const inst = await start('f15', relay);
      const before = inst.cliToken();
      const second = spawn(process.execPath, [path.join(H.APP, 'server.js')], { cwd: H.APP, env: inst.env, stdio: 'ignore' });
      await new Promise((r) => second.on('exit', r));
      await sleep(400);
      const r = await req('GET', '/api/cli/status', { cli: inst.cliToken() });
      return { ok: r.status === 200, detail: `token file changed: ${inst.cliToken() !== before}; assistant tool after second launch -> ${r.status}` };
    },
  },
];

H.relayPost = (relay, a) => relay.phonePost(a.p.ch, a.sealed, 5000);

(async () => {
  const label = process.argv[2] || 'run';
  const only = process.argv.slice(3);
  const relay = await H.startRelay();
  const results = [];
  for (const t of TESTS) {
    if (only.length && !only.includes(t.id)) continue;
    tracked = [];
    let r;
    try { r = await t.run(relay); } catch (e) { r = { error: (e && e.stack) || String(e) }; }
    for (const i of tracked) await i.stop();
    await sleep(150);
    const verdict = r.error ? 'ERROR' : r.na ? 'N/A' : t.kind === 'limit' ? (r.ok ? 'DEMONSTRATED' : 'NOT-REPRODUCED') : (r.ok ? 'PASS' : 'FAIL');
    results.push({ id: t.id, kind: t.kind, title: t.title, verdict, detail: r.detail || r.error });
    console.log(`${t.id.padEnd(4)} ${verdict.padEnd(14)} ${t.title}\n     ${String(r.detail || r.error).split('\n').slice(0, 6).join('\n     ')}`);
  }
  relay.close();
  fs.writeFileSync(path.join(__dirname, `results-${label}.json`), JSON.stringify(results, null, 2));
  try { H.clipboard.clear(); } catch { /* */ }
  process.exit(0);
})();
