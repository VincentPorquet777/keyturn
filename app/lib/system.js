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
    if (!value && process.platform === 'win32') value = (await ps(`${UTF8}$v=[Environment]::GetEnvironmentVariable($env:KT_NAME,'User'); if($v){[Console]::Out.Write($v)}`, '', { KT_NAME: name })) || undefined;
    return value ? { value, label: process.platform === 'win32' ? `Windows setting ${name}` : `environment ${name}` } : null;
  }
  if (/^dpapi:/i.test(source)) {
    if (process.platform !== 'win32') throw new Error('dpapi: sources only exist on Windows');
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

// Names a key must never be written over: Windows and tool settings that would break or change how programs start.
const PROTECTED_ENV = new Set(['PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'PSMODULEPATH', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'ONEDRIVE', 'PROMPT',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'PERL5OPT', 'RUBYOPT',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'DOTNET_STARTUP_HOOKS', 'COR_ENABLE_PROFILING', 'COR_PROFILER', 'COR_PROFILER_PATH',
  'CORECLR_ENABLE_PROFILING', 'CORECLR_PROFILER', 'CORECLR_PROFILER_PATH', 'KEYTURN_PORT', 'KEYTURN_DATA', 'KEYTURN_LOCAL', 'KEYTURN_RELAY']);
function checkEnvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name || '')) throw new Error('Bad variable name');
  if (PROTECTED_ENV.has(String(name).toUpperCase())) throw new Error(`${name} is a Windows or tool setting; choose another name`);
  return name;
}

async function setUserEnv(name, value) {
  checkEnvName(name);
  if (process.platform !== 'win32') throw new Error('On this computer a key can only go into a .env file: add --dotenv <file>');
  await ps(`${UTF8}[Environment]::SetEnvironmentVariable($env:KT_NAME, [Console]::In.ReadToEnd(), 'User')`, value, { KT_NAME: name });
}

function quote(v) {
  if (/^[A-Za-z0-9_\-.:/@+=,]*$/.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
// Where a key may be written as a .env line: a file called .env or .env.<something>, in an existing folder
// on this PC (no network paths, so a value can't be sent to another computer), outside Keyturn's own folders.
function dotenvTarget(file, forbiddenDirs = []) {
  const f = path.resolve(String(file || ''));
  const unc = (p) => /^[\\/]{2}/.test(p);
  if (unc(String(file || '')) || unc(f)) throw new Error('The .env file must be on this PC, not a network path');
  const base = path.basename(f);
  if (!/^\.env(\.[A-Za-z0-9_-]{1,40})?$/.test(base)) throw new Error('Only a file named .env or .env.<name> can be written');
  let dir;
  try { dir = fs.realpathSync.native(path.dirname(f)); } catch { throw new Error('Folder does not exist'); }
  if (unc(dir)) throw new Error('The .env file must be on this PC, not a network path');
  const low = (p) => path.resolve(p).toLowerCase() + path.sep;
  for (const d of forbiddenDirs) {
    let real = d; try { real = fs.realpathSync.native(d); } catch { /* not there yet */ }
    if (low(dir).startsWith(low(real)) || low(dir).startsWith(low(d))) throw new Error("Not inside Keyturn's own folders");
  }
  const target = path.join(dir, base);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('That .env is a link to somewhere else');
  return target;
}

async function writeDotenv(file, name, value, forbiddenDirs = []) {
  const f = dotenvTarget(file, forbiddenDirs);
  checkEnvName(name);
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/) : [];
  const line = `${name}=${quote(value)}`;
  const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  if (i >= 0) lines[i] = line; else { if (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push(line, ''); }
  const tmp = f + '.keyturn-tmp';
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, f);
}

// Copied values are marked so Windows keeps them out of clipboard history (Win+V), cloud clipboard sync and clipboard monitors.
const setClipboard = (v) => process.platform !== 'win32' ? Promise.reject(new Error('No clipboard on this computer')) : ps(`${UTF8}Add-Type -AssemblyName System.Windows.Forms; $v=[Console]::In.ReadToEnd(); if($v){
  $d=New-Object Windows.Forms.DataObject; $d.SetData([Windows.Forms.DataFormats]::UnicodeText, $v)
  foreach($f in 'ExcludeClipboardContentFromMonitorProcessing','CanIncludeInClipboardHistory','CanUploadToCloudClipboard'){ $d.SetData($f, (New-Object IO.MemoryStream(,[byte[]](0,0,0,0)))) }
  [Windows.Forms.Clipboard]::SetDataObject($d, $true, 10, 50)
}else{ [Windows.Forms.Clipboard]::Clear() }`, v);
// Move a file to the Recycle Bin (recoverable), never a hard delete.
async function recycle(file) {
  if (process.platform !== 'win32') {
    // The freedesktop Trash (what Linux file managers use); recoverable, never a hard delete.
    const trash = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Trash');
    fs.mkdirSync(path.join(trash, 'files'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(trash, 'info'), { recursive: true, mode: 0o700 });
    let name = path.basename(file);
    for (let i = 2; fs.existsSync(path.join(trash, 'files', name)); i++) name = `${path.basename(file)}.${i}`;
    fs.writeFileSync(path.join(trash, 'info', name + '.trashinfo'), `[Trash Info]
Path=${encodeURI(file)}
DeletionDate=${new Date().toISOString().slice(0, 19)}
`);
    fs.renameSync(file, path.join(trash, 'files', name));
    return;
  }
  await ps(`${UTF8}Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:KT_FILE, 'OnlyErrorDialogs', 'SendToRecycleBin')`, '', { KT_FILE: file });
}

// A 32-byte secret that never leaves this PC. On Windows it is kept encrypted by Windows itself (DPAPI, your
// account on this PC only), in Keyturn's local folder, which OneDrive does not sync.
async function pcSecret(file, create) {
  const win = process.platform === 'win32';
  if (fs.existsSync(file)) {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (!win) return Buffer.from(stored, 'base64');
    const out = await ps(`${UTF8}Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')))`, stored);
    const s = Buffer.from(out.trim(), 'base64');
    if (s.length !== 32) throw new Error('This PC’s Keyturn secret is damaged');
    return s;
  }
  if (!create) return null;
  const s = require('crypto').randomBytes(32);
  const stored = win
    ? (await ps(`${UTF8}Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')))`, s.toString('base64'))).trim()
    : s.toString('base64');
  fs.writeFileSync(file, stored, { mode: 0o600 });
  return s;
}

const getClipboard = () => process.platform !== 'win32' ? Promise.resolve('') : ps(`${UTF8}$c=Get-Clipboard -Raw; if($c){[Console]::Out.Write($c)}`, '');

module.exports = { readSource, setUserEnv, writeDotenv, dotenvTarget, checkEnvName, setClipboard, getClipboard, pcSecret, recycle };
