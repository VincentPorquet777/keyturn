// Keyturn phone page. Opened from the QR code on the PC.
// Link format: #v1.<mode e|u>.<channel>.<pc public key>.<prf salt>.<pc name>.<minutes>[.s]
// ".s" = server mode: the link came from the owner's assistant, not a QR code on a PC screen.
// The phone never receives a password. It only proves "it's me" with a fingerprint and
// sends the passkey's PRF output, encrypted to the PC's one-time key.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const screen = $('screen');
  const te = new TextEncoder();
  const b64u = {
    enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
  };
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  const ICON = {
    pc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke-linecap="round"/></svg>',
    finger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 6.8A7.5 7.5 0 0 1 19.5 12v1.5M4.5 10.5A7.5 7.5 0 0 0 4.5 12v2M8 20c.9-1.6 1.5-3.6 1.5-6a2.5 2.5 0 0 1 5 0c0 2-.3 4-1 5.6M12 14c0 3-.8 5.3-2.2 7M17.3 16.5c-.2 1.3-.5 2.5-1 3.6"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5" stroke-linecap="round"/></svg>',
  };

  function show(state, { title, sub, facts = [], button, onClick, fine = '', quiet = false } = {}) {
    screen.dataset.state = state;
    $('title').textContent = title || '';
    $('sub').innerHTML = sub || '';
    $('facts').innerHTML = facts.map(([icon, text]) => `<li>${ICON[icon] || ''}<span>${text}</span></li>`).join('');
    const go = $('go');
    go.hidden = !button;
    go.disabled = false;
    go.classList.toggle('quiet', quiet);
    if (button) {
      go.innerHTML = (quiet ? '' : ICON.finger) + `<span>${button}</span>`;
      go.onclick = async () => { go.disabled = true; try { await onClick(); } catch (e) { fail(e); } };
    }
    $('fine').textContent = fine;
    for (const el of [$('title'), $('sub'), $('facts')]) { el.classList.remove('fade-in'); void el.offsetWidth; el.classList.add('fade-in'); }
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function parse() {
    const parts = location.hash.slice(1).split('.');
    if (parts[0] !== 'v1' || parts.length < 7) return null;
    const [, mode, ch, pub, salt, name, mins, flags] = parts;
    if (!/^[eu]$/.test(mode) || !/^[A-Za-z0-9_-]{22}$/.test(ch)) return null;
    return { mode, ch, pub, salt, name: decodeURIComponent(name || 'your PC').slice(0, 40), mins: Math.max(1, Math.min(240, +mins || 15)), server: flags === 's' };
  }

  async function matchCode(p) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(p.ch + '.' + p.pub)));
    const n = ((h[0] << 8) | h[1]) % 10000;
    return String(n).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1 $2');
  }

  class KtError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

  // One key exchange per scanned code. When linking a phone, the match code comes from it, and the PC shows
  // that code only after this phone has answered: someone who merely saw the QR code can't produce the same one.
  async function prepare(p) {
    if (p.shared) return;
    const pcKey = await crypto.subtle.importKey('raw', b64u.dec(p.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    p.eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    p.shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pcKey }, p.eph.privateKey, 256);
  }

  async function linkCode(p) {
    await prepare(p);
    const hk = await crypto.subtle.importKey('raw', p.shared, 'HKDF', false, ['deriveBits']);
    const v = new DataView(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(p.ch), info: te.encode('keyturn match v2') }, hk, 32));
    return String(v.getUint32(0) % 10000).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1 $2');
  }

  async function seal(p, payload) {
    await prepare(p);
    const hk = await crypto.subtle.importKey('raw', p.shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(p.ch), info: te.encode('keyturn channel v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(p.ch) }, key, te.encode(JSON.stringify(payload)));
    return { pub: b64u.enc(await crypto.subtle.exportKey('raw', p.eph.publicKey)), iv: b64u.enc(iv), ct: b64u.enc(ct) };
  }

  // Server mode: the PC seals the paper recovery code to this phone with the same key exchange, so the relay
  // can't read it. (Same derivation as sealReply() in app/lib/kcrypto.js.)
  async function openReply(p, sealed) {
    await prepare(p);
    const [iv, ct] = String(sealed).split('.');
    const hk = await crypto.subtle.importKey('raw', p.shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(p.ch), info: te.encode('keyturn reply v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(iv), additionalData: te.encode(p.ch + '.reply') }, key, b64u.dec(ct));
    return new TextDecoder().decode(plain);
  }

  async function send(p, payload, workingTitle) {
    show('sending', { title: workingTitle || 'Talking to your PC…', sub: `Keep this page open for a moment.` });
    const body = await seal(p, payload);
    let r;
    try {
      r = await fetch(`/api/ch/${p.ch}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch { throw new KtError('network'); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 410) throw new KtError('expired');
    if (!r.ok && !j.message) throw new KtError('hiccup');
    if (!r.ok || !j.ok) throw new KtError('pc', j.message);
    return j;
  }

  function prfOf(cred) {
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    return { enabled: ext.prf && ext.prf.enabled, first: ext.prf && ext.prf.results && ext.prf.results.first };
  }

  const userCancelled = (e) => e && (e.name === 'NotAllowedError' || e.name === 'AbortError');

  async function doUnlock(p) {
    show('working', { title: 'Touch the sensor', sub: 'Confirm it’s you with your fingerprint or face.' });
    let cred;
    try {
      cred = await navigator.credentials.get({
        publicKey: {
          challenge: rand(32), rpId: location.hostname, userVerification: 'required', timeout: 60000,
          extensions: { prf: { eval: { first: b64u.dec(p.salt) } } },
        },
      });
    } catch (e) { throw userCancelled(e) ? new KtError('cancelled') : e; }
    const prf = prfOf(cred);
    if (!prf.first) throw new KtError('noprf');
    const j = await send(p, { t: 'unlock', cred: b64u.enc(cred.rawId), prf: b64u.enc(prf.first) }, 'Unlocking…');
    done('Unlocked', `<b>${esc(p.name)}</b> is open${j.detail ? ' ' + esc(j.detail) : ` for ${p.mins} minutes`}. You can put your phone away.`);
  }

  async function doEnroll(p) {
    show('working', { title: 'Create your passkey', sub: 'Your phone will ask for your fingerprint or face.' });
    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          rp: { id: location.hostname, name: 'Keyturn' },
          user: { id: rand(16), name: `${p.name} keys`, displayName: `Keyturn · ${p.name}` },
          challenge: rand(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required', authenticatorAttachment: 'platform' },
          timeout: 90000,
          hints: ['client-device'],
          extensions: { prf: { eval: { first: b64u.dec(p.salt) } } },
        },
      });
    } catch (e) { throw userCancelled(e) ? new KtError('cancelled') : e; }
    const prf = prfOf(cred);
    if (prf.first) return finishEnroll(p, cred.rawId, prf.first);
    if (prf.enabled === false) throw new KtError('noprf');
    // Some phones only release the PRF value on a sign-in, so ask for one more touch.
    show('ready', {
      title: 'One more touch',
      sub: 'Your passkey is saved. Touch the sensor once more to link it to your PC.',
      button: 'Finish linking',
      onClick: async () => {
        show('working', { title: 'Touch the sensor', sub: 'Last step.' });
        let a;
        try {
          a = await navigator.credentials.get({
            publicKey: {
              challenge: rand(32), rpId: location.hostname, userVerification: 'required', timeout: 60000,
              allowCredentials: [{ type: 'public-key', id: cred.rawId }],
              extensions: { prf: { eval: { first: b64u.dec(p.salt) } } },
            },
          });
        } catch (e) { throw userCancelled(e) ? new KtError('cancelled') : e; }
        const second = prfOf(a);
        if (!second.first) throw new KtError('noprf');
        await finishEnroll(p, cred.rawId, second.first);
      },
    });
  }

  async function finishEnroll(p, rawId, first) {
    const j = await send(p, { t: 'enroll', cred: b64u.enc(rawId), prf: b64u.enc(first), device: deviceName() }, p.server ? 'Linking…' : 'Linking to your PC…');
    if (j.detail === 'tell' || String(j.detail).startsWith('tell.')) {
      const last = () => done('Last step', `Tell your assistant this code: <b class="code">${esc(p.code)}</b><br>That finishes linking this phone to <b>${esc(p.name)}</b>.`);
      if (j.detail === 'tell') return last();
      const code = await openReply(p, j.detail.slice(5));
      history.replaceState(null, '', location.pathname);
      return show('ready', {
        title: 'Your recovery code',
        sub: `<span class="rcode">${esc(code)}</span>Write it on paper now. It is shown once, and it is the only way back in if you lose this phone. Don’t screenshot it or send it to anyone, your assistant included.`,
        button: 'I’ve written it down',
        quiet: true,
        onClick: async () => last(),
      });
    }
    if (j.detail === 'confirm') return done('Now check your PC', `If <b>${esc(p.name)}</b> shows <b>${esc(p.code)}</b>, click <b>Yes, it matches</b> there. If it shows a different code, click <b>No</b>.`);
    done('This phone is your key', `Finish on <b>${esc(p.name)}</b>: it’s showing your recovery code.`);
  }

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    return m ? m[1].trim().slice(0, 30) : (/Android/.test(ua) ? 'Android phone' : 'Phone');
  }

  function done(title, sub) {
    show('done', { title, sub });
    if (navigator.vibrate) navigator.vibrate([18, 60, 28]);
    history.replaceState(null, '', location.pathname);
  }

  let current = null;
  function fail(e) {
    const p = current;
    const retry = () => start(p);
    const code = e && e.code;
    if (code === 'expired') return show('error', { title: 'This code has expired', sub: 'Start again on your PC to get a fresh code. Codes last a few minutes.' });
    if (code === 'cancelled') return show('ready', { title: 'Cancelled', sub: 'Nothing was changed.', button: 'Try again', onClick: retry });
    if (code === 'noprf') return show('error', { title: 'This browser can’t do it yet', sub: 'Open this page in <b>Chrome</b> on Android or <b>Safari</b> on iPhone (iOS 18 or later), with a screen lock set up.' });
    if (code === 'hiccup') return show('ready', { title: 'That didn’t go through', sub: 'The connection dropped for a moment. Nothing was changed.', button: 'Try again', onClick: retry });
    if (code === 'network') return show('ready', { title: 'No connection', sub: 'Check your phone is online, then try again.', button: 'Try again', onClick: retry });
    if (code === 'pc') return show('error', { title: 'Your PC said no', sub: esc(e.message || 'Something did not match.') + ' Start again on your PC.' });
    console.error(e);
    return show('ready', { title: 'Something went wrong', sub: esc((e && e.message) || 'Please try again.'), button: 'Try again', onClick: retry });
  }

  async function start(p) {
    current = p;
    const code = p.mode === 'u' ? await matchCode(p) : await linkCode(p);
    p.code = code;
    $('matchCode').textContent = code;
    $('matchText').textContent = !p.server ? 'Check your PC shows' : p.mode === 'u' ? 'Your assistant’s message says' : 'Your code:';
    $('match').hidden = false;
    fetch(`/api/ch/${p.ch}/hello`, { method: 'POST' }).then((r) => { if (r.status === 410) fail(new KtError('expired')); }).catch(() => {});
    if (p.mode === 'u') {
      show('ready', {
        title: 'Unlock your keys',
        sub: `on <b>${esc(p.name)}</b>`,
        facts: [
          ['clock', `Opens for ${p.mins} minutes, then locks itself`],
          ['shield', p.server ? `Your keys stay on ${esc(p.name)}. Nothing secret comes to this phone` : 'Your passwords stay on your PC. Nothing secret comes to this phone'],
          ['pc', 'Only you can approve this, with your fingerprint or face'],
        ],
        button: 'Unlock with fingerprint',
        onClick: () => doUnlock(p),
        fine: 'Didn’t start this yourself? Just close this page.',
      });
    } else {
      show('ready', {
        title: 'Make this phone your key',
        sub: `for <b>${esc(p.name)}</b>`,
        facts: [
          ['key', 'Your phone saves a passkey, locked by your fingerprint or face'],
          ['shield', 'Your fingerprint never leaves this phone'],
          ['note', p.server ? 'This phone then shows your recovery code once, for paper, in case you lose it' : 'Your PC then shows a recovery code, in case you lose this phone'],
        ],
        button: 'Create my passkey',
        onClick: () => doEnroll(p),
      });
    }
  }

  function landing() {
    $('match').hidden = true;
    show('idle', {
      title: 'Your keys, opened by your fingerprint',
      sub: 'Open Keyturn on your computer and scan the code it shows with this phone’s camera.',
      facts: [
        ['shield', 'Passwords stay encrypted on your computer'],
        ['finger', 'Your phone is the key: a fingerprint opens them for a few minutes'],
        ['clock', 'Everything locks again by itself'],
      ],
    });
  }

  if (!window.PublicKeyCredential || !crypto.subtle) { show('error', { title: 'This browser can’t do it yet', sub: 'Open this page in Chrome on Android or Safari on iPhone.' }); return; }
  const p = parse();
  if (p) start(p).catch(fail); else landing();
  window.addEventListener('hashchange', () => { const q = parse(); if (q) start(q).catch(fail); });
})();
