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
