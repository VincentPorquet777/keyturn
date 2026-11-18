(() => {
  'use strict';
  let TOKEN = null; // window key, traded once for this window's one-time link (#k=...) and kept for reloads
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  let S = null;
  let current = '';
  let query = '';

  const I = {
    finger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 6.8A7.5 7.5 0 0 1 19.5 12v1.5M4.5 10.5A7.5 7.5 0 0 0 4.5 12v2M8 20c.9-1.6 1.5-3.6 1.5-6a2.5 2.5 0 0 1 5 0c0 2-.3 4-1 5.6M12 14c0 3-.8 5.3-2.2 7M17.3 16.5c-.2 1.3-.5 2.5-1 3.6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 5.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h.5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="6.5" y="2.5" width="11" height="19" rx="2.8"/><path d="M11 18.5h2"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke-linecap="round"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
    check: '✓',
  };

  const emblem = (cls = '') => `
    <div class="emblem ${cls}"><div class="halo"></div>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7DCA4"/><stop offset=".55" stop-color="#E7B45A"/><stop offset="1" stop-color="#B9832F"/></linearGradient>
          <linearGradient id="mintg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B5F2D8"/><stop offset=".55" stop-color="#5ED6A6"/><stop offset="1" stop-color="#2E9C73"/></linearGradient>
        </defs>
        <circle class="disc" cx="32" cy="32" r="30" fill="url(#brass)"/>
        <circle cx="32" cy="32" r="30" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width=".8"/>
        <g class="turn"><circle cx="32" cy="32" r="19.5" fill="#0C1016"/><circle cx="32" cy="28" r="5.2" fill="#E7B45A"/><path d="M29.3 31.2h5.4l1.7 11.4h-8.8z" fill="#E7B45A"/></g>
      </svg></div>`;

  const shortPath = (u) => {
    const m = String(u).match(/^(.*?)( \([^)]*\))?$/);
    const parts = m[1].split(/[\\/]/);
    return (parts.length > 2 ? '…\\' + parts.slice(-2).join('\\') : m[1]) + (m[2] || '');
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function ago(t) {
    if (!t) return 'never';
    const d = new Date(t); const days = Math.floor((Date.now() - d) / 86400000);
    if (days < 1 && d.getDate() === new Date().getDate()) return `today ${hhmm(t)}`;
    if (days < 2) return `yesterday ${hhmm(t)}`;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  async function act(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-keyturn-ui': TOKEN }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  }
  async function run(path, body, okMsg) {
    try { const j = await act(path, body); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(j) : okMsg); return j; } catch (e) { toast(e.message); return null; }
  }
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

  // ---------- views ----------
  function requestBanner() {
    if (!S.request) return '';
    return `<div class="alert info fade">${I.spark}<div><b>Your assistant asked to open your keys.</b> ${esc(S.request.reason)}
      <button class="link" data-act="dismiss" style="margin-left:6px">Not now</button></div></div>`;
  }

  function vWelcome() {
    if (S.vaultOnly) return `<section class="locked center fade">
      ${emblem()}
      <p class="eyebrow">Your vault is here</p>
      <h1>Open it with your recovery code</h1>
      <p class="lead">Keyturn’s settings file is missing, but your vault is safe. Type your recovery code to open it, then link your phone again.</p>
      <button class="btn primary lg" data-act="recovery">${I.shield} Use my recovery code</button>
    </section>`;
    return `<section class="welcome center fade">
      <div>
        <p class="eyebrow">Welcome</p>
        <h1>Your keys, opened by your fingerprint.</h1>
        <p class="lead">Keyturn keeps your passwords, keys and secret files encrypted on this computer. Your phone becomes the key: scan, touch, and they open for a few minutes, then lock again by themselves.</p>
        <ol class="steps3">
          <li><span><b>Scan</b> a code with your phone’s camera</span></li>
          <li><span><b>Touch</b> your fingerprint to create a passkey</span></li>
          <li><span><b>Save</b> a recovery code, in case you lose your phone</span></li>
        </ol>
        <button class="btn primary lg" data-act="setup">${I.phone} Set up with my phone</button>
        <p class="fine">Works with Android (Chrome) and iPhone (iOS 18 or later). Your fingerprint never leaves your phone.</p>
      </div>
      <div class="welcome-art"><div class="orbit"><span class="dot"></span><span class="dot b"></span>${emblem()}</div></div>
    </section>`;
  }

  function vConfirm(p, title) {
    return `<section class="recovery center fade">
      <div class="badge">${I.phone}</div>
      <p class="eyebrow">${esc(title)}</p>
      <h1>Does your phone show this code?</h1>
      <div class="code">${String(p.code).split(' ').map((g) => `<span>${esc(g)}</span>`).join('')}</div>
      <p class="lead">Only say yes if your phone shows exactly the same code. If it doesn’t, someone else may have scanned your QR code: choose No and start again.</p>
      <div class="row" style="justify-content:center"><button class="btn ghost" data-act="cancel">No, cancel</button><button class="btn primary" data-act="confirmlink">Yes, it matches</button></div>
    </section>`;
  }

  function vPair() {
    const p = S.pending;
    const unlock = p.kind === 'unlock';
    if (p.status === 'confirm') return vConfirm(p, { enroll: 'Link your phone', addphone: 'Link another phone' }[p.kind]);
    const order = ['connecting', 'waiting', 'phone', 'verifying', 'done'];
    const at = order.indexOf(p.status);
    const step = (n) => (at < 0 ? '' : n === 1 ? (at >= 2 ? 'done' : 'now') : n === 2 ? (at >= 4 ? 'done' : at >= 2 ? 'now' : '') : at >= 4 ? 'done' : '');
    const dead = p.status === 'expired' || p.status === 'offline';
    const title = { unlock: 'Unlock with your phone', enroll: 'Link your phone', addphone: 'Link another phone' }[p.kind];
    return `<section class="pair center fade">
      <div class="qr-card">
        <div class="qr ${dead ? 'dim' : ''}" data-url="${esc(p.url)}">${p.qr}<img class="qr-mark" src="/mark.svg" alt=""></div>
        <div class="qr-foot">${dead ? 'This code has stopped working' : `Code works for <b data-until="${p.expiresAt}">${mmss(p.expiresAt - Date.now())}</b>`}</div>
      </div>
      <div>
        ${requestBanner()}
        <p class="eyebrow">${esc(title)}</p>
        <h1>Scan this code with your phone</h1>
        <p class="lead">Open your phone’s camera, point it at the code and tap the link that appears.</p>
        ${p.error ? `<div class="alert err">${I.alert}<div>${esc(p.error)}</div></div>` : ''}
        <ol class="live">
          <li class="${step(1)}"><span class="ic">${step(1) === 'done' ? '✓' : '1'}</span><b>Scan the code</b><small>Your phone opens keys.aiforge.uk</small></li>
          <li class="${step(2)}"><span class="ic">${step(2) === 'done' ? '✓' : '2'}</span><b>${unlock ? 'Touch your fingerprint' : 'Create your passkey'}</b><small>${unlock ? `Check your phone shows <code>${esc(p.code)}</code>` : 'Your phone shows a code; you’ll check it here next'}</small></li>
          <li class="${step(3)}"><span class="ic">${step(3) === 'done' ? '✓' : '3'}</span><b>${unlock ? `Open for ${S.minutes} minutes` : 'Linked'}</b><small>${unlock ? 'Then it locks itself' : 'Next: your recovery code'}</small></li>
        </ol>
        <div class="row">
          ${dead ? `<button class="btn primary" data-act="${p.kind === 'enroll' ? 'setup' : p.kind}">Get a new code</button>` : ''}
          <button class="btn ghost" data-act="cancel">Cancel</button>
        </div>
      </div>
    </section>`;
  }

  function vRecovery() {
    const groups = S.recovery.split('-');
    return `<section class="recovery center fade">
      <div class="badge">${I.shield}</div>
      <p class="eyebrow">Last step</p>
      <h1>Save your recovery code</h1>
      <p class="lead">If you lose your phone, this code is the only other way in. Write it down and keep it somewhere safe and offline. It won’t be shown again.</p>
      <div class="code">${groups.map((g) => `<span>${esc(g)}</span>`).join('')}</div>
      <div class="row" style="justify-content:center"><button class="btn ghost sm" data-act="print">Print it</button></div>
      <label class="check"><input type="checkbox" id="saved"> I’ve written it down somewhere safe</label><br>
      <button class="btn primary lg" data-act="ack" id="ackBtn" disabled>Continue</button>
    </section>`;
  }

  function vLocked() {
    const s = S.summary;
    const stats = s ? `${s.keys} key${s.keys === 1 ? '' : 's'} in ${s.groups.length} group${s.groups.length === 1 ? '' : 's'} · last opened ${ago(S.lastOpened)}` : 'Your vault is ready';
    return `<section class="locked center fade">
      ${requestBanner()}
      ${emblem()}
      <p class="eyebrow">Locked</p>
      <h1>Your keys are locked</h1>
      <p class="lead">${esc(stats)}</p>
      <button class="btn primary lg" data-act="unlock">${I.finger} Unlock with my phone</button>
      <button class="link" data-act="recovery" style="margin-top:14px">Lost your phone? Use your recovery code</button>
    </section>`;
  }

  function vOpen() {
    return `<section class="open fade">
      <div class="hero-open">
        <div class="ring">
          <svg class="track" viewBox="0 0 96 96"><circle class="bg" cx="48" cy="48" r="44" fill="none" stroke-width="5"/><circle class="fg" id="ringFg" cx="48" cy="48" r="44" fill="none" stroke-width="5" stroke-dasharray="276.5" stroke-dashoffset="0"/></svg>
          ${emblem('open')}
        </div>
        <div>
          <p class="eyebrow mint">Open</p>
          <h1><span id="left">${mmss(S.expiresAt - Date.now())}</span> left</h1>
          <p class="lead" id="locksAt">Locks itself at ${hhmm(S.expiresAt)}. Everything done while it’s open is listed on the right.</p>
        </div>
        <div class="row hero-actions">
          <button class="btn ghost" data-act="extend">+15 min</button>
          <button class="btn primary" data-act="lock">${I.lock} Lock now</button>
        </div>
      </div>
      <div class="cols">
        <div class="panel">
          <div class="panel-head">
            <h2>Keys <span class="count" id="keyCount"></span></h2>
            <label class="search">${I.search}<input id="q" placeholder="Search keys" autocomplete="off" spellcheck="false"></label>
          </div>
          <div id="keyList"></div>
        </div>
        <aside class="side">
          <div class="panel"><h2>This session</h2><ul class="feed" id="feed"></ul></div>
          <div class="panel"><h2>Your phones</h2><ul class="devices" id="devices"></ul>
            <button class="btn ghost sm" data-act="addphone">${I.phone} Link another phone</button></div>
          <div class="panel"><h2>Stay open for</h2>
            <div class="seg" id="seg">${[5, 15, 30, 60].map((m) => `<button data-min="${m}">${m} min</button>`).join('')}</div>
            <p class="sub">Each unlock lasts this long.</p></div>
          <div class="panel"><h2>Recovery code</h2>
            ${S.paperCheck ? `<div class="alert info">${I.shield}<div><b>One last step for the security update.</b> Type your recovery code once, so it also opens your vault from the vault file alone.</div></div>
            <button class="btn primary sm" data-act="papercheck">Type my recovery code</button>`
            : `<p class="sub">Your paper backup if you lose your phone. <button class="link" data-act="papercheck">Check my recovery code</button> · <button class="link" data-act="newrecovery">Make a new one</button></p>`}</div>
        </aside>
      </div>
    </section>`;
  }

  function fillOpen() {
    const list = $('keyList');
    if (!list) return;
    const q = query.trim().toLowerCase();
    const items = S.entries.filter((e) => !q || (e.title + ' ' + e.group + ' ' + e.files.map((f) => f.name).join(' ')).toLowerCase().includes(q));
    $('keyCount').textContent = S.entries.length;
    if (!S.entries.length) {
      list.innerHTML = `<div class="empty">${I.key}<div><b>No keys yet</b></div><div>Your assistant can gather them for you while this is open.</div></div>`;
    } else if (!items.length) {
      list.innerHTML = `<div class="empty">Nothing matches “${esc(query)}”.</div>`;
    } else {
      const groups = new Map();
      for (const e of items.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title))) {
        if (!groups.has(e.group)) groups.set(e.group, []);
        groups.get(e.group).push(e);
      }
      list.innerHTML = [...groups].map(([g, es]) => `<div class="group"><div class="group-h">${esc(g || 'Other')} <span>· ${es.length}</span></div>${es.map(entryRow).join('')}</div>`).join('');
    }
    $('feed').innerHTML = S.log.length ? S.log.map(feedRow).join('') : '<li><span class="what" style="grid-column:1/-1;color:var(--faint)">Nothing yet.</span></li>';
    $('devices').innerHTML = S.devices.map((d) => `<li>${I.phone}<div class="dn"><b>${esc(d.name)}</b><small>${d.upgraded ? `Linked ${ago(d.created)} · used ${ago(d.lastUsed)}` : 'Unlock once with this phone to finish its update'}</small></div>
      <button class="icon-btn" title="Unlink ${esc(d.name)}" data-act="unlink" data-id="${esc(d.id)}" data-name="${esc(d.name)}">${I.x}</button></li>`).join('');
    for (const b of $('seg').children) b.classList.toggle('on', +b.dataset.min === S.minutes);
  }

  function entryRow(e) {
    const isFile = !e.hasPassword && e.files.length;
    const tags = [
      ...e.files.map((f) => `<span class="tag">${esc(f.name)}</span>`),
      ...e.usedIn.map((u) => `<span class="tag used" title="${esc(u)}">in ${esc(shortPath(u))}</span>`),
    ].join('');
    return `<div class="entry"><div class="ei ${isFile ? 'file' : ''}">${isFile ? I.file : I.key}</div>
      <div style="min-width:0"><div class="t">${esc(e.title)}</div><div class="m">${tags || '<span>Saved</span>'}</div></div>
      ${e.hasPassword ? `<button class="btn ghost sm" data-act="copy" data-ref="${esc(e.ref)}">${I.copy} Copy</button>` : '<span></span>'}</div>`;
  }

  function feedRow(l) {
    const who = { you: 'You', assistant: 'Assistant', system: 'Keyturn' }[l.who] || l.who;
    const names = l.names && l.names.length ? `<div class="names">${esc(l.names.slice(0, 3).join(', '))}${l.names.length > 3 ? ` and ${l.names.length - 3} more` : ''}</div>` : '';
    return `<li><span class="who ${esc(l.who)}">${esc(who)}</span><div><span class="what">${esc(l.action)}</span><time>${hhmm(l.time)}</time>${names}</div></li>`;
  }

  function render() {
    if (!S) return;
    $('pcName').textContent = S.pc;
    const pill = $('pill');
    pill.className = 'pill ' + (S.locked ? 'is-locked' : 'is-open');
    pill.textContent = !S.setup ? 'Not set up' : S.locked ? 'Locked' : 'Open';
    const name = S.recovery ? 'recovery' : S.pending ? 'pair:' + S.pending.status + ':' + (S.pending.error || '') + ':' + S.pending.expiresAt : !S.setup ? 'welcome:' + !!S.vaultOnly : S.locked ? 'locked:' + !!S.request : 'open:' + !!S.paperCheck;
    if (name !== current) {
      const kind = name.split(':')[0];
      view.innerHTML = { recovery: vRecovery, pair: vPair, welcome: vWelcome, locked: vLocked, open: vOpen }[kind]();
      current = name;
      if (kind === 'open') { const q = $('q'); q.value = query; q.oninput = () => { query = q.value; fillOpen(); }; }
      if (kind === 'recovery') $('saved').onchange = (ev) => { $('ackBtn').disabled = !ev.target.checked; };
    }
    if (current.startsWith('open')) fillOpen();
    tick();
  }

  function tick() {
    if (!S) return;
    for (const el of document.querySelectorAll('[data-until]')) el.textContent = mmss(+el.dataset.until - Date.now());
    if (current.startsWith('open') && S.expiresAt) {
      const left = S.expiresAt - Date.now();
      const el = $('left'); if (el) el.textContent = mmss(left);
      const total = S.minutes * 60000;
      const fg = $('ringFg'); if (fg) fg.style.strokeDashoffset = String(276.5 * (1 - Math.max(0, Math.min(1, left / Math.max(total, left)))));
      const la = $('locksAt'); if (la) la.textContent = `Locks itself at ${hhmm(S.expiresAt)}. Everything done while it’s open is listed on the right.`;
      document.title = `Keyturn · open ${mmss(left)}`;
    } else document.title = 'Keyturn';
  }
  setInterval(tick, 1000);

  // ---------- dialogs ----------
  function recoveryDialog(check) {
    const d = $('dlg');
    d.innerHTML = `<form method="dialog"><h2>${check ? 'Check your recovery code' : 'Use your recovery code'}</h2><p>${check ? 'Type the 24-character code from your paper. Keyturn checks it opens this vault.' : 'Type the 24-character code you saved when you set up Keyturn.'}</p>
      <input class="codein" id="codein" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" maxlength="29">
      <div class="err" id="codeErr"></div>
      <div class="row"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn primary" id="codeGo" value="go">${check ? 'Check' : 'Unlock'}</button></div></form>`;
    const input = $('codein');
    input.oninput = () => {
      const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
      input.value = raw.match(/.{1,4}/g)?.join('-') || '';
    };
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('codeGo').click(); } }; // Enter = the main button, not Cancel
    d.querySelector('form').onsubmit = async (ev) => {
      if (ev.submitter && ev.submitter.value === 'cancel') return;
      ev.preventDefault();
      $('codeGo').disabled = true; $('codeErr').textContent = 'Checking…';
      try { await act(check ? '/api/recovery/check' : '/api/recovery/unlock', { code: input.value }); d.close(); toast(check ? 'Your recovery code works' : 'Unlocked with your recovery code'); }
      catch (e) { $('codeErr').textContent = e.message; $('codeGo').disabled = false; }
    };
    d.showModal();
    input.focus();
  }

  function confirmDialog(title, text, okLabel, onOk) {
    const d = $('dlg');
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" value="ok">${esc(okLabel)}</button></div></form>`;
    d.querySelector('form').onsubmit = (ev) => { if (ev.submitter && ev.submitter.value === 'ok') onOk(); };
    d.showModal();
  }

  // ---------- events ----------
  document.addEventListener('click', (ev) => {
    const seg = ev.target.closest('[data-min]');
    if (seg) return run('/api/settings', { minutes: +seg.dataset.min }, `Each unlock now lasts ${seg.dataset.min} minutes`);
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'setup') run('/api/setup');
    else if (a === 'unlock') run('/api/unlock');
    else if (a === 'addphone') run('/api/addphone');
    else if (a === 'cancel') run('/api/cancel');
    else if (a === 'lock') run('/api/lock', null, 'Locked');
    else if (a === 'extend') run('/api/extend', null, '15 more minutes');
    else if (a === 'dismiss') run('/api/dismiss-request');
    else if (a === 'recovery') recoveryDialog(false);
    else if (a === 'papercheck') recoveryDialog(true);
    else if (a === 'print') window.print();
    else if (a === 'ack') run('/api/recovery/ack', null, 'You’re all set');
    else if (a === 'confirmlink') run('/api/link/confirm', null, 'Phone linked');
    else if (a === 'copy') run('/api/copy', { ref: b.dataset.ref }, 'Copied. Clears from the clipboard in 30 seconds');
    else if (a === 'newrecovery') confirmDialog('Make a new recovery code?', 'Your old code stops working straight away, even with old backups. Keyturn shows the new one once, so have paper ready.', 'Make new code', () => run('/api/recovery/new'));
    else if (a === 'unlink') confirmDialog(`Unlink ${b.dataset.name}?`, 'That phone will no longer open your keys, even from old backups. Your other phones keep working, and you can link it again later.', 'Unlink', () => run('/api/device/remove', { id: b.dataset.id }, 'Phone unlinked'));
  });

  function connect() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
    es.onmessage = (m) => { S = JSON.parse(m.data); render(); };
    es.onerror = async () => {
      es.close();
      const r = await fetch('/api/ping', { headers: { 'x-keyturn-ui': TOKEN } }).catch(() => null);
      if (r && r.status === 401) { try { sessionStorage.removeItem('kt'); } catch { /* ignore */ } return shut('Keyturn closed this window. Open Keyturn again from its icon.'); }
      setTimeout(connect, 1500);
    };
  }
  async function windowKey() {
    const m = location.hash.match(/^#k=([A-Za-z0-9_-]+)$/);
    if (m) {
      history.replaceState(null, '', location.pathname);
      const r = await fetch('/api/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: m[1] }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'This window could not connect. Open Keyturn again from its icon.');
      try { sessionStorage.setItem('kt', j.token); } catch { /* ignore */ }
      return j.token;
    }
    let t = null;
    try { t = sessionStorage.getItem('kt'); } catch { /* ignore */ }
    if (t) return t;
    throw new Error('Open Keyturn from its desktop icon.');
  }
  function shut(msg) {
    view.innerHTML = `<section class="locked center fade">${emblem()}<p class="eyebrow">Keyturn</p><h1>This window isn’t connected</h1><p class="lead">${esc(msg)}</p></section>`;
  }
  windowKey().then((t) => { TOKEN = t; connect(); }).catch((e) => shut(e.message));
})();
