# Keyturn

Your passwords and keys, unlocked with your phone's fingerprint.

Keyturn keeps every secret in one encrypted vault on this PC. To open it you scan a QR code with your phone and touch the fingerprint sensor. The vault opens for a set time (15 minutes, and you can add more), then locks itself again. Your assistant can sort, rename and file your keys while it is open, but it only ever sees their **names**, never the values.

## Everyday use

1. Double-click **Keyturn** on the desktop.
2. Scan the QR code with your phone's camera and confirm with your fingerprint.
3. Before you touch the sensor, check that the four-digit match code on your phone is the same as on the PC. Only scan codes your own PC is showing you, and never open a Keyturn link someone sends you.
4. The vault is open. It locks by itself when the timer runs out, or press **Lock now**.

Copying a value puts it on the clipboard for 30 seconds, then clears it (also when the vault locks). Keyturn keeps copied values out of Windows clipboard history and cloud clipboard, but while a value is on the clipboard any program on this PC can read it.

## First set-up (once)

1. Open Keyturn. It shows a QR code.
2. Scan it with your phone, create the passkey, and confirm with your fingerprint.
3. Your phone shows a four-digit code. Check the PC shows the same code and click **Yes, it matches**. If the codes differ, click **No**: someone else may have scanned your QR code.
4. Keyturn shows a **24-character recovery code**. Write it on paper and keep it somewhere safe. It is the only way in if you lose your phone. Nobody else, including your assistant, ever sees it.
5. To add a second phone later, open the vault and choose **Link another phone** under *Your phones*, then check the code the same way.

## Where things live

| What | Where |
| --- | --- |
| Encrypted vault, its settings (`keyturn.json`) and activity log | `Documents\Keyturn\` (often synced to OneDrive) |
| Window profile, tokens, settings | `%LOCALAPPDATA%\Keyturn\` |
| Phone page and relay | `https://keys.aiforge.uk` (sees only encrypted traffic) |
| Local service | `http://127.0.0.1:7457` (this PC only) |

The vault is a standard KeePass (KDBX4) file, so it is not locked into Keyturn. An emergency export of its key, so it can be opened in KeePassXC, is not built yet.

## How it is protected

- Your phone's passkey produces a secret that never leaves the phone unencrypted. It is sent to the PC end to end encrypted (P-256 key exchange, AES-256-GCM). The relay only passes sealed messages along.
- That secret unwraps the vault key. The recovery code unwraps it too, as a backup. The vault itself is KDBX4 with Argon2id.
- A copy of the vault files on its own is useless: opening it needs your phone or your recovery code.
- The local service only answers this PC. Each Keyturn window gets a one-time key when it opens; web pages and other Windows accounts on this PC can't use the service.
- The assistant tool cannot print a value. It can save files into the vault, move, rename, remove, find duplicates, and put a key into a Windows setting or a `.env` file where a program needs it.

## What it does not protect against

- **Programs running as you while the vault is open.** Any program running under your Windows account (your assistant, a script, or malware) can get your keys while the vault is open, for example by working the Keyturn window, or by reading the clipboard or the screen. Such a program can also change Keyturn itself so that it leaks your keys the next time you unlock. "Names only" is how the assistant tool behaves. It is not a wall around your assistant. Only give your assistant a vault you would trust it with.
- **Keys you put somewhere.** Once a key is in a `.env` file or a Windows setting, it is plain text there, and any program running as you, including your assistant, can read it.
- **The phone page.** The relay can't read your messages, but the phone page's code comes from keys.aiforge.uk. Whoever controls that site could capture your passkey secret the next time you unlock. With a copy of your Keyturn files, that opens the vault.
- **Old copies of `keyturn.json`.** Unlinking a phone or making a new recovery code stops it working with the current `keyturn.json`. But an older copy (a backup, or OneDrive's version history) together with that phone or old code still opens the vault, because the vault key itself doesn't change.
- **Losing `keyturn.json`.** The recovery code works only together with `keyturn.json`. Back up `keyturn.json` along with `vault.kdbx`.

## For your assistant

```
node app\keyturn.js status
node app\keyturn.js open "Why I need it"   # shows you the unlock window; waits for your fingerprint
node app\keyturn.js list
node app\keyturn.js import <manifest.json> # [{ "group", "title", "source" }]
node app\keyturn.js dupes
node app\keyturn.js wire "<group>/<title>" NAME [--dotenv <file>]
node app\keyturn.js lock
```

`source` is a path from your home folder, a full path, `env:NAME` or `dpapi:path`. `wire --dotenv` only writes a file named `.env` or `.env.<name>` in an existing folder on this PC, and `wire` won't write over Windows settings such as `PATH`.
