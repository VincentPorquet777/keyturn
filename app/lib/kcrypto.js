'use strict';
// Keyturn key handling. The vault key K (32 random bytes) opens the KeePass file.
// K is only ever stored wrapped: once per linked phone (by that phone's passkey PRF output)
// and once by the recovery code.
const crypto = require('crypto');

const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(String(s), 'base64url'),
};

function random(n) { return crypto.randomBytes(n); }

function aesWrap(key, plain, aad) {
  const iv = random(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

function aesUnwrap(key, box, aad) {
  const iv = b64u.dec(box.iv);
  const all = b64u.dec(box.ct);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}

// Phone passkey PRF output -> wrapping key for K
function prfWrapKey(prf, vaultId) {
  return Buffer.from(crypto.hkdfSync('sha256', prf, Buffer.from(vaultId), Buffer.from('keyturn wrap v1'), 32));
}

// Recovery code: 24 base32 characters (120 bits), shown in groups of four
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const bytes = random(24);
  let s = '';
  for (const b of bytes) s += B32[b % 32];
  return s.match(/.{4}/g).join('-');
}
function normaliseCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');
}
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
function recoveryWrapKey(code, salt) {
  return new Promise((res, rej) => crypto.scrypt(normaliseCode(code), salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
}

// Channel between this PC and the phone page: ECDH P-256 + HKDF + AES-GCM (matches the phone's WebCrypto code)
function newChannel() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { id: b64u.enc(random(16)), ecdh, pub: b64u.enc(ecdh.getPublicKey(null, 'uncompressed')) };
}
function openFromPhone(channel, msg) {
  const shared = channel.ecdh.computeSecret(b64u.dec(msg.pub));
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(channel.id), Buffer.from('keyturn channel v1'), 32));
  const plain = aesUnwrap(key, { iv: msg.iv, ct: msg.ct }, Buffer.from(channel.id));
  return JSON.parse(plain.toString('utf8'));
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function token() { return b64u.enc(random(24)); }

module.exports = { b64u, random, aesWrap, aesUnwrap, prfWrapKey, newRecoveryCode, normaliseCode, recoveryWrapKey, newChannel, openFromPhone, sha256, token };
