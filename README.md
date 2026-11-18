# Keyturn

Your passwords and keys, unlocked with your phone's fingerprint.

Keyturn keeps every secret in one encrypted vault on this PC. To open it you scan a QR code with your phone and touch the fingerprint sensor. The vault opens for a set time (15 minutes, and you can add more), then locks itself again. Your assistant can sort, rename and file your keys while it is open, but it only ever sees their **names**, never the values.

## Everyday use

1. Double-click **Keyturn** on the desktop.
2. Scan the QR code with your phone's camera and confirm with your fingerprint.
3. Check that the four-digit match code on your phone is the same as on the PC.
4. The vault is open. It locks by itself when the timer runs out, or press **Lock now**.

Copying a value puts it on the clipboard for 30 seconds, then clears it.

## First set-up (once)

1. Open Keyturn. It shows a QR code.
2. Scan it with your phone, create the passkey, and confirm with your fingerprint.
3. Keyturn shows a **24-character recovery code**. Write it on paper and keep it somewhere safe. It is the only way in if you lose your phone. Nobody else, including your assistant, ever sees it.
4. To add a second phone later, open the vault and choose **Link another phone** under *Your phones*.

## Where things live

| What | Where |
| --- | --- |
| Encrypted vault | `Documents\Keyturn\` |
| Window profile, tokens, settings | `%LOCALAPPDATA%\Keyturn\` |
| Phone page and relay | `https://keys.aiforge.uk` (sees only encrypted traffic) |
| Local service | `http://127.0.0.1:7457` (this PC only) |

The vault is a standard KeePass (KDBX4) file, so it is not locked into Keyturn. An emergency export of its key, so it can be opened in KeePassXC, is not built yet.

## How it is protected

- Your phone's passkey produces a secret that never leaves the phone unencrypted. It is sent to the PC end to end encrypted (P-256 key exchange, AES-256-GCM). The relay only passes sealed messages along.
- That secret unwraps the vault key. The recovery code unwraps it too, as a backup.
- The vault itself is KDBX4 with Argon2id.
- The local service only answers this PC, and only the Keyturn window and the assistant tool (each with its own token).
- The assistant tool cannot print a value. It can save files into the vault, move, rename, remove, find duplicates, and put a key into a Windows setting or a `.env` file where a program needs it.

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

`source` is a path from your home folder, a full path, `env:NAME` or `dpapi:path`.
