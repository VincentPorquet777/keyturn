'use strict';
// Server mode (an assistant on a server, no window): set-up, confirming the phone's code, the paper code shown on
// the phone only, unlocking from a link, .env wiring, and a phone that answered someone else's copy of the link.
// Test instance only (port 17457, own folders, relay stub). Runs on Windows (KEYTURN_HEADLESS=1) and on Linux.
const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');
const { req, K } = H;

let bad = 0;
const ok = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  (' + d + ')' : ''}`); if (!c) bad++; };
const SERVER = { KEYTURN_HEADLESS: '1', KEYTURN_PC_NAME: 'My Assistant' };

async function setupAnswer(relay, cli, phone) {
  const s = await req('POST', '/api/cli/setup', { cli, body: {} });
  if (s.status !== 200) throw new Error('setup: ' + s.text);
  const a = await H.phoneAnswer(s.json.link, phone, 'enroll');
  return { link: s.json.link, a, res: await H.relay_post(relay, a) };
}

(async () => {
  const relay = await H.startRelay();
  H.relay_post = (r, a) => r.phonePost(a.p.ch, a.sealed);
  let inst;
  try {
    // ---------- 1. set-up through the assistant ----------
    inst = await H.startInstance('server-mode', { relay, open: false, extraEnv: SERVER });
    const cli = inst.cliToken();
    ok('starts in server mode', /\(server mode\)/.test(inst.out));
    let st = await req('GET', '/api/cli/status', { cli });
    ok('status: not set up, server mode', st.json.setup === false && st.json.server === true);

    const owner = H.newPhone('Pixel 9');
    const { link, a, res } = await setupAnswer(relay, cli, owner);
    ok('set-up link is a server-mode phone link', link.startsWith(relay.url + '/#v1.e.') && link.endsWith('.s'), link.slice(-20));
    ok('phone page reads it as server mode', a.p.server === true);
    ok('phone is told to give its code to the assistant', res.ok && /^tell\./.test(res.detail), res.detail && res.detail.slice(0, 8));
    const paper = await H.PHONE.openReply(a.p, res.detail.slice(5));
    ok('the phone (only) can read the paper recovery code', /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/.test(paper));
    ok('the relay message does not contain the paper code', !JSON.stringify(res).includes(paper));

    let c = await req('POST', '/api/cli/confirm', { cli, body: { code: '0000' === a.code.replace(/\D/g, '') ? '1111' : '0000' } });
    ok('a wrong code is refused', c.status === 403);
    st = await req('GET', '/api/cli/status', { cli });
    ok('still waiting after one wrong code', st.json.setup === false && st.json.pending === 'confirm');
    c = await req('POST', '/api/cli/confirm', { cli, body: { code: a.code } });
    ok('the right code links the phone and opens the vault', c.status === 200 && c.json.setup && !c.json.locked, c.text.slice(0, 80));

    const cfgText = fs.readFileSync(path.join(inst.data, 'keyturn.json'), 'utf8');
    const kPaper = await H.kFromRecovery(cfgText, paper);
    ok('the code shown on the phone is the vault\'s recovery code', !!kPaper && !!(await H.openVaultFile(path.join(inst.data, 'vault.kdbx'), kPaper)));
    const everything = [inst.out, fs.readFileSync(path.join(inst.data, 'activity.log'), 'utf8'), cfgText, st.text, c.text].join('\n');
    ok('the paper code is nowhere on the server: output, activity log, settings, CLI answers', !everything.includes(paper) && !everything.includes(paper.replace(/-/g, '')));

    // ---------- 2. the assistant files and wires keys, names only ----------
    const work = path.join(inst.root, 'work'); fs.mkdirSync(work);
    const SECRET = 're_FAKE_' + Date.now();
    fs.writeFileSync(path.join(work, 'resend.txt'), SECRET + '\n');
    let r = await req('POST', '/api/cli/take', { cli, body: { group: 'Email', title: 'Resend send-only', file: path.join(work, 'resend.txt') } });
    ok('take files a key and removes the loose file', r.status === 200 && !fs.existsSync(path.join(work, 'resend.txt')));
    r = await req('GET', '/api/cli/list', { cli });
    ok('list shows names, never values', r.status === 200 && r.text.includes('Resend send-only') && !r.text.includes(SECRET));
    r = await req('POST', '/api/cli/wire', { cli, body: { ref: 'Email/Resend send-only', name: 'RESEND_API_KEY' } });
    ok('no user settings in server mode: .env only', r.status === 400 && /--dotenv/.test(r.json.error));
    const env = path.join(work, '.env');
    r = await req('POST', '/api/cli/wire', { cli, body: { ref: 'Email/Resend send-only', name: 'RESEND_API_KEY', dotenv: env } });
    ok('wire puts it into a .env', r.status === 200 && fs.readFileSync(env, 'utf8').includes(`RESEND_API_KEY=${SECRET}`) && !r.text.includes(SECRET));
    r = await req('GET', '/api/cli/devices', { cli });
    ok('devices lists the linked phone by name', r.json.devices.length === 1 && r.json.devices[0].name === 'Pixel 9');

    // ---------- 3. lock, then unlock from a link the assistant sends ----------
    await req('POST', '/api/cli/lock', { cli, body: {} });
    r = await req('POST', '/api/cli/open', { cli, body: { reason: 'File your new Stripe key' } });
    ok('open gives the assistant a link and the code to quote', r.status === 200 && /\/#v1\.u\./.test(r.json.link) && /^\d\d \d\d$/.test(r.json.code));
    const u = await H.phoneAnswer(r.json.link, owner, 'unlock');
    ok('phone shows the same code the assistant quotes', u.code === r.json.code);
    const ur = await relay.phonePost(u.p.ch, u.sealed);
    st = await req('GET', '/api/cli/status', { cli });
    ok('the owner\'s fingerprint opens it', ur.ok && st.json.locked === false, ur.message);
    const stranger = H.newPhone('Stranger');
    await req('POST', '/api/cli/lock', { cli, body: {} });
    r = await req('POST', '/api/cli/open', { cli, body: { reason: 'x' } });
    const s2 = await H.phoneAnswer(r.json.link, stranger, 'unlock');
    const sr = await relay.phonePost(s2.p.ch, s2.sealed);
    st = await req('GET', '/api/cli/status', { cli });
    ok('a phone that is not linked cannot open it', !sr.ok && st.json.locked === true, sr.message);
    r = await req('POST', '/api/cli/setup', { cli, body: {} });
    ok('set-up cannot run twice', r.status === 409);
    await req('POST', '/api/cli/cancel', { cli, body: {} });

    // ---------- 4. the window routes stay shut in server mode ----------
    r = await req('POST', '/api/link/confirm', { token: 'nope' });
    ok('window confirm route needs the window key', r.status === 401);
    await inst.stop();

    // ---------- 5. someone else answered a copy of the set-up link first ----------
    inst = await H.startInstance('server-mode-race', { relay, open: false, extraEnv: SERVER });
    const cli2 = inst.cliToken();
    const thief = H.newPhone('Thief');
    const first = await setupAnswer(relay, cli2, thief);
    ok('the first phone to answer gets through to the code step', first.res.ok);
    const mine = await H.phoneAnswer(first.link, H.newPhone('Owner'), 'enroll');
    const late = await relay.phonePost(mine.p.ch, mine.sealed);
    ok('the owner\'s phone is told another phone answered', !late.ok && /Another phone/.test(late.message), late.message);
    const tries = [];
    for (let i = 0; i < 3; i++) tries.push((await req('POST', '/api/cli/confirm', { cli: cli2, body: { code: mine.code } })).status);
    st = await req('GET', '/api/cli/status', { cli: cli2 });
    ok('the owner\'s code never confirms the other phone; 3 tries cancel the link', mine.code === first.a.code || (tries.every((t) => t === 403) && st.json.setup === false && !st.json.pending), tries.join(','));
    ok('no vault was made', !fs.existsSync(path.join(inst.data, 'vault.kdbx')));
  } catch (e) { console.error(e); bad++; } finally { if (inst) await inst.stop(); relay.close(); }
  console.log(bad ? `${bad} FAILED` : 'ALL PASS');
  process.exit(bad ? 1 : 0);
})();
