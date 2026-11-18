'use strict';
// keyturn take: saves the file into the vault, then the original goes to the Recycle Bin; .env files are refused.
const fs = require('fs'); const path = require('path'); const H = require('./harness.cjs');
(async () => {
  const relay = await H.startRelay(); const inst = await H.startInstance('take', { relay });
  let bad = 0; const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) bad++; };
  try {
    const token = await H.ownerToken(inst); await H.ownerEnroll(inst, relay, token, H.newPhone());
    const cli = inst.cliToken(); const dl = path.join(inst.root, 'Downloads'); fs.mkdirSync(dl);
    const f = path.join(dl, 'stripe-recovery-codes.txt'); fs.writeFileSync(f, 'FAKE-CODES-1\nFAKE-CODES-2\n');
    let r = await H.req('POST', '/api/cli/take', { cli, body: { group: 'Recovery codes', title: 'Stripe', file: f } });
    ok('take saves the file', r.status === 200 && r.json.ref === 'Recovery codes/Stripe');
    ok('original is gone from Downloads (in the Recycle Bin)', !fs.existsSync(f));
    const list = await H.req('GET', '/api/cli/list', { cli });
    ok('vault lists it with the file attached', list.json.entries.some((e) => e.ref === 'Recovery codes/Stripe' && e.files.some((x) => x.name === 'stripe-recovery-codes.txt')));
    const env = path.join(dl, '.env'); fs.writeFileSync(env, 'X=FAKE');
    r = await H.req('POST', '/api/cli/take', { cli, body: { group: 'G', title: 'env', file: env } });
    ok('.env refused (programs read it in place) and left alone', r.status === 400 && fs.existsSync(env));
  } catch (e) { console.error(e); bad++; } finally { await inst.stop(); relay.close(); }
  process.exit(bad ? 1 : 0);
})();
