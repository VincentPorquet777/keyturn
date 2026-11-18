'use strict';
// Windows plumbing. Secret values only travel through stdin/stdout of child processes, never argv or logs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function ps(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true, env: { ...process.env, ...(env || {}) },
    });
    const out = []; const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('PowerShell step failed' + (err.length ? ': ' + Buffer.concat(err).toString().split('\n')[0].slice(0, 100) : '')));
      resolve(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.end(input == null ? '' : input, 'utf8');
  });
}

const UTF8 = '[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false;';

function resolveHome(rel) {
  const p = rel.replace(/\//g, path.sep);
  return path.isAbsolute(p) ? p : path.join(os.homedir(), p);
}

// source: "relative\\path" (from the user's home), "C:\\abs\\path", "env:NAME" or "dpapi:relative\\path"
async function readSource(source) {
  if (/^env:/i.test(source)) {
    const name = source.slice(4);
    let value = process.env[name];
    if (!value) value = (await ps(`${UTF8}$v=[Environment]::GetEnvironmentVariable($env:KT_NAME,'User'); if($v){[Console]::Out.Write($v)}`, '', { KT_NAME: name })) || undefined;
    return value ? { value, label: `Windows setting ${name}` } : null;
  }
  if (/^dpapi:/i.test(source)) {
    const file = resolveHome(source.slice(6));
    if (!fs.existsSync(file)) return null;
    const value = await ps(`${UTF8}$s=ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $env:KT_FILE).Trim()); $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}`, '', { KT_FILE: file });
    return { value, label: file };
  }
  const file = resolveHome(source);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  const data = fs.readFileSync(file);
  if (data.length > 5 * 1024 * 1024) throw new Error('File over 5 MB');
  const text = data.toString('utf8');
  const single = !data.includes(0) && text.trim().length > 0 && text.trim().length <= 2000 && !text.trim().includes('\n');
  return { file: { name: path.basename(file), data }, value: single ? text.trim() : undefined, label: file };
}

async function setUserEnv(name, value) {
  await ps(`${UTF8}[Environment]::SetEnvironmentVariable($env:KT_NAME, [Console]::In.ReadToEnd(), 'User')`, value, { KT_NAME: name });
}

function quote(v) {
  if (/^[A-Za-z0-9_\-.:/@+=,]*$/.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
async function writeDotenv(file, name, value) {
  const f = path.resolve(file);
  if (!fs.existsSync(path.dirname(f))) throw new Error('Folder does not exist');
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/) : [];
  const line = `${name}=${quote(value)}`;
  const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  if (i >= 0) lines[i] = line; else { if (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push(line, ''); }
  const tmp = f + '.keyturn-tmp';
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, f);
}

const setClipboard = (v) => ps(`${UTF8}$v=[Console]::In.ReadToEnd(); if($v){Set-Clipboard -Value $v}else{Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::Clear()}`, v);
const getClipboard = () => ps(`${UTF8}$c=Get-Clipboard -Raw; if($c){[Console]::Out.Write($c)}`, '');

module.exports = { readSource, setUserEnv, writeDotenv, setClipboard, getClipboard };
