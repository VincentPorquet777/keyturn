#!/usr/bin/env node
'use strict';
// Keyturn assistant tool. Works with names only: it can never print a password or key.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = +process.env.KEYTURN_PORT || 7457;
const LOCAL = process.env.KEYTURN_LOCAL || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Keyturn');
const HELP = `keyturn <command>
  status                         locked or open, and for how long
  open ["reason"] [--no-wait]    show the owner the unlock window; waits up to 3 minutes for their fingerprint
  list [--json]                  every key by group (names, files, where used; never values)
  dupes                          keys holding the same value
  import <manifest.json>         save many keys ([{group,title,source}])
  add <group> <title> <source>   save one key (source: path, env:NAME or dpapi:path)
  take <group> <title> <file>    save a loose file (e.g. a download) and move the original to the Recycle Bin
  move <group/title> <group>     rename <group/title> <new title>     remove <group/title>
  wire <group/title> <NAME> [--dotenv <file>]   put a key into a Windows setting or a .env file
  lock                           lock now`;

async function call(cmd, body) {
  let token;
  try { token = fs.readFileSync(path.join(LOCAL, 'cli.token'), 'utf8').trim(); } catch { fail('Keyturn is not running. Start it from its desktop shortcut.'); }
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${PORT}/api/cli/${cmd}`, {
      method: body ? 'POST' : 'GET', headers: { 'x-keyturn-cli': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
  } catch { fail('Keyturn is not running. Start it from its desktop shortcut.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) fail(j.error || `Error ${r.status}`, r.status === 423 ? 3 : 1);
  return j;
}
function fail(msg, code = 1) { console.error(msg); process.exit(code); }
const left = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return `${m} min`; };

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  const flag = (f) => { const i = a.indexOf(f); if (i < 0) return null; const v = a[i + 1]; a.splice(i, 2); return v; };
  switch (cmd) {
    case 'status': {
      const s = await call('status');
      console.log(!s.setup ? 'Not set up yet' : s.locked ? `Locked${s.pending ? ` (phone request: ${s.pending})` : ''}` : `Open, ${left(s.expiresAt)} left`);
      break;
    }
    case 'open': {
      const noWait = a.includes('--no-wait');
      const reason = a.filter((x) => x !== '--no-wait').join(' ');
      let s = await call('status');
      if (!s.locked) { console.log(`Already open, ${left(s.expiresAt)} left`); break; }
      await call('open', { reason });
      console.log('Unlock window shown. Waiting for the owner\'s fingerprint…');
      if (noWait) break;
      const until = Date.now() + 3.5 * 60000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        s = await call('status');
        if (!s.locked) { console.log(`Open, ${left(s.expiresAt)} left`); return; }
      }
      fail('Not unlocked within 3 minutes.', 3);
      break;
    }
    case 'list': {
      const r = await call('list');
      if (a.includes('--json')) { console.log(JSON.stringify(r, null, 2)); break; }
      let g = null;
      for (const e of r.entries.sort((x, y) => (x.group + x.title).localeCompare(y.group + y.title))) {
        if (e.group !== g) { g = e.group; console.log(`\n${g || '(top)'}`); }
        const bits = [e.hasPassword ? 'value' : null, ...e.files.map((f) => `file ${f.name}`)].filter(Boolean).join(', ');
        console.log(`  ${e.title}  [${bits || 'empty'}]${e.usedIn.length ? `  → ${e.usedIn.join('; ')}` : ''}`);
      }
      console.log(`\n${r.summary.keys} keys, open ${left(r.expiresAt)} more`);
      break;
    }
    case 'dupes': {
      const r = await call('dupes');
      if (!r.duplicates.length) console.log('No duplicates');
      for (const d of r.duplicates) console.log('Same value: ' + d.join('  |  '));
      break;
    }
    case 'import': {
      if (!a[0]) fail(HELP);
      const r = await call('import', { manifest: path.resolve(a[0]) });
      console.log(`Saved ${r.saved.length}, not found ${r.skipped.length}, failed ${r.failed.length}`);
      for (const s of r.skipped) console.log(`  not found: ${s.ref}`);
      for (const f of r.failed) console.log(`  failed: ${f.ref} (${f.why})`);
      break;
    }
    case 'take': { if (a.length < 3) fail(HELP); const r = await call('take', { group: a[0], title: a[1], file: path.resolve(a[2]) }); console.log(`${r.created ? 'Saved' : 'Updated'} ${r.ref}; original moved to the Recycle Bin`); break; }
    case 'add': { if (a.length < 3) fail(HELP); const r = await call('add', { group: a[0], title: a[1], source: a[2] }); console.log(`${r.created ? 'Saved' : 'Updated'} ${r.ref}`); break; }
    case 'move': { await call('move', { ref: a[0], group: a[1] }); console.log('Moved'); break; }
    case 'rename': { await call('rename', { ref: a[0], title: a[1] }); console.log('Renamed'); break; }
    case 'remove': { await call('remove', { ref: a[0] }); console.log('Moved to the recycle bin'); break; }
    case 'wire': {
      const dotenv = flag('--dotenv');
      if (a.length < 2) fail(HELP);
      const r = await call('wire', { ref: a[0], name: a[1], dotenv: dotenv && path.resolve(dotenv) });
      console.log(`Done: ${r.where}`);
      break;
    }
    case 'lock': { await call('lock', {}); console.log('Locked'); break; }
    default: console.log(HELP);
  }
})();
