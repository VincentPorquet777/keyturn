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
  if (iv.length !== 12 || all.length < 16) throw new Error('Bad box');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
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
  const shared = channel.ecdh.computeSecret(b64u.dec(String(msg.pub)));
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(channel.id), Buffer.from('keyturn channel v1'), 32));
  const plain = aesUnwrap(key, { iv: msg.iv, ct: msg.ct }, Buffer.from(channel.id));
  return JSON.parse(plain.toString('utf8'));
}

// Match code for linking a phone. It comes from the key exchange with the phone that actually answered,
// so someone who only saw the QR code cannot predict or copy the code the owner's own phone shows.
// (Same derivation as linkCode() in relay/public/app.js.)
function linkCode(channel, msg) {
  const shared = channel.ecdh.computeSecret(b64u.dec(String(msg.pub)));
  const h = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(channel.id), Buffer.from('keyturn match v2'), 4));
  return String(h.readUInt32BE(0) % 10000).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1 $2');
}

// Server mode: the paper recovery code goes back to the phone that answered, sealed with the key exchange of
// this channel, so the relay passes it without being able to read it. (Same derivation as openReply() in
// relay/public/app.js.)
function sealReply(channel, msg, text) {
  const shared = channel.ecdh.computeSecret(b64u.dec(String(msg.pub)));
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(channel.id), Buffer.from('keyturn reply v1'), 32));
  try { const box = aesWrap(key, Buffer.from(text, 'utf8'), Buffer.from(channel.id + '.reply')); return `${box.iv}.${box.ct}`; } finally { key.fill(0); }
}

// ---------- v2 key boxes ----------
// The vault key K is sealed to a P-256 public key (one per phone, one for the paper code). Sealing needs only
// the public key, so Keyturn can change K and seal the new one again for every phone and the paper code without
// asking for them. That is what makes "unlink a phone" and "new paper code" real: old copies of keyturn.json
// open only old copies of the vault.
function p256From(seed, label) {
  for (let i = 0; i < 16; i++) {
    const d = Buffer.from(crypto.hkdfSync('sha256', seed, Buffer.from(label), Buffer.from('keyturn p256 v2 ' + i), 32));
    const e = crypto.createECDH('prime256v1');
    try { e.setPrivateKey(d); return e; } catch { /* outside the curve's range (vanishingly rare): next one */ } finally { d.fill(0); }
  }
  throw new Error('Could not make a key');
}
const pubOf = (e) => b64u.enc(e.getPublicKey(null, 'uncompressed'));
function sealKey(shared, epub, pub) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epub, pub]), Buffer.from('keyturn seal v2'), 32));
}
function sealTo(pubB64, plain, aad) {
  const pub = b64u.dec(pubB64);
  const eph = crypto.createECDH('prime256v1');
  eph.generateKeys();
  const epub = eph.getPublicKey(null, 'uncompressed');
  const key = sealKey(eph.computeSecret(pub), epub, pub);
  try { return { epub: b64u.enc(epub), ...aesWrap(key, plain, aad) }; } finally { key.fill(0); }
}
function openWith(e, box, aad) {
  const epub = b64u.dec(String(box.epub));
  const key = sealKey(e.computeSecret(epub), epub, e.getPublicKey(null, 'uncompressed'));
  try { return aesUnwrap(key, box, aad); } finally { key.fill(0); }
}
// A phone's key pair comes from its passkey secret AND a secret kept only on this PC (pcSecret), so a phished
// passkey answer plus copies of the vault files is not enough on its own.
function phoneKey(prf, pcSecret, vaultId) { return p256From(Buffer.concat([prf, pcSecret]), 'phone:' + vaultId); }
// The paper code's key pair comes from the code alone, so the paper code works on any PC.
async function recoveryKey(code, salt) {
  const seed = await recoveryWrapKey(code, salt);
  try { return p256From(seed, 'recovery'); } finally { seed.fill(0); }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function token() { return b64u.enc(random(24)); }
function same(a, b) { return a.length === b.length && crypto.timingSafeEqual(a, b); }

module.exports = { b64u, random, aesWrap, aesUnwrap, prfWrapKey, newRecoveryCode, normaliseCode, recoveryWrapKey, newChannel, openFromPhone, linkCode, sealReply, sealTo, openWith, pubOf, phoneKey, recoveryKey, sha256, token, same };
