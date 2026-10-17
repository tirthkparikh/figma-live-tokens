import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLiveServer } from '../src/server.js';
import { pull } from '../src/figma.js';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../bin/cli.js');

// Read SSE "tokens" events from the live server.
function subscribe(url) {
  const events = [];
  let wake;
  const req = http.get(url, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = raw.match(/^event: (.+)$/m)?.[1], data = raw.match(/^data: (.+)$/m)?.[1];
        if (ev === 'tokens') { events.push(JSON.parse(data)); wake?.(); }
      }
    });
  });
  return {
    events,
    next: (n, ms = 5000) => new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`timed out waiting for event ${n}`)), ms);
      const check = () => { if (events.length >= n) { clearTimeout(t); ok(events[n - 1]); } else wake = check; };
      check();
    }),
    close: () => req.destroy(),
  };
}

test('live server pushes new CSS when the tokens file changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flt-'));
  const file = join(dir, 'tokens.json');
  await writeFile(file, JSON.stringify({ color: { bg: { $type: 'color', $value: '#ffffff' } } }));
  const live = createLiveServer({ input: file, debounce: 50 });
  const { port } = await live.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const sse = subscribe(`${base}/events`);
    const first = await sse.next(1);
    assert.match(first.css, /--color-bg: #ffffff;/);

    const cssRes = await fetch(`${base}/tokens.css`);
    assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8');
    const etag = cssRes.headers.get('etag');
    assert.equal((await fetch(`${base}/tokens.css`, { headers: { 'If-None-Match': etag } })).status, 304);

    await writeFile(file, JSON.stringify({ color: { bg: { $type: 'color', $value: '#0f172a' } } }));
    const second = await sse.next(2, 8000);
    assert.match(second.css, /--color-bg: #0f172a;/);
    assert.equal(second.version, first.version + 1);

    const client = await (await fetch(`${base}/client.js`)).text();
    assert.match(client, /new EventSource\(base \+ 'events'\)/);
    assert.deepEqual(await (await fetch(`${base}/tokens.json`)).json(), { 'color-bg': '#0f172a' });
    sse.close();
  } finally {
    await live.stop();
  }
});

test('broken tokens keep serving the last good CSS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flt-'));
  const file = join(dir, 'tokens.json');
  await writeFile(file, JSON.stringify({ a: { $type: 'color', $value: '#111111' } }));
  const live = createLiveServer({ input: file });
  const { port } = await live.start(0, '127.0.0.1');
  try {
    await writeFile(file, '{ not json');
    await live.refresh('test');
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(status.ok, false);
    assert.match(status.error, /Couldn't read/);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/tokens.css`)).text(), /#111111/);
  } finally {
    await live.stop();
  }
});

// A fake Figma API: variables endpoint returns 403 (non-Enterprise plan) so we fall back to styles.
async function fakeFigma({ variables }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-figma-token'] });
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/v1/files/KEY/variables/local')) return variables ? send(200, { meta: variables }) : send(403, { status: 403, err: 'Limited by Figma plan' });
    if (req.url === '/v1/files/KEY/styles') return send(200, { meta: { styles: [{ node_id: '1:2', name: 'Brand / Primary', style_type: 'FILL' }] } });
    if (req.url.startsWith('/v1/files/KEY/nodes')) return send(200, { nodes: { '1:2': { document: { fills: [{ type: 'SOLID', color: { r: 0.76, g: 0.25, b: 0.05, a: 1 } }] } } } });
    send(404, { err: 'not found' });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  process.env.FIGMA_API_URL = `http://127.0.0.1:${server.address().port}`;
  return { seen, close: () => new Promise(ok => server.close(ok)) };
}

test('pull falls back to styles when variables are not available', async () => {
  const api = await fakeFigma({ variables: null });
  try {
    const res = await pull({ file: 'https://www.figma.com/design/KEY/Site', token: 'figd_test' });
    assert.equal(res.source, 'styles');
    assert.equal(res.default.Brand.Primary.$value, '#c2400d');
    assert.ok(api.seen.every(r => r.token === 'figd_test'));
  } finally { await api.close(); }
});

test('pull uses variables (and modes) when available; webhook triggers a refresh', async () => {
  const meta = {
    variableCollections: { c: { id: 'c', name: 'Theme', defaultModeId: 'l', modes: [{ modeId: 'l', name: 'Light' }, { modeId: 'd', name: 'Dark' }] } },
    variables: { v: { id: 'v', name: 'bg', resolvedType: 'COLOR', variableCollectionId: 'c', valuesByMode: { l: { r: 1, g: 1, b: 1, a: 1 }, d: { r: 0, g: 0, b: 0, a: 1 } } } },
  };
  const api = await fakeFigma({ variables: meta });
  const live = createLiveServer({ figma: 'KEY', token: 't', interval: 0, webhookPasscode: 'secret', debounce: 20 });
  const { port } = await live.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const css = await (await fetch(`${base}/tokens.css`)).text();
    assert.match(css, /--bg: #ffffff;/);
    assert.match(css, /\[data-theme="dark"\] \{\n  --bg: #000000;/);

    const bad = await fetch(`${base}/webhook`, { method: 'POST', body: JSON.stringify({ passcode: 'wrong', event_type: 'FILE_UPDATE' }) });
    assert.equal(bad.status, 401);
    const before = api.seen.length;
    const good = await fetch(`${base}/webhook`, { method: 'POST', body: JSON.stringify({ passcode: 'secret', event_type: 'LIBRARY_PUBLISH' }) });
    assert.equal(good.status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(api.seen.length > before, 'webhook should re-pull from Figma');
  } finally {
    await live.stop();
    await api.close();
  }
});

test('CLI build writes files and reports errors with exit code 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flt-'));
  await writeFile(join(dir, 'tokens.json'), JSON.stringify({ space: { m: { $type: 'dimension', $value: '12px' } } }));
  const { stdout } = await run(process.execPath, [CLI, 'build', 'tokens.json', '-f', 'css,tailwind4', '--prefix', 'ui', '-o', 'out'], { cwd: dir });
  assert.match(stdout, /1 tokens/);
  assert.match(await readFile(join(dir, 'out/tokens.css'), 'utf8'), /--ui-space-m: 12px;/);
  assert.match(await readFile(join(dir, 'out/tailwind.theme.css'), 'utf8'), /--spacing-m: var\(--ui-space-m\);/);
  await assert.rejects(run(process.execPath, [CLI, 'build', 'missing.json'], { cwd: dir }), e => e.code === 1 && /File not found/.test(e.stderr));
  await assert.rejects(run(process.execPath, [CLI, 'build', 'tokens.json', '-f', 'xml'], { cwd: dir }), e => /Unknown format "xml"/.test(e.stderr));
});
