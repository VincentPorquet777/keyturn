'use strict';
// Manual UI smoke test: starts a TEST instance (port 17457). Drop {url, t} into .runtime/ui-smoke/answer.json
// (url = the QR link the window shows) and this script answers it as a phone.
// Prints the one-time window link. Stops by itself after 4 minutes.
const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');

(async () => {
  const relay = await H.startRelay();
  const inst = await H.startInstance('ui-smoke', { relay });
  console.log('WINDOW LINK', inst.links[0]);
  const phone = H.newPhone('Smoke Pixel');
  const stopAt = Date.now() + 4 * 60000;
  while (Date.now() < stopAt) {
    const f = path.join(inst.root, 'answer.json');
    if (fs.existsSync(f)) {
      const { url, t } = JSON.parse(fs.readFileSync(f, 'utf8'));
      fs.rmSync(f);
      const a = await H.phoneAnswer(url, phone, t);
      console.log('PHONE CODE', a.code);
      const r = await relay.phonePost(a.p.ch, a.sealed);
      console.log('PHONE GOT', JSON.stringify(r));
    }
    await H.sleep(300);
  }
  await inst.stop(); relay.close(); process.exit(0);
})();
