'use strict';
// Manual look at the v2 screens: an old-style vault, unlocked by a simulated phone, waiting for its
// recovery-code check. Prints a one-time window link (test instance, port 17457). Stops after 6 minutes.
const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');
const { K, b64u } = H;
const { Vault } = require(path.join(H.APP, 'lib', 'vault.js'));
(async () => {
  const relay = await H.startRelay();
  const root = path.join(H.RUNTIME, 'ui-v2'); fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data'); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  const owner = H.newPhone('Pixel 9'); const code = K.newRecoveryCode(); const key = K.random(32);
  const v = await Vault.create(path.join(data, 'vault.kdbx'), key, 'Keyturn');
  for (const [g, t] of [['AI', 'OpenAI'], ['AI', 'Anthropic'], ['Cloud', 'Cloudflare DNS'], ['Servers', 'Herme Sai SSH']]) await v.upsert({ group: g, title: t, value: 'FAKE-' + t });
  await v.save();
  const vaultId = b64u.enc(K.random(16)); const rsalt = K.random(16);
  fs.writeFileSync(path.join(data, 'keyturn.json'), JSON.stringify({ v: 1, product: 'Keyturn', vaultId, prfSalt: b64u.enc(K.random(32)), minutes: 15, created: new Date().toISOString(),
    devices: [{ id: 'd1', name: owner.device, cred: owner.cred, created: new Date().toISOString(), lastUsed: null, box: K.aesWrap(K.prfWrapKey(owner.prf, vaultId), key, b64u.dec(owner.cred)) }],
    recovery: { salt: b64u.enc(rsalt), box: K.aesWrap(await K.recoveryWrapKey(code, rsalt), key, Buffer.from('recovery')) } }));
  const inst = await H.startInstance('ui-v2', { relay, keep: true });
  const token = await H.ownerToken(inst);
  const r = await H.ownerUnlock(relay, token, owner);
  console.log('UNLOCK', JSON.stringify(r));
  fs.writeFileSync(path.join(root, 'code.txt'), code);
  await H.req('POST', '/api/cli/window', { cli: inst.cliToken() });
  await H.sleep(300);
  console.log('WINDOW LINK', inst.links[inst.links.length - 1]);
  await H.sleep(6 * 60000);
  await inst.stop(); relay.close(); process.exit(0);
})();
