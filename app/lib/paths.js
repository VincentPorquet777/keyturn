'use strict';
// Where Keyturn keeps things. Windows (the desktop app): the vault in Documents\Keyturn, this PC's key in
// %LOCALAPPDATA%\Keyturn. Linux and macOS (server mode, for an assistant on a server): XDG folders.
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
// Server mode: no window on this computer. The owner unlocks from a link their assistant sends them, confirms
// by telling the assistant the code their phone shows, and sees the paper recovery code on their phone.
const HEADLESS = !WIN || process.env.KEYTURN_HEADLESS === '1';

const home = os.homedir();
const xdg = (name, fallback) => process.env[name] || path.join(home, fallback);
const DATA = process.env.KEYTURN_DATA || (WIN ? path.join(home, 'Documents', 'Keyturn') : path.join(xdg('XDG_DATA_HOME', '.local/share'), 'keyturn'));
const LOCAL = process.env.KEYTURN_LOCAL || (WIN ? path.join(process.env.LOCALAPPDATA || home, 'Keyturn') : path.join(xdg('XDG_STATE_HOME', '.local/state'), 'keyturn'));

module.exports = { WIN, HEADLESS, DATA, LOCAL };
