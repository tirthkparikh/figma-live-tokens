// Parse design tokens (W3C DTCG or Tokens Studio JSON), resolve references and math,
// and turn each token into a CSS-ready value.

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Tokens Studio stores unitless numbers for these; CSS needs px.
const PX_TYPES = new Set(['dimension', 'sizing', 'spacing', 'borderRadius', 'borderWidth', 'fontSizes',
  'fontSize', 'paragraphSpacing', 'letterSpacing', 'paragraphIndent']);

const TYPE_ALIASES = {
  boxShadow: 'shadow', fontFamilies: 'fontFamily', fontWeights: 'fontWeight', fontSizes: 'dimension',
  lineHeights: 'lineHeight', sizing: 'dimension', spacing: 'dimension', borderRadius: 'dimension',
  borderWidth: 'dimension', opacity: 'number', letterSpacing: 'dimension', paragraphSpacing: 'dimension',
};

function isToken(node) {
  if (!isObj(node)) return false;
  if ('$value' in node) return true;
  // Tokens Studio: { value, type }; value may itself be an object (typography, shadow)
  return 'value' in node && ('type' in node || !isObj(node.value) || Object.keys(node).every(k => ['value', 'type', 'description'].includes(k)));
}

/** Pick which top-level sets to use from a Tokens Studio multi-set file. */
export function selectSets(doc, sets) {
  const meta = doc.$metadata;
  const names = Object.keys(doc).filter(k => !k.startsWith('$'));
  const looksMultiSet = meta?.tokenSetOrder || (sets && sets.length);
  if (!looksMultiSet) return doc;
  const order = sets && sets.length ? sets : meta.tokenSetOrder.filter(n => names.includes(n));
  const merged = {};
  for (const name of order) {
    if (!(name in doc)) throw new Error(`Token set "${name}" not found. Available: ${names.join(', ')}`);
    deepMerge(merged, doc[name]);
  }
  return merged;
}

function deepMerge(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (isObj(v) && !isToken(v) && isObj(into[k]) && !isToken(into[k])) deepMerge(into[k], v);
    else into[k] = structuredClone(v);
  }
  return into;
}

/** Flatten a token tree into a Map of "a.b.c" -> { path, type, value, description }. */
export function flatten(tree) {
  const out = new Map();
  const walk = (node, path, inheritedType) => {
    const groupType = node.$type ?? inheritedType;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !isObj(child)) continue;
      const p = [...path, key];
      if (isToken(child)) {
        const raw = '$value' in child ? child.$value : child.value;
        const type = child.$type ?? child.type ?? groupType;
        out.set(p.join('.'), { path: p, type, rawType: type, value: raw, description: child.$description ?? child.description });
      } else {
        walk(child, p, groupType);
      }
    }
  };
  walk(tree, [], undefined);
  return out;
}

const REF_RE = /\{([^{}]+)\}/g;

/** Resolve {references} and simple math in place. Throws on missing or circular references. */
export function resolve(tokens) {
  const done = new Map();
  const visit = (key, stack) => {
    if (done.has(key)) return done.get(key);
    const tok = tokens.get(key);
    if (!tok) throw new Error(`Unknown token reference {${key}}${stack.length ? ` (used by ${stack.at(-1)})` : ''}`);
    if (stack.includes(key)) throw new Error(`Circular reference: ${[...stack, key].join(' -> ')}`);
    const resolved = deepResolve(tok.value, ref => {
      const target = visit(ref, [...stack, key]);
      if (!tok.type && target.type) tok.type = target.type;
      return target.value;
    });
    tok.value = resolved;
    done.set(key, tok);
    return tok;
  };
  for (const tok of tokens.values()) tok.original = structuredClone(tok.value);
  for (const key of tokens.keys()) visit(key, []);
  return tokens;
}

function deepResolve(value, lookup) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{([^{}]+)\}$/);
    if (whole) return structuredClone(lookup(whole[1].trim()));
    if (!value.includes('{')) return maybeMath(value);
    const replaced = value.replace(REF_RE, (_, ref) => {
      const v = lookup(ref.trim());
      if (isObj(v) || Array.isArray(v)) throw new Error(`Can't embed composite token {${ref}} inside "${value}"`);
      return String(v);
    });
    return maybeMath(replaced);
  }
  if (Array.isArray(value)) return value.map(v => deepResolve(v, lookup));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepResolve(v, lookup)]));
  return value;
}

// "16px * 1.5" -> "24px", "(4 + 4) * 2" -> 16. Anything that isn't plain arithmetic is left alone.
const MATH_RE = /^[\s\d.+\-*/()a-z%]+$/i;
function maybeMath(str) {
  if (!/[+*/]|\s-\s/.test(str) || !MATH_RE.test(str)) return str;
  const units = new Set();
  const expr = str.replace(/(\d*\.?\d+)\s*(px|rem|em|%|vh|vw|ms|s|deg)?/gi, (_, n, u) => { if (u) units.add(u.toLowerCase()); return n; });
  if (units.size > 1 || /[a-z]/i.test(expr)) return str;
  let result;
  try { result = evalArithmetic(expr); } catch { return str; }
  if (!Number.isFinite(result)) return str;
  const rounded = Math.round(result * 1e4) / 1e4;
  return units.size ? `${rounded}${[...units][0]}` : rounded;
}

// Tiny recursive-descent evaluator: numbers, + - * /, unary minus, parentheses. No eval().
function evalArithmetic(src) {
  const toks = src.match(/\d*\.?\d+|[+\-*/()]/g) ?? [];
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const factor = () => {
    const t = next();
    if (t === '-') return -factor();
    if (t === '(') { const v = sum(); if (next() !== ')') throw new Error('paren'); return v; }
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error('nan');
    return n;
  };
  const product = () => { let v = factor(); while (peek() === '*' || peek() === '/') v = next() === '*' ? v * factor() : v / factor(); return v; };
  const sum = () => { let v = product(); while (peek() === '+' || peek() === '-') v = next() === '+' ? v + product() : v - product(); return v; };
  const v = sum();
  if (i !== toks.length) throw new Error('trailing');
  return v;
}

// Tokens Studio stores numbers as strings ("4"), so treat numeric strings as numbers too.
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)$/;
const isNum = v => typeof v === 'number' || (typeof v === 'string' && NUM_RE.test(v.trim()));
const px = v => (isNum(v) ? (Number(v) === 0 ? '0' : `${Number(v)}px`) : String(v));
const dim = v => (isObj(v) && 'value' in v && 'unit' in v ? `${v.value}${v.unit}` : px(v));
const quoteFont = f => (/^[\w-]+$/.test(f) && !/\d/.test(f[0]) ? f : `"${f.replace(/"/g, '')}"`);
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace']);

function color(v) {
  if (isObj(v)) {  // DTCG 2025 color object
    if (v.hex) return v.alpha != null && v.alpha < 1 ? v.hex + Math.round(v.alpha * 255).toString(16).padStart(2, '0') : v.hex;
    const comps = (v.components ?? []).join(' ');
    return `color(${v.colorSpace ?? 'srgb'} ${comps}${v.alpha != null && v.alpha < 1 ? ` / ${v.alpha}` : ''})`;
  }
  return String(v);
}

function shadow(v) {
  const one = s => {
    if (!isObj(s)) return String(s);
    const parts = [dim(s.offsetX ?? s.x ?? 0), dim(s.offsetY ?? s.y ?? 0), dim(s.blur ?? 0), dim(s.spread ?? 0), color(s.color ?? '#000')];
    return (s.inset || s.type === 'innerShadow' ? 'inset ' : '') + parts.join(' ');
  };
  return Array.isArray(v) ? v.map(one).join(', ') : one(v);
}

const FONT_WEIGHTS = { thin: 100, hairline: 100, extralight: 200, 'extra-light': 200, ultralight: 200, light: 300, regular: 400,
  normal: 400, book: 400, medium: 500, semibold: 600, 'semi-bold': 600, demibold: 600, bold: 700, extrabold: 800,
  'extra-bold': 800, ultrabold: 800, black: 900, heavy: 900 };

export function fontWeight(v) {
  if (typeof v === 'number') return v;
  const k = String(v).toLowerCase().replace(/\s+/g, '').replace(/italic$/, '');
  return FONT_WEIGHTS[k] ?? v;
}

export function fontFamily(v) {
  const list = Array.isArray(v) ? v : String(v).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
  return list.map(f => (GENERIC_FONTS.has(f) ? f : quoteFont(f))).join(', ');
}

/**
 * CSS value(s) for a resolved token. Composite tokens (typography, border, transition)
 * return an object of sub-properties; everything else returns a string.
 */
export function cssValue(tok) {
  const out = rawCssValue(tok);
  const check = s => {
    if (/[;{}]|<\/|\/\*|\*\//.test(s)) throw new Error(`Token "${tok.path?.join('.') ?? '?'}" has an unsafe CSS value: ${JSON.stringify(s).slice(0, 80)}`);
  };
  if (isObj(out)) Object.values(out).forEach(check); else check(out);
  return out;
}

function rawCssValue(tok) {
  const type = TYPE_ALIASES[tok.type] ?? tok.type;
  const v = tok.value;
  switch (type) {
    case 'color': return color(v);
    case 'dimension': return PX_TYPES.has(tok.rawType) || type === 'dimension' ? dim(v) : String(v);
    case 'fontFamily': return fontFamily(v);
    case 'fontWeight': return String(fontWeight(v));
    case 'duration': return isObj(v) ? `${v.value}${v.unit}` : typeof v === 'number' ? `${v}ms` : String(v);
    case 'cubicBezier': return Array.isArray(v) ? `cubic-bezier(${v.join(', ')})` : String(v);
    case 'shadow': return shadow(v);
    case 'border':
      return isObj(v) ? `${dim(v.width ?? 1)} ${v.style ?? 'solid'} ${color(v.color ?? 'currentColor')}` : String(v);
    case 'typography': {
      if (!isObj(v)) return String(v);
      const out = {};
      if (v.fontFamily != null) out['font-family'] = fontFamily(v.fontFamily);
      if (v.fontWeight != null) out['font-weight'] = String(fontWeight(v.fontWeight));
      if (v.fontSize != null) out['font-size'] = dim(v.fontSize);
      if (v.lineHeight != null) out['line-height'] = isNum(v.lineHeight) && Number(v.lineHeight) > 4 ? px(v.lineHeight) : String(v.lineHeight);
      if (v.letterSpacing != null) out['letter-spacing'] = dim(v.letterSpacing);
      if (v.textCase != null && v.textCase !== 'none') out['text-transform'] = v.textCase;
      if (v.textDecoration != null && v.textDecoration !== 'none') out['text-decoration'] = v.textDecoration;
      return out;
    }
    case 'transition':
      return isObj(v) ? `${rawCssValue({ type: 'duration', value: v.duration })} ${rawCssValue({ type: 'cubicBezier', value: v.timingFunction })} ${rawCssValue({ type: 'duration', value: v.delay ?? 0 })}` : String(v);
    case 'gradient':
      if (Array.isArray(v)) return `linear-gradient(90deg, ${v.map(s => `${color(s.color)} ${Math.round(s.position * 100)}%`).join(', ')})`;
      return String(v);
    case 'lineHeight':
      return isNum(v) && Number(v) > 4 ? px(v) : String(v);
    default:
      if (Array.isArray(v)) return v.join(', ');
      if (isObj(v)) return JSON.stringify(v);
      return String(v);
  }
}

export const normalType = t => TYPE_ALIASES[t] ?? t;

/** Full pipeline: JSON document -> resolved token map. */
export function load(doc, { sets } = {}) {
  if (!isObj(doc)) throw new Error('The token file must contain a JSON object of token groups.');
  return resolve(flatten(selectSets(doc, sets)));
}
