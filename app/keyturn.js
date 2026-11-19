#!/usr/bin/env node
'use strict';
// Keyturn assistant tool. Works with names only: it can never print a password or key.
const fs = require('fs');
const path = require('path');
const { HEADLESS, LOCAL } = require('./lib/paths');

const PORT = +process.env.KEYTURN_PORT || 7457;
const NOT_RUNNING = HEADLESS
  ? 'Keyturn is not running. Start it with: systemctl --user start keyturn'
  : 'Keyturn is not running. Start it from its desktop shortcut.';
const HELP = `keyturn <command>
  status                         locked or open, and for how long
  open ["reason"] [--no-wait]    ask the owner to unlock with their phone; waits up to 3 minutes for their fingerprint
  list [--json]                  every key by group (names, files, where used; never values)
  dupes                          keys holding the same value
  import <manifest.json>         save many keys ([{group,title,source}])
  add <group> <title> <source>   save one key (source: path${HEADLESS ? ' or env:NAME' : ', env:NAME or dpapi:path'})
  take <group> <title> <file>    save a loose file (e.g. a download) and move the original to the ${HEADLESS ? 'Trash' : 'Recycle Bin'}
  move <group/title> <group>     rename <group/title> <new title>     remove <group/title>
  wire <group/title> <NAME> ${HEADLESS ? '--dotenv <file>     put a key into a .env file' : '[--dotenv <file>]   put a key into a Windows setting or a .env file'}
  lock                           lock now${HEADLESS ? `

Server mode (no window on this computer; the owner uses their phone through you):
  setup                          start set-up: prints a link to send the owner
  confirm <code>                 the four digits the owner's phone shows, to finish linking it
  addphone                       link another phone (vault open): prints a link to send the owner
  wait                           wait up to 3 minutes for the owner's fingerprint
  devices                        linked phones
  cancel                         cancel a link you sent` : ''}`;

async function call(cmd, body) {
  let token;
  try { token = fs.readFileSync(path.join(LOCAL, 'cli.token'), 'utf8').trim(); } catch { fail(NOT_RUNNING); }
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${PORT}/api/cli/${cmd}`, {
      method: body ? 'POST' : 'GET', headers: { 'x-keyturn-cli': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
  } catch { fail(NOT_RUNNING); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) fail(j.error || `Error ${r.status}`, r.status === 423 ? 3 : 1);
  return j;
}
function fail(msg, code = 1) { console.error(msg); process.exit(code); }
const left = (t) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return `${m} min`; };

async function waitOpen() {
  const until = Date.now() + 3.5 * 60000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await call('status');
    if (!s.locked) { console.log(`Open, ${left(s.expiresAt)} left`); return; }
  }
  fail('Not unlocked within 3 minutes.', 3);
}

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  const flag = (f) => { const i = a.indexOf(f); if (i < 0) return null; const v = a[i + 1]; a.splice(i, 2); return v; };
  switch (cmd) {
    case 'status': {
      const s = await call('status');
      const waiting = s.pending ? ` (${s.kind === 'enroll' ? 'set-up' : s.kind === 'addphone' ? 'phone link' : 'phone request'}: ${s.pending})` : '';
      console.log(!s.setup ? `Not set up yet${waiting}` : s.locked ? `Locked${waiting}` : `Open, ${left(s.expiresAt)} left${waiting}`);
      break;
    }
    case 'open': {
      const noWait = a.includes('--no-wait');
      const reason = a.filter((x) => x !== '--no-wait').join(' ');
      const s = await call('status');
      if (!s.locked) { console.log(`Already open, ${left(s.expiresAt)} left`); break; }
      const r = await call('open', { reason });
      if (r.link) {
        console.log('Send the owner this link (their private chat only). They tap it and touch the fingerprint sensor:');
        console.log(r.link);
        console.log(`Their phone shows ${r.code}. It opens for ${r.minutes} minutes. The link works for 3 minutes.`);
      } else console.log('Unlock window shown. Waiting for the owner\'s fingerprint…');
      if (noWait) break;
      await waitOpen();
      break;
    }
    case 'wait': { const s = await call('status'); if (!s.locked) { console.log(`Open, ${left(s.expiresAt)} left`); break; } await waitOpen(); break; }
    case 'setup': case 'addphone': {
      const r = await call(cmd, {});
      console.log(`Send the owner this link (their private chat only). It works for 3 minutes:\n${r.link}`);
      console.log(cmd === 'setup'
        ? 'They tap it and make a passkey with their fingerprint. Their phone then shows their recovery code (for paper, never for chat) and four digits.\nWhen they tell you the four digits: keyturn confirm <digits>'
        : 'They tap it and make a passkey with their fingerprint. When they tell you the four digits their phone shows: keyturn confirm <digits>');
      break;
    }
    case 'confirm': {
      if (!a[0]) fail('keyturn confirm <the four digits the owner\'s phone shows>');
      const r = await call('confirm', { code: a.join('') });
      console.log(r.locked ? 'Phone linked' : `Phone linked. The vault is open, ${left(r.expiresAt)} left`);
      break;
    }
    case 'cancel': { await call('cancel', {}); console.log('Cancelled'); break; }
    case 'devices': {
      const r = await call('devices');
      if (!r.devices.length) console.log('No phones linked');
      for (const d of r.devices) console.log(`${d.name}  linked ${d.created.slice(0, 10)}${d.lastUsed ? `, last used ${d.lastUsed.slice(0, 10)}` : ''}`);
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
    case 'take': { if (a.length < 3) fail(HELP); const r = await call('take', { group: a[0], title: a[1], file: path.resolve(a[2]) }); console.log(`${r.created ? 'Saved' : 'Updated'} ${r.ref}; original moved to the ${HEADLESS ? 'Trash' : 'Recycle Bin'}`); break; }
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
