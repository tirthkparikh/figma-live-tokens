import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, cssValue } from '../src/tokens.js';
import { render } from '../src/formats.js';
import { createLiveServer } from '../src/server.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Tokens Studio numeric strings get px', () => {
  const t = load({ size: { base: { value: '4', type: 'sizing' } }, radius: { sm: { value: '2', type: 'borderRadius' } },
    shadow: { card: { value: { x: '0', y: '4', blur: '8', spread: '0', color: '#0002' }, type: 'boxShadow' } },
    border: { b: { value: { width: '1', style: 'solid', color: '#000' }, type: 'border' } },
    lh: { body: { value: '24', type: 'lineHeights' }, ratio: { value: '1.5', type: 'lineHeights' } } });
  assert.equal(cssValue(t.get('size.base')), '4px');
  assert.equal(cssValue(t.get('radius.sm')), '2px');
  assert.equal(cssValue(t.get('shadow.card')), '0 4px 8px 0 #0002');
  assert.equal(cssValue(t.get('border.b')), '1px solid #000');
  assert.equal(cssValue(t.get('lh.body')), '24px');
  assert.equal(cssValue(t.get('lh.ratio')), '1.5');
});

test('unsafe values and colliding names are rejected', () => {
  const bad = load({ c: { x: { $value: 'red; } body { display:none', $type: 'color' } } });
  assert.throws(() => render(bad), /unsafe CSS value/);
  const dup = load({ dup: { a: { $value: '1px', $type: 'dimension' } }, 'dup-a': { $value: '2px', $type: 'dimension' } });
  assert.throws(() => render(dup), /both become --dup-a/);
  assert.throws(() => render(load({ c: { '!!!': { $value: '#fff', $type: 'color' } } })), /no letters or digits/);
  assert.match(render(load({ c: { 日本: { $value: '#fff', $type: 'color' } } }))['tokens.css'], /--c-日本: #fff/);
  assert.throws(() => load(null), /JSON object/);
});

test('server: no prototype keys, 400 on null webhook body', async () => {
  const input = join(mkdtempSync(join(tmpdir(), 'flt-')), 'tokens.json');
  writeFileSync(input, JSON.stringify({ c: { a: { $value: '#fff', $type: 'color' } } }));
  const live = createLiveServer({ input, formats: ['css'], log: () => {} });
  const { port } = await live.start(0, '127.0.0.1');
  try {
    const u = p => `http://127.0.0.1:${port}${p}`;
    for (const p of ['/constructor', '/__proto__', '/toString']) assert.equal((await fetch(u(p))).status, 404, p);
    assert.equal((await fetch(u('/webhook'), { method: 'POST', body: 'null' })).status, 400);
    assert.equal((await fetch(u('/tokens.css'), { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(u('/status')).then(r => r.json())).source, undefined);
  } finally { await live.stop(); }
});

test('Tailwind names drop a repeated category word; blur gets its own bucket', () => {
  const t = load({
    'Card Shadow': { $type: 'shadow', $value: { offsetX: '0px', offsetY: '2px', blur: '4px', spread: '0px', color: '#0003' } },
    Modal: { BackdropBlur: { $type: 'dimension', $value: '15px' } },
  });
  const tw = render(t, { formats: ['tailwind4'] })['tailwind.theme.css'];
  assert.match(tw, /--shadow-card: var\(--card-shadow\)/);
  assert.match(tw, /--blur-modal-backdrop: var\(--modal-backdrop-blur\)/);
});

test('Figma: style nodes are only downloaded when a style changed; 429 Retry-After is reported', async () => {
  const { pull } = await import('../src/figma.js');
  const http = await import('node:http');
  let nodesCalls = 0, updated = '2026-01-01', limited = false;
  const srv = http.createServer((req, res) => {
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (limited) return json(429, { status: 429, err: 'Rate limit exceeded' }, { 'Retry-After': '7200', 'X-Figma-Rate-Limit-Type': 'low' });
    if (req.url.includes('/variables/local')) return json(403, { message: 'Forbidden' });
    if (req.url.includes('/styles')) return json(200, { meta: { styles: [{ node_id: '1', name: 'Brand/Primary', style_type: 'FILL', updated_at: updated }] } });
    if (req.url.includes('/nodes')) { nodesCalls++; return json(200, { nodes: { 1: { document: { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] } } } }); }
    json(404, {});
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  process.env.FIGMA_API_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cache = {};
    await pull({ file: 'abc', token: 't', cache });
    await pull({ file: 'abc', token: 't', cache });
    assert.equal(nodesCalls, 1, 'unchanged styles must not re-download nodes');
    updated = '2026-02-02';
    await pull({ file: 'abc', token: 't', cache });
    assert.equal(nodesCalls, 2);
    limited = true;
    await assert.rejects(pull({ file: 'abc', token: 't', cache }), e => e.retryAfter === 7200 && /low-limit seat/.test(e.message) && /2\.0 hours/.test(e.message));
  } finally { delete process.env.FIGMA_API_URL; srv.close(); }
});

test('names from real Figma files: separators and $ prefixes collapse to single dashes', async () => {
  const { stylesToTokens } = await import('../src/figma.js');
  const tree = stylesToTokens(
    [{ node_id: '1', name: 'Selected - Inner/Border bottom', style_type: 'FILL' }, { node_id: '2', name: '$ui-03 border', style_type: 'FILL' }],
    { 1: { document: { fills: [{ type: 'SOLID', color: { r: 0, g: 0.38, b: 1, a: 1 } }] } }, 2: { document: { fills: [{ type: 'SOLID', color: { r: 0.88, g: 0.88, b: 0.88, a: 1 } }] } } },
  );
  const css = render(load(tree))['tokens.css'];
  assert.match(css, /--selected-inner-border-bottom: #0061ff/);
  assert.match(css, /--ui-03-border: #e0e0e0/);
});
