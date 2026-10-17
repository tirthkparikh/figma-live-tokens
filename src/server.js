// Live token server: keeps tokens in sync with Figma (or a local file) and pushes
// changes to every open page over Server-Sent Events.
import http from 'node:http';
import { watchFile, unwatchFile } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { loadSource, buildFiles } from './build.js';

const CLIENT = `(() => {
  const script = document.currentScript;
  const base = new URL('.', script.src).href;
  let style = document.getElementById('figma-live-tokens');
  if (!style) {
    style = document.createElement('style');
    style.id = 'figma-live-tokens';
    document.head.appendChild(style);
  }
  let version = 0;
  const apply = (css, v) => {
    if (v && v <= version) return;
    version = v || version;
    style.textContent = css;
    document.dispatchEvent(new CustomEvent('tokens:update', { detail: { version } }));
  };
  fetch(base + 'tokens.css', { cache: 'no-store' }).then(r => r.ok && r.text()).then(css => css && apply(css)).catch(() => {});
  if (!('EventSource' in window)) return;
  const es = new EventSource(base + 'events');
  es.addEventListener('tokens', e => { const d = JSON.parse(e.data); apply(d.css, d.version); });
})();
`;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Create the live server.
 * opts: source options for loadSource (figma/input/themes/sets/token), render options
 * (formats/prefix/refs), interval (s, Figma polling), webhookPasscode, cors, log.
 */
export function createLiveServer(opts = {}) {
  const log = opts.log ?? (() => {});
  const render = {
    formats: [...new Set(['css', 'json', ...(opts.formats ?? [])])], prefix: opts.prefix, refs: opts.refs,
    selector: opts.selector, themeSelector: opts.themeSelector, darkMedia: opts.darkMedia, classes: opts.classes,
  };
  const clients = new Set();
  const state = { files: {}, hash: null, version: 0, updatedAt: null, error: null, count: 0, source: null };
  let running = null, again = false, timer = null, debounce = null;
  const watchers = [];

  const broadcast = () => {
    const msg = `event: tokens\ndata: ${JSON.stringify({ version: state.version, hash: state.hash, css: state.files['tokens.css'] })}\n\n`;
    for (const res of clients) res.write(msg);
  };

  async function refresh(reason = 'manual') {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        const src = await loadSource(opts);
        const built = buildFiles(src, render);
        state.error = null;
        state.source = src.source;
        if (built.hash !== state.hash) {
          Object.assign(state, { files: built.files, hash: built.hash, count: built.count, updatedAt: new Date().toISOString() });
          state.version++;
          log(`tokens v${state.version} (${built.count} tokens, ${reason}) -> ${clients.size} page(s)`);
          broadcast();
        }
      } catch (e) {
        state.error = e.message;
        log(`refresh failed (${reason}): ${e.message}`);
      }
    })();
    await running;
    running = null;
    if (again) { again = false; return refresh('queued'); }
  }

  const soon = reason => { clearTimeout(debounce); debounce = setTimeout(() => refresh(reason), opts.debounce ?? 1500); };

  const cors = res => {
    res.setHeader('Access-Control-Allow-Origin', opts.cors ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  };

  const send = (res, code, body, type = 'application/json') => {
    const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  };

  const readBody = req => new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { fail(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString()));
    req.on('error', fail);
  });

  const TYPES = { css: 'text/css; charset=utf-8', json: 'application/json', js: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8', ts: 'text/plain; charset=utf-8', scss: 'text/x-scss; charset=utf-8' };

  async function handler(req, res) {
    cors(res);
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^.*\/(?=[^/]*$)/, '/');  // works when mounted under a sub-path
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\n\n`);
      if (state.hash) res.write(`event: tokens\ndata: ${JSON.stringify({ version: state.version, hash: state.hash, css: state.files['tokens.css'] })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && path === '/client.js') return send(res, 200, CLIENT, TYPES.js);
    if (req.method === 'GET' && (path === '/' || path === '/status')) {
      return send(res, 200, { ok: !state.error, version: state.version, hash: state.hash, tokens: state.count, updatedAt: state.updatedAt, source: state.source, error: state.error, clients: clients.size, files: Object.keys(state.files) });
    }
    if (req.method === 'GET' && path === '/tokens.json') {
      if (!state.hash) return send(res, 503, { error: state.error ?? 'Tokens not loaded yet.' });
      return send(res, 200, state.files['tokens.flat.json'], TYPES.json);
    }
    if (req.method === 'GET' && state.files[path.slice(1)] != null) {
      const etag = `"${state.hash}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
      res.setHeader('ETag', etag);
      return send(res, 200, state.files[path.slice(1)], TYPES[path.split('.').pop()] ?? 'text/plain');
    }
    if (req.method === 'POST' && path === '/webhook') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
      if (opts.webhookPasscode && !safeEqual(payload.passcode ?? '', opts.webhookPasscode)) return send(res, 401, { error: 'Bad passcode.' });
      if (payload.event_type === 'PING') return send(res, 200, { ok: true });
      soon(`webhook ${payload.event_type ?? ''}`.trim());
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/refresh') {
      if (opts.refreshToken && !safeEqual(req.headers.authorization ?? '', `Bearer ${opts.refreshToken}`)) return send(res, 401, { error: 'Unauthorized.' });
      await refresh('refresh endpoint');
      return send(res, state.error ? 502 : 200, { ok: !state.error, version: state.version, error: state.error });
    }
    send(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => handler(req, res).catch(e => send(res, 500, { error: e.message })));

  return {
    server, handler, state, refresh,
    async start(port = 4100, host = '0.0.0.0') {
      await refresh('startup');
      if (opts.figma && opts.interval !== 0) {
        const every = Math.max(10, opts.interval ?? 30) * 1000;
        timer = setInterval(() => refresh('poll'), every);
      }
      if (!opts.figma && opts.input) {
        const files = [opts.input, ...Object.values(opts.themes ?? {}).filter(s => !s.startsWith('sets:')).map(s => resolve(dirname(opts.input), s))];
        for (const f of files) { watchFile(f, { interval: 400 }, () => soon('file changed')); watchers.push(f); }
      }
      await new Promise(ok => server.listen(port, host, ok));
      return server.address();
    },
    async stop() {
      clearInterval(timer); clearTimeout(debounce); watchers.forEach(f => unwatchFile(f));
      for (const res of clients) res.end();
      clients.clear();
      await new Promise(ok => server.close(ok));
    },
  };
}
