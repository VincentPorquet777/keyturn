// Keyturn relay: a short-lived meeting point between a PC and a phone.
// It only ever carries end-to-end encrypted messages (the PC's key is in the QR code, never here),
// keeps nothing on disk, and every channel closes itself after five minutes.
import { DurableObject } from 'cloudflare:workers';

const CH = /^\/api\/ch\/([A-Za-z0-9_-]{22})(\/ws|\/hello)?$/;
const CHANNEL_TTL_MS = 5 * 60 * 1000;
const PHONE_WAIT_MS = 25 * 1000;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(CH);
    if (m) {
      if (req.method === 'POST') {
        const origin = req.headers.get('origin');
        if (origin && origin !== url.origin) return json({ ok: false, message: 'Wrong origin' }, 403);
      }
      return env.CHANNEL.get(env.CHANNEL.idFromName(m[1])).fetch(req);
    }
    if (url.pathname === '/api/health') return json({ ok: true });
    return json({ ok: false, message: 'Not found' }, 404);
  },
};

export class Channel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pc = null;
    this.waiting = null; // resolver for the phone's request
    this.attempts = 0;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/ws')) return this.connectPc(req);
    if (url.pathname.endsWith('/hello')) {
      if (req.method !== 'POST') return json({ ok: false }, 405);
      if (!this.pc) return json({ ok: false, message: 'expired' }, 410);
      this.sendPc({ type: 'hello' });
      return json({ ok: true });
    }
    if (req.method !== 'POST') return json({ ok: false }, 405);
    return this.fromPhone(req);
  }

  async connectPc(req) {
    if (req.headers.get('upgrade') !== 'websocket') return json({ ok: false, message: 'Expected websocket' }, 426);
    if (this.pc) return json({ ok: false, message: 'Channel in use' }, 409);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.pc = server;
    server.addEventListener('message', (ev) => this.fromPc(ev.data));
    server.addEventListener('close', () => this.closed());
    server.addEventListener('error', () => this.closed());
    await this.ctx.storage.setAlarm(Date.now() + CHANNEL_TTL_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async fromPhone(req) {
    if (!this.pc) return json({ ok: false, message: 'expired' }, 410);
    if (this.waiting) return json({ ok: false, message: 'busy' }, 409);
    if (++this.attempts > 5) return json({ ok: false, message: 'Too many attempts. Start again on your PC.' }, 429);
    const text = await req.text();
    if (text.length > 4096) return json({ ok: false, message: 'Too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ ok: false, message: 'Bad request' }, 400); }
    if (!body || typeof body.pub !== 'string' || typeof body.iv !== 'string' || typeof body.ct !== 'string') return json({ ok: false, message: 'Bad request' }, 400);

    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting = null; resolve({ ok: false, message: 'Your PC did not answer. Check it is still showing the code.' }); }, PHONE_WAIT_MS);
      this.waiting = (r) => { clearTimeout(timer); this.waiting = null; resolve(r); };
      this.sendPc({ type: 'payload', pub: body.pub, iv: body.iv, ct: body.ct });
    });
    return json(reply, 200);
  }

  fromPc(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'result' && this.waiting) {
      this.waiting({ ok: !!msg.ok, message: String(msg.message || '').slice(0, 200), detail: String(msg.detail || '').slice(0, 200) });
    }
  }

  sendPc(obj) { try { this.pc && this.pc.send(JSON.stringify(obj)); } catch { /* closed */ } }

  closed() {
    this.pc = null;
    if (this.waiting) this.waiting({ ok: false, message: 'Your PC closed the request.' });
  }

  async alarm() {
    try { this.pc && this.pc.close(1000, 'expired'); } catch { /* ignore */ }
    this.closed();
    await this.ctx.storage.deleteAll();
  }
}
