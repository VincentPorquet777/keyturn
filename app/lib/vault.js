'use strict';
// The vault is a standard KeePass (KDBX 4) file. Its key is K, used as a 32-byte key file,
// so it can always be opened by KeePassXC / KeePassDX with an exported key file in an emergency.
const fs = require('fs');
const path = require('path');
const kdbxweb = require('kdbxweb');
const { argon2d, argon2id } = require('hash-wasm');
const { sha256 } = require('./kcrypto');

kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type) => {
  const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
  return fn({
    password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
    iterations, hashLength: length, parallelism, outputType: 'binary',
  }).then((r) => r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength));
});

const WIRED = 'Keyturn: used in';
const SOURCE = 'Keyturn: source';

function creds(K) { return new kdbxweb.Credentials(null, new Uint8Array(K).buffer); }

class Vault {
  constructor(file, db) { this.file = file; this.db = db; }

  static async create(file, K, name) {
    const db = kdbxweb.Kdbx.create(creds(K), name || 'Keyturn');
    db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    const v = new Vault(file, db);
    await v.save();
    return v;
  }

  static async open(file, K) {
    const data = fs.readFileSync(file);
    const db = await kdbxweb.Kdbx.load(new Uint8Array(data).buffer, creds(K));
    return new Vault(file, db);
  }

  async save() {
    const buf = Buffer.from(await this.db.save());
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, buf);
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(tmp, this.file);
  }

  root() { return this.db.getDefaultGroup(); }
  recycle() { return this.db.meta.recycleBinUuid ? this.db.getGroup(this.db.meta.recycleBinUuid) : null; }

  groups() {
    const bin = this.recycle();
    return this.root().groups.filter((g) => g !== bin);
  }

  group(name, create) {
    let g = this.groups().find((x) => x.name === name);
    if (!g && create) g = this.db.createGroup(this.root(), name);
    return g || null;
  }

  *allEntries() {
    const bin = this.recycle();
    for (const e of this.root().entries) yield { group: null, entry: e };
    for (const g of this.groups()) {
      if (g === bin) continue;
      for (const e of walk(g)) yield { group: g, entry: e };
    }
    function* walk(g) { for (const e of g.entries) yield e; for (const s of g.groups) yield* walk(s); }
  }

  find(ref) {
    const [gname, ...rest] = String(ref).split('/');
    const title = rest.join('/');
    for (const { group, entry } of this.allEntries()) {
      if (title ? group && group.name === gname && text(entry, 'Title') === title : text(entry, 'Title') === gname) return { group, entry };
    }
    return null;
  }

  // Names and shapes only, never values.
  describe({ group, entry }) {
    const pw = entry.fields.get('Password');
    const files = [];
    for (const [name, ref] of entry.binaries) {
      const data = ref && (ref.value || ref);
      const len = data && (data.byteLength || (data.getBinary && data.getBinary().byteLength)) || 0;
      files.push({ name, bytes: len });
    }
    return {
      ref: (group ? group.name + '/' : '') + text(entry, 'Title'),
      group: group ? group.name : '',
      title: text(entry, 'Title'),
      hasPassword: !!(pw && valueOf(pw)),
      files,
      source: text(entry, SOURCE) || text(entry, 'URL') || '',
      usedIn: (text(entry, WIRED) || '').split('\n').filter(Boolean),
      modified: entry.times.lastModTime ? entry.times.lastModTime.toISOString() : null,
    };
  }

  list() {
    return [...this.allEntries()].map((x) => this.describe(x));
  }

  summary() {
    const items = this.list();
    return { keys: items.length, groups: this.groups().map((g) => ({ name: g.name, count: items.filter((i) => i.group === g.name).length })) };
  }

  // Add or replace an entry. value: secret string (Password field). file: {name, data}.
  async upsert({ group, title, value, file, source }) {
    const g = this.group(group, true);
    let found = this.find(group + '/' + title);
    const entry = found ? found.entry : this.db.createEntry(g);
    if (found) entry.pushHistory(); // an overwritten value stays recoverable in KeePass history
    entry.fields.set('Title', title);
    if (value != null) entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(String(value)));
    if (source) entry.fields.set(SOURCE, source);
    if (file) {
      const bin = await this.db.createBinary(kdbxweb.ProtectedValue.fromBinary(new Uint8Array(file.data)));
      entry.binaries.set(file.name, bin);
    }
    entry.times.update();
    return { created: !found, ref: group + '/' + title };
  }

  secretOf(ref) {
    const f = this.find(ref);
    if (!f) return null;
    const pw = f.entry.fields.get('Password');
    if (pw && valueOf(pw)) return valueOf(pw);
    for (const [, b] of f.entry.binaries) {
      const data = binaryBytes(b);
      if (data) {
        const s = Buffer.from(data).toString('utf8').trim();
        if (!s.includes('\n')) return s;
      }
    }
    return null;
  }

  markUsed(ref, where) {
    const f = this.find(ref);
    if (!f) return;
    const now = (text(f.entry, WIRED) || '').split('\n').filter(Boolean);
    if (!now.includes(where)) now.push(where);
    f.entry.fields.set(WIRED, now.join('\n'));
    f.entry.times.update();
  }

  move(ref, toGroup) {
    const f = this.find(ref);
    if (!f) return false;
    this.db.move(f.entry, this.group(toGroup, true));
    return true;
  }

  rename(ref, title) {
    const f = this.find(ref);
    if (!f) return false;
    f.entry.fields.set('Title', title);
    f.entry.times.update();
    return true;
  }

  remove(ref) {
    const f = this.find(ref);
    if (!f) return false;
    this.db.remove(f.entry); // goes to the KeePass recycle bin, recoverable
    return true;
  }

  // Fingerprints for duplicate checks (hashes of values, never the values)
  fingerprints() {
    const out = [];
    for (const x of this.allEntries()) {
      const d = this.describe(x);
      const hashes = [];
      const pw = x.entry.fields.get('Password');
      if (pw && valueOf(pw)) hashes.push(sha256(valueOf(pw).trim()));
      for (const [, b] of x.entry.binaries) { const data = binaryBytes(b); if (data) hashes.push(sha256(Buffer.from(data))); }
      out.push({ ref: d.ref, hashes });
    }
    return out;
  }
}

function text(entry, key) {
  const v = entry.fields.get(key);
  return v == null ? '' : valueOf(v);
}
function valueOf(v) { return v instanceof kdbxweb.ProtectedValue ? v.getText() : String(v); }
function binaryBytes(b) {
  const v = b && b.value !== undefined ? b.value : b;
  if (!v) return null;
  if (v instanceof kdbxweb.ProtectedValue) return v.getBinary();
  return new Uint8Array(v);
}

module.exports = { Vault, binaryBytes };
