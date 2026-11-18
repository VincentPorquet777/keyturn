# Keyturn

**Your passwords and API keys, opened by your phone's fingerprint, and handled by your AI assistant.**

Keyturn keeps every secret in one encrypted vault on your PC. To open it, scan a code with your phone and touch the fingerprint sensor. It stays open for 15 minutes, then locks itself. While it's open, your AI assistant (Claude Code, Codex, Hermes or any agent with a terminal) can file new keys, sort them, find duplicates and put a key where a program needs it, by name, without printing it.

Download an API key, tell your assistant "put it in Keyturn", touch your fingerprint, done: the key is in the vault and the downloaded file is in the Recycle Bin.

- **Your phone is the key.** A passkey with the fingerprint or face check, nothing to type, no master password to forget or leak.
- **A recovery code on paper is the spare key,** like a crypto wallet's. Lose both and nobody can open it, including us.
- **It's a normal KeePass file** (KDBX 4, Argon2id), so your secrets are never locked into Keyturn.
- **Free and open source** (Apache-2.0). Fully AI-coded: its author hasn't written a line of it by hand.

## Install (Windows 10 or 11)

Open PowerShell and run:

```powershell
irm https://keys.aiforge.uk/install.ps1 | iex
```

It installs Keyturn for your Windows account only (no admin rights), adds **Keyturn** to your desktop and Start menu, and puts the `keyturn` command on your PATH for your assistant. It brings its own copy of Node.js from nodejs.org, so there's nothing else to install, and it checks every download against its fingerprint. Run the same line again to update.

To remove it: Settings > Apps > Keyturn, or `keyturn-uninstall`. Your vault is kept.

Your phone needs Chrome on Android or Safari on iPhone (iOS 18 or later), with a screen lock.

## First set-up (once)

1. Open **Keyturn**. It shows a QR code.
2. Scan it with your phone's camera, tap the link, create the passkey and confirm with your fingerprint.
3. Your phone shows a four-digit code. Check the PC shows the same one and click **Yes, it matches**. If they differ, click **No**: someone else may have scanned your code.
4. Keyturn shows a **24-character recovery code**. Write it on paper, keep it somewhere safe and offline. It is shown once.

## Everyday use

1. Open **Keyturn** (or your assistant asks for it: `keyturn open "why"`).
2. Scan the code with your phone. Before you touch the sensor, check the four-digit code on your phone matches the PC.
3. It's open for 15 minutes (5 to 60, your choice; **+15 min** adds more), then locks itself. **Lock now** locks it straight away.

**Copy** puts a value on the clipboard for 30 seconds, kept out of Windows clipboard history and cloud sync, and clears it when the vault locks.

## For your assistant

Paste this into your assistant's instructions (`CLAUDE.md`, `AGENTS.md`, a Hermes skill…):

```text
Secrets live in Keyturn. Never print, echo or log a secret value.
- keyturn status                       locked or open
- keyturn open "<why>"                 asks me to unlock with my phone; waits up to 3 minutes
- keyturn list                         every key by name (never values)
- keyturn take <group> <title> <file>  file a loose key file (e.g. a download) and move the original to the Recycle Bin
- keyturn add <group> <title> <source> file a key and keep the source (source: path, env:NAME or dpapi:path)
- keyturn import <manifest.json>       file many: [{"group","title","source"}]
- keyturn move/rename/remove ...       tidy up; remove goes to the vault's recycle bin
- keyturn dupes                        keys that hold the same value
- keyturn wire <group/title> NAME [--dotenv <file>]   put a key into a Windows user setting or a .env file
- keyturn lock                         lock when done
```

`wire --dotenv` only writes a file named `.env` or `.env.<name>`, in an existing folder on this PC, and `wire` refuses Windows settings such as `PATH`. `take` refuses `.env` files and SSH keys, because programs read those in place: use `add` for them.

## How it's protected

- Your phone's passkey gives a secret that never leaves the phone unencrypted. It reaches your PC end-to-end encrypted (P-256, AES-256-GCM) through a relay that only passes sealed messages.
- That secret, combined with a second secret kept only on this PC (encrypted by Windows for your account), opens the vault key. A captured phone answer plus copies of your Keyturn files isn't enough on its own.
- The paper recovery code opens the vault key too, on any PC. Its sealed copy is stored inside the vault file itself, so the vault file plus the paper code is all you need to recover.
- **Unlinking a phone or making a new recovery code changes the vault key.** Old backups of the settings file no longer open today's vault with that phone or that code.
- The local service only answers this PC. Each Keyturn window gets a one-time key when it opens, so web pages and other Windows accounts can't use the service.
- Every action is listed in the window as it happens, marked as yours or your assistant's.

## What it doesn't protect against

Please read this part.

- **Programs running as you while the vault is open.** Anything running under your Windows account (your assistant, a script, malware) can reach your keys while the vault is open: by working the Keyturn window, reading the clipboard or the screen, or tampering with Keyturn before your next unlock. "Names only" is how the assistant tool behaves, not a wall around your assistant. Keep the vault locked when you're not using it.
- **Keys you put somewhere.** Once a key is in a `.env` file or a Windows setting, it is plain text there.
- **The phone page.** It's served from keys.aiforge.uk. Whoever controls that site could capture your phone's answer the next time you unlock. That alone doesn't open your vault (the PC secret is also needed), but you are trusting that site.
- **Copies made before a change.** A copy of the vault file made *before* you unlinked a phone still opens with that phone, as it was then. Changing keys can't un-copy data.
- **Losing both your phones and your paper code.** There is no back door.

## Where things live

| What | Where |
| --- | --- |
| Encrypted vault, its settings (`keyturn.json`) and activity log | `Documents\Keyturn\` |
| This PC's secret, window profile, tokens | `%LOCALAPPDATA%\Keyturn\` |
| The program | `%LOCALAPPDATA%\Programs\Keyturn\` |
| Phone page and relay | `https://keys.aiforge.uk` |
| Local service | `http://127.0.0.1:7457` (this PC only) |

Back up `Documents\Keyturn\vault.kdbx`. With it and your paper code you can always get back in, even on a new PC.

## Tests

`node tests/run.cjs` (the security audit: every finding with its proof and fix), `node tests/v2.cjs` (key changes, upgrades, recovery) and `node tests/take.cjs`. They run a separate test copy on port 17457 and never touch your real vault.

## Licence

Apache-2.0. Made by [Ai Forge](https://aiforge.uk).
