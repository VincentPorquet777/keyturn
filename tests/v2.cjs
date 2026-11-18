'use strict';
// Tests for the v2 key boxes: upgrading an existing vault, real revocation on unlink / new recovery code,
// the recovery code working from the vault file alone, and a new PC. Test instance only (port 17457).
const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');
const { req, getState, K, b64u } = H;
const { Vault } = require(path.join(H.APP, 'lib', 'vault.js'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const secretFrom = async (file, key) => { try { return (await Vault.open(file, key)).secretOf('AI/OpenAI'); } catch { return null; } };

async function boot(name, relay, prepare, reuse = false) {
  const root = path.join(H.RUNTIME, name);
  if (!reuse) fs.rmSync(root, { recursive: true, force: true });
  if (prepare) await prepare(path.join(root, 'data'), path.join(root, 'local'));
  const inst = await H.startInstance(name, { relay, keep: !!prepare });
  return { inst, token: await H.ownerToken(inst), cfgFile: path.join(inst.data, 'keyturn.json'), vaultFile: path.join(inst.data, 'vault.kdbx') };
}
const unlocked = async (token) => H.waitFor(async () => { const s = await getState(token); return s && !s.locked && s; }, 8000);

(async () => {
  const relay = await H.startRelay();
  let inst;
  try {
    // ---------- 1. a vault made by the old version upgrades itself ----------
    const SECRET = 'sk-v2-FAKE-' + Date.now();
    const owner = H.newPhone('Owner Pixel');
    const code = K.newRecoveryCode();
    let v = await boot('v2-upgrade', relay, async (data, local) => {
      fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(local, { recursive: true });
      const key = K.random(32);
      const vault = await Vault.create(path.join(data, 'vault.kdbx'), key, 'Keyturn');
      await vault.upsert({ group: 'AI', title: 'OpenAI', value: SECRET });
      await vault.save();
      const vaultId = b64u.enc(K.random(16)); const rsalt = K.random(16);
      fs.writeFileSync(path.join(data, 'keyturn.json'), JSON.stringify({
        v: 1, product: 'Keyturn', vaultId, prfSalt: b64u.enc(K.random(32)), minutes: 15, created: new Date().toISOString(),
        devices: [{ id: 'd1', name: owner.device, cred: owner.cred, created: new Date().toISOString(), lastUsed: null, box: K.aesWrap(K.prfWrapKey(owner.prf, vaultId), key, b64u.dec(owner.cred)) }],
        recovery: { salt: b64u.enc(rsalt), box: K.aesWrap(await K.recoveryWrapKey(code, rsalt), key, Buffer.from('recovery')) },
      }));
    });
    inst = v.inst;
    let s = await getState(v.token);
    check('old vault: phone shown as not yet updated', s.devices[0] && s.devices[0].upgraded === false);
    let r = await H.ownerUnlock(relay, v.token, owner);
    s = await unlocked(v.token);
    let cfg = JSON.parse(fs.readFileSync(v.cfgFile, 'utf8'));
    check('old phone still unlocks after the update', !!r.ok && !!s);
    check('…and its box is re-sealed the new way', cfg.devices[0].v === 2 && !!cfg.devices[0].pub && fs.existsSync(path.join(inst.local, 'pc.secret')));
    check('recovery code asks for its one-time check', s.paperCheck === true);
    r = await req('POST', '/api/recovery/check', { token: v.token, body: { code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' } });
    check('wrong recovery code refused by the check', r.status === 403);
    r = await req('POST', '/api/recovery/check', { token: v.token, body: { code } });
    cfg = JSON.parse(fs.readFileSync(v.cfgFile, 'utf8'));
    s = await getState(v.token);
    check('right recovery code finishes the upgrade', r.status === 200 && cfg.recovery.v === 2 && s.paperCheck === false);
    check('recovery box now also in the vault file header', !!Vault.readRecovery(v.vaultFile));
    const kRec = await H.kFromRecovery(fs.readFileSync(v.cfgFile, 'utf8'), code);
    check('recovery code opens the vault (value intact)', (await secretFrom(v.vaultFile, kRec)) === SECRET);

    // ---------- 2. unlinking a phone really revokes it ----------
    const B = H.newPhone('Old phone');
    await H.ownerAddPhone(relay, v.token, B);
    const copyWithB = fs.readFileSync(v.cfgFile, 'utf8');
    const vaultCopyWithB = fs.readFileSync(v.vaultFile);
    const kB = H.kFromPrf(copyWithB, B, inst.local);
    check('second phone linked (opens the vault while linked)', (await secretFrom(v.vaultFile, kB)) === SECRET);
    s = await getState(v.token);
    const bId = s.devices.find((d) => d.name === 'Old phone').id;
    r = await req('POST', '/api/device/remove', { token: v.token, body: { id: bId } });
    check('unlink succeeds', r.status === 200, r.text.slice(0, 80));
    check('old keyturn.json copy + unlinked phone (even ON this PC) cannot open today’s vault', (await secretFrom(v.vaultFile, kB)) === null);
    check('…nor the scrubbed .bak', (await secretFrom(v.vaultFile + '.bak', kB)) === null);
    const tmpOld = path.join(inst.root, 'old-vault.kdbx'); fs.writeFileSync(tmpOld, vaultCopyWithB);
    check('(an old copy of the vault itself still opens with it: data already copied can’t be un-copied)', (await secretFrom(tmpOld, kB)) === SECRET);
    await req('POST', '/api/lock', { token: v.token });
    r = await H.ownerUnlock(relay, v.token, owner);
    check('remaining phone still unlocks after the re-key', !!r.ok && !!(await unlocked(v.token)));
    const kRec2 = await H.kFromRecovery(fs.readFileSync(v.cfgFile, 'utf8'), code);
    check('same recovery code still works after an unlink (no new paper needed)', (await secretFrom(v.vaultFile, kRec2)) === SECRET);

    // ---------- 3. a new recovery code retires the old one ----------
    const oldCfg = fs.readFileSync(v.cfgFile, 'utf8');
    r = await req('POST', '/api/recovery/new', { token: v.token });
    s = await getState(v.token);
    const code2 = s.recovery;
    await req('POST', '/api/recovery/ack', { token: v.token });
    check('new recovery code made', r.status === 200 && /^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/.test(code2 || ''));
    check('old code + old keyturn.json copy cannot open today’s vault', (await secretFrom(v.vaultFile, await H.kFromRecovery(oldCfg, code))) === null);
    await req('POST', '/api/lock', { token: v.token });
    r = await req('POST', '/api/recovery/unlock', { token: v.token, body: { code } });
    check('old code refused at the unlock screen (incl. the vault header copy)', r.status === 403);
    r = await req('POST', '/api/recovery/unlock', { token: v.token, body: { code: code2 } });
    check('new code unlocks', r.status === 200);
    await req('POST', '/api/lock', { token: v.token });
    r = await H.ownerUnlock(relay, v.token, owner);
    check('phone still unlocks after the new code', !!r.ok && !!(await unlocked(v.token)));
    await req('POST', '/api/lock', { token: v.token });
    await inst.stop();

    // ---------- 4. keyturn.json lost: the recovery code opens the vault file alone ----------
    fs.rmSync(path.join(inst.data, 'keyturn.json')); fs.rmSync(path.join(inst.data, 'keyturn.json.bak'), { force: true });
    v = await boot('v2-upgrade', relay, async () => {}, true);
    inst = v.inst;
    s = await getState(v.token);
    check('settings lost: window offers the recovery code', s.setup === false && s.vaultOnly === true);
    r = await req('POST', '/api/setup', { token: v.token });
    check('…and refuses to set up over the vault', r.status === 409);
    r = await req('POST', '/api/recovery/unlock', { token: v.token, body: { code: code2 } });
    s = await unlocked(v.token);
    check('recovery code opens the vault with keyturn.json gone', r.status === 200 && !!s && s.entries.some((e) => e.ref === 'AI/OpenAI'));
    check('settings rebuilt, no phones linked yet', fs.existsSync(v.cfgFile) && s.devices.length === 0);
    const C = H.newPhone('Owner Pixel again');
    await H.ownerAddPhone(relay, v.token, C);
    await req('POST', '/api/lock', { token: v.token });
    r = await H.ownerUnlock(relay, v.token, C);
    check('phone re-linked and unlocks', !!r.ok && !!(await unlocked(v.token)));
    await req('POST', '/api/lock', { token: v.token });
    await inst.stop();

    // ---------- 5. new PC (this PC's secret is gone) ----------
    fs.rmSync(path.join(inst.local, 'pc.secret'));
    v = await boot('v2-upgrade', relay, async () => {}, true);
    inst = v.inst;
    r = await H.ownerUnlock(relay, v.token, C);
    check('phone alone can’t open it on a new PC (clear message)', !r.ok && /no longer recognises your phone/.test(r.message || ''), r.message);
    await req('POST', '/api/cancel', { token: v.token });
    r = await req('POST', '/api/recovery/unlock', { token: v.token, body: { code: code2 } });
    s = await unlocked(v.token);
    check('recovery code opens it on the new PC; old phone links dropped', r.status === 200 && !!s && s.devices.length === 0);
    await H.ownerAddPhone(relay, v.token, C);
    await req('POST', '/api/lock', { token: v.token });
    r = await H.ownerUnlock(relay, v.token, C);
    check('phone re-linked on the new PC unlocks', !!r.ok && !!(await unlocked(v.token)));
  } catch (e) {
    console.error('ERROR', e && e.stack || e);
    if (inst) console.error(inst.out.slice(-1500));
    results.push({ ok: false });
  } finally {
    if (inst) await inst.stop();
    relay.close();
  }
  const bad = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
