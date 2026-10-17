import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, cssValue } from '../src/tokens.js';
import { css, scss, tailwind3, tailwind4, json } from '../src/formats.js';
import { variablesToTokens, stylesToTokens, rgbaToHex, parseFileKey } from '../src/figma.js';

test('DTCG: references, inherited $type and math', () => {
  const t = load({
    color: { $type: 'color', blue: { $value: '#2563eb' }, primary: { $value: '{color.blue}' } },
    space: { $type: 'dimension', base: { $value: '4px' }, lg: { $value: '{space.base} * 4' }, mix: { $value: '({space.base} + 2px) * 2' } },
  });
  assert.equal(t.get('color.primary').value, '#2563eb');
  assert.equal(t.get('color.primary').type, 'color');
  assert.equal(t.get('space.lg').value, '16px');
  assert.equal(t.get('space.mix').value, '12px');
});

test('missing and circular references throw clear errors', () => {
  assert.throws(() => load({ a: { $value: '{nope}' } }), /Unknown token reference \{nope\}/);
  assert.throws(() => load({ a: { $value: '{b}' }, b: { $value: '{a}' } }), /Circular reference/);
});

test('math leaves non-arithmetic strings alone', () => {
  const t = load({ f: { $type: 'fontFamily', $value: 'Inter, sans-serif' }, d: { $value: 'calc(100% - 4px)' }, e: { $value: 'a-b' } });
  assert.equal(t.get('d').value, 'calc(100% - 4px)');
  assert.equal(t.get('e').value, 'a-b');
});

test('Tokens Studio: sets, unitless sizes, typography and boxShadow', () => {
  const doc = {
    global: {
      space: { sm: { value: 8, type: 'spacing' } },
      h1: { value: { fontFamily: 'Inter Tight', fontWeight: 'Semi Bold', fontSize: 40, lineHeight: '110%' }, type: 'typography' },
      card: { value: [{ x: 0, y: 2, blur: 8, spread: 0, color: 'rgba(0,0,0,.1)', type: 'dropShadow' }, { x: 0, y: 0, blur: 1, spread: 0, color: '#0002', type: 'innerShadow' }], type: 'boxShadow' },
    },
    light: { bg: { value: '#fff', type: 'color' } },
    dark: { bg: { value: '#000', type: 'color' } },
    $metadata: { tokenSetOrder: ['global', 'light', 'dark'] },
  };
  const light = load(doc, { sets: ['global', 'light'] });
  assert.equal(cssValue(light.get('space.sm')), '8px');
  assert.deepEqual(cssValue(light.get('h1')), { 'font-family': '"Inter Tight"', 'font-weight': '600', 'font-size': '40px', 'line-height': '110%' });
  assert.equal(cssValue(light.get('card')), '0 2px 8px 0 rgba(0,0,0,.1), inset 0 0 1px 0 #0002');
  assert.equal(light.get('bg').value, '#fff');
  assert.throws(() => load(doc, { sets: ['nope'] }), /Token set "nope" not found/);
});

test('CSS output: refs as var(), themes only write changed values, dark media query', () => {
  const base = load({ c: { $type: 'color', white: { $value: '#fff' }, black: { $value: '#000' }, bg: { $value: '{c.white}' } } });
  const dark = load({ c: { $type: 'color', white: { $value: '#fff' }, black: { $value: '#000' }, bg: { $value: '{c.black}' } } });
  const out = css(base, { themes: { dark }, prefix: 'ds' });
  assert.match(out, /--ds-c-bg: var\(--ds-c-white\);/);
  assert.match(out, /\[data-theme="dark"\] \{\n  --ds-c-bg: var\(--ds-c-black\);\n\}/);
  assert.match(out, /@media \(prefers-color-scheme: dark\)/);
  assert.equal(out.match(/--ds-c-white/g).length, 2);  // declared once, referenced once
  assert.match(css(base, { refs: false }), /--c-bg: #fff;/);
});

test('typography utility classes and SCSS maps', () => {
  const t = load({ typography: { body: { $type: 'typography', $value: { fontFamily: ['Inter', 'sans-serif'], fontSize: '16px' } } } });
  assert.match(css(t), /\.typo-body \{\n  font-family: var\(--typography-body-font-family\);/);
  assert.match(scss(t), /"font-family": \(Inter, sans-serif\),/);
});

test('Tailwind v3 preset and v4 @theme', () => {
  const t = load({
    colors: { brand: { $type: 'color', $value: '#f97316' } },
    radius: { lg: { $type: 'dimension', $value: '12px' } },
    font: { body: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] } },
  });
  const v3 = tailwind3(t, { prefix: 'ds' });
  assert.match(v3, /"colors": \{\n\s+"brand": "var\(--ds-colors-brand\)"/);
  assert.match(v3, /"borderRadius": \{\n\s+"lg": "var\(--ds-radius-lg\)"/);
  const v4 = tailwind4(t, { prefix: 'ds' });
  assert.match(v4, /@theme inline \{[^}]*--color-brand: var\(--ds-colors-brand\);/);
  assert.match(v4, /--radius-lg: var\(--ds-radius-lg\);/);
  assert.match(v4, /--font-body: var\(--ds-font-body\);/);
  // without a prefix the names match, so values are written directly (no self-reference)
  assert.match(tailwind4(load({ color: { x: { $type: 'color', $value: '#123456' } } })), /@theme \{\n  --color-x: #123456;/);
});

test('flat JSON', () => {
  const t = load({ a: { b: { $type: 'dimension', $value: '2px' } } });
  assert.deepEqual(JSON.parse(json(t)), { 'a-b': '2px' });
});

test('Figma variables -> tokens with aliases and modes', () => {
  const meta = {
    variableCollections: {
      c1: { id: 'c1', name: 'Primitives', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Value' }] },
      c2: { id: 'c2', name: 'Theme', defaultModeId: 'l', modes: [{ modeId: 'l', name: 'Light' }, { modeId: 'd', name: 'Dark' }] },
    },
    variables: {
      v1: { id: 'v1', name: 'gray/0', resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } } },
      v2: { id: 'v2', name: 'gray/900', resolvedType: 'COLOR', variableCollectionId: 'c1', valuesByMode: { m1: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } },
      v3: { id: 'v3', name: 'surface/bg', resolvedType: 'COLOR', variableCollectionId: 'c2', valuesByMode: { l: { type: 'VARIABLE_ALIAS', id: 'v1' }, d: { type: 'VARIABLE_ALIAS', id: 'v2' } } },
      v4: { id: 'v4', name: 'radius/md', resolvedType: 'FLOAT', scopes: ['CORNER_RADIUS'], variableCollectionId: 'c1', valuesByMode: { m1: 8 } },
      v5: { id: 'v5', name: 'hidden', resolvedType: 'FLOAT', hiddenFromPublishing: true, variableCollectionId: 'c1', valuesByMode: { m1: 1 } },
    },
  };
  const trees = variablesToTokens(meta);
  assert.deepEqual(Object.keys(trees), ['default', 'Dark']);
  assert.equal(trees.default.surface.bg.$value, '{gray.0}');
  assert.equal(trees.Dark.surface.bg.$value, '{gray.900}');
  assert.equal(trees.default.radius.md.$value, '8px');
  assert.equal(trees.default.hidden, undefined);
  assert.equal(load(trees.default).get('surface.bg').value, '#ffffff');
});

test('Figma styles -> tokens', () => {
  const styles = [
    { node_id: '1', name: 'Brand/Primary', style_type: 'FILL' },
    { node_id: '2', name: 'Heading/H1', style_type: 'TEXT' },
    { node_id: '3', name: 'Elevation/Card', style_type: 'EFFECT' },
  ];
  const nodes = {
    1: { document: { fills: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0, a: 1 }, opacity: 0.5 }] } },
    2: { document: { style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 32, lineHeightPx: 38.4, lineHeightUnit: 'PIXELS', letterSpacing: -0.5 } } },
    3: { document: { effects: [{ type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 4 }, radius: 12, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.2 } }] } },
  };
  const tree = stylesToTokens(styles, nodes);
  assert.equal(tree.Brand.Primary.$value, '#ff800080');
  const t = load(tree);
  assert.deepEqual(cssValue(t.get('Heading.H1')), { 'font-family': 'Inter', 'font-weight': '700', 'font-size': '32px', 'line-height': '38.4px', 'letter-spacing': '-0.5px' });
  assert.equal(cssValue(t.get('Elevation.Card')), '0px 4px 12px 0px #00000033');
});

test('helpers', () => {
  assert.equal(rgbaToHex({ r: 0, g: 0, b: 0, a: 1 }), '#000000');
  assert.equal(parseFileKey('https://www.figma.com/design/AbC123xyz/My-File?node-id=0-1'), 'AbC123xyz');
  assert.equal(parseFileKey('AbC123xyz'), 'AbC123xyz');
});

test('custom selectors and no dark media query', () => {
  const base = load({ c: { $type: 'color', $value: '#fff' } });
  const dark = load({ c: { $type: 'color', $value: '#000' } });
  const out = css(base, { themes: { dark }, selector: '.preview', themeSelector: '.preview[data-mode="{name}"]', darkMedia: false });
  assert.match(out, /^\.preview \{/m);
  assert.match(out, /\.preview\[data-mode="dark"\] \{\n  --c: #000;/);
  assert.doesNotMatch(out, /prefers-color-scheme/);
});
