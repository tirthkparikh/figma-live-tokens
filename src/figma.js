// Pull tokens from a Figma file.
// 1) Variables (REST API, needs a plan with Variables API access).
// 2) Fallback: published styles (colours, text styles, shadows), which work on every plan.

const API = () => process.env.FIGMA_API_URL || 'https://api.figma.com';

async function get(path, token) {
  const res = await fetch(API() + path, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(30000) });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { data = { message: body }; }
  if (!res.ok) {
    const err = new Error(`Figma API ${res.status}: ${data.message || data.err || res.statusText}`);
    err.status = res.status;
    if (res.status === 429) {
      // Figma's limits depend on the seat: "low" (view/collab seats) allows only a handful of file reads
      err.retryAfter = Number(res.headers.get('retry-after')) || 60;
      const type = res.headers.get('x-figma-rate-limit-type');
      err.message = `Figma rate limit${type ? ` (${type}-limit seat)` : ''}: Figma asks to wait ${duration(err.retryAfter)} before reading this file again`;
    }
    throw err;
  }
  return data;
}

const duration = sec => (sec >= 86400 ? `${(sec / 86400).toFixed(1)} days` : sec >= 3600 ? `${(sec / 3600).toFixed(1)} hours` : sec >= 60 ? `${Math.ceil(sec / 60)} min` : `${sec}s`);

const hex2 = n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
export function rgbaToHex({ r, g, b, a = 1 }, opacity = 1) {
  const alpha = a * opacity;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha < 1 ? hex2(alpha) : ''}`;
}

// "Colors / Brand / 500" -> ["colors", "brand", "500"]
// A leading "$" (Carbon names styles "$ui-03") would mark the key as metadata in DTCG JSON, so drop it.
export const splitName = name => name.split('/').map(s => s.trim().replace(/^\$+/, '').trim()).filter(Boolean);

function setPath(tree, path, token) {
  let node = tree;
  for (const seg of path.slice(0, -1)) {
    if (node[seg] && '$value' in node[seg]) node[seg] = { DEFAULT: node[seg] };  // token and group share a name
    node = node[seg] ??= {};
  }
  const leaf = path.at(-1);
  if (node[leaf] && !('$value' in node[leaf])) node[leaf].DEFAULT = token;
  else node[leaf] = token;
}

const DIMENSION_SCOPES = new Set(['CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP', 'FONT_SIZE', 'STROKE_FLOAT', 'EFFECT_FLOAT', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT', 'LETTER_SPACING']);

function floatType(v) {
  const scopes = v.scopes ?? [];
  if (scopes.includes('FONT_WEIGHT')) return 'fontWeight';
  if (scopes.includes('OPACITY')) return 'number';
  if (scopes.includes('LINE_HEIGHT')) return 'dimension';
  if (scopes.some(s => DIMENSION_SCOPES.has(s))) return 'dimension';
  if (/radius|spacing|space|size|gap|padding|margin|width|height|border|stroke|font-?size|breakpoint/i.test(v.name)) return 'dimension';
  if (/weight/i.test(v.name)) return 'fontWeight';
  return 'number';
}

/** Convert the Variables API response into { default: tree, modes: { modeName: tree } }. */
export function variablesToTokens(meta) {
  const collections = meta.variableCollections ?? {};
  const variables = meta.variables ?? {};
  const byId = new Map(Object.entries(variables));
  const refName = id => {
    const v = byId.get(id);
    return v ? `{${splitName(v.name).join('.')}}` : null;
  };
  const modeNames = new Set();
  for (const c of Object.values(collections)) for (const m of c.modes ?? []) if (m.modeId !== c.defaultModeId) modeNames.add(m.name);

  const trees = { default: {} };
  for (const name of modeNames) trees[name] = {};

  for (const v of Object.values(variables)) {
    if (v.remote && !collections[v.variableCollectionId]) continue;
    if (v.hiddenFromPublishing) continue;
    const col = collections[v.variableCollectionId];
    if (!col) continue;
    const path = splitName(v.name);
    const type = v.resolvedType === 'COLOR' ? 'color' : v.resolvedType === 'FLOAT' ? floatType(v) : v.resolvedType === 'BOOLEAN' ? 'boolean' : 'string';
    const convert = raw => {
      if (raw && raw.type === 'VARIABLE_ALIAS') return refName(raw.id) ?? null;
      if (type === 'color') return rgbaToHex(raw);
      if (type === 'dimension') return `${Math.round(raw * 1000) / 1000}px`;
      if (type === 'string' && /font|family/i.test(v.name)) return raw;
      return raw;
    };
    const tokenFor = modeId => {
      const value = convert(v.valuesByMode?.[modeId]);
      if (value == null) return null;
      const t = { $type: type === 'string' && /famil/i.test(v.name) ? 'fontFamily' : type, $value: value };
      if (v.description) t.$description = v.description;
      return t;
    };
    const def = tokenFor(col.defaultModeId);
    if (!def) continue;
    setPath(trees.default, path, def);
    for (const mode of col.modes ?? []) {
      if (mode.modeId === col.defaultModeId) continue;
      const t = tokenFor(mode.modeId);
      if (t) setPath(trees[mode.name], path, t);
    }
  }
  return trees;
}

/** Convert published styles + their nodes into a token tree. */
export function stylesToTokens(styles, nodes) {
  const tree = {};
  for (const s of styles) {
    const doc = nodes[s.node_id]?.document;
    if (!doc) continue;
    const path = splitName(s.name);
    if (s.style_type === 'FILL') {
      const fill = (doc.fills ?? []).find(f => f.visible !== false);
      if (!fill) continue;
      if (fill.type === 'SOLID') setPath(tree, path, { $type: 'color', $value: rgbaToHex(fill.color, fill.opacity ?? 1) });
      else if (fill.type?.startsWith('GRADIENT_') && fill.gradientStops) {
        setPath(tree, path, { $type: 'gradient', $value: fill.gradientStops.map(st => ({ color: rgbaToHex(st.color), position: Math.round(st.position * 1000) / 1000 })) });
      }
    } else if (s.style_type === 'TEXT' && doc.style) {
      const st = doc.style;
      const value = { fontFamily: st.fontFamily, fontWeight: st.fontWeight, fontSize: `${st.fontSize}px` };
      if (st.lineHeightPx && st.lineHeightUnit !== 'INTRINSIC_%') value.lineHeight = st.lineHeightUnit === 'FONT_SIZE_%' && st.lineHeightPercentFontSize ? Math.round(st.lineHeightPercentFontSize) / 100 : `${Math.round(st.lineHeightPx * 100) / 100}px`;
      if (st.letterSpacing) value.letterSpacing = `${Math.round(st.letterSpacing * 100) / 100}px`;
      if (st.textCase && st.textCase !== 'ORIGINAL') value.textCase = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[st.textCase] ?? 'none';
      setPath(tree, path, { $type: 'typography', $value: value });
    } else if (s.style_type === 'EFFECT') {
      const shadows = (doc.effects ?? []).filter(e => e.visible !== false && /SHADOW/.test(e.type)).map(e => ({
        offsetX: `${e.offset?.x ?? 0}px`, offsetY: `${e.offset?.y ?? 0}px`, blur: `${e.radius ?? 0}px`, spread: `${e.spread ?? 0}px`,
        color: rgbaToHex(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }), inset: e.type === 'INNER_SHADOW',
      }));
      const blur = (doc.effects ?? []).find(e => e.visible !== false && /BLUR/.test(e.type));
      if (shadows.length) setPath(tree, path, { $type: 'shadow', $value: shadows.length === 1 ? shadows[0] : shadows });
      // layer/background blur: the radius, for filter: blur(var(--…)) or backdrop-filter
      else if (blur) setPath(tree, path, { $type: 'dimension', $value: `${blur.radius ?? 0}px`, $description: `${blur.type === 'BACKGROUND_BLUR' ? 'backdrop-filter' : 'filter'}: blur()` });
    }
  }
  return tree;
}

/**
 * Pull a file. Returns { source: 'variables' | 'styles', default: tree, modes: { name: tree } }.
 * `prefer`: 'auto' (variables, then styles), 'variables', 'styles' or 'both' (styles merged under variables).
 */
// Variables win over styles, but groups that exist in both are combined rather than replaced.
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const isGroup = x => x && typeof x === 'object' && !Array.isArray(x) && !('$value' in x);
    out[k] = isGroup(v) && isGroup(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * `cache` (optional, reused between calls) keeps the last style nodes: the cheap /styles list is
 * checked first, and the expensive /nodes download only happens when a style actually changed.
 */
export async function pull({ file, token, prefer = 'auto', cache = {} }) {
  if (!file) throw new Error('Missing Figma file key (the part after /design/ or /file/ in the URL).');
  if (!token) throw new Error('Missing Figma token. Set FIGMA_TOKEN or pass --token.');
  file = parseFileKey(file);
  let vars = null, varErr = null;
  if (prefer !== 'styles' && !(prefer === 'auto' && cache.noVariables)) {
    try {
      const data = await get(`/v1/files/${file}/variables/local`, token);
      vars = variablesToTokens(data.meta ?? {});
      if (!Object.keys(vars.default).length) vars = null;
    } catch (e) {
      if (prefer === 'variables' || (e.status !== 403 && e.status !== 404)) throw e;
      varErr = e;
      cache.noVariables = true;  // plan without the Variables API: don't spend a request on it every poll
    }
  }
  let styleTree = null;
  if (prefer === 'styles' || prefer === 'both' || !vars) {
    const { meta } = await get(`/v1/files/${file}/styles`, token);
    const styles = meta?.styles ?? [];
    if (styles.length) {
      const sig = `${file}|${styles.map(s => `${s.node_id}@${s.updated_at ?? ''}`).sort().join(',')}`;
      let nodes = cache.styleSig === sig ? cache.nodes : null;
      if (!nodes) {
        nodes = {};
        const ids = styles.map(s => s.node_id);
        for (let i = 0; i < ids.length; i += 200) {
          const part = await get(`/v1/files/${file}/nodes?ids=${encodeURIComponent(ids.slice(i, i + 200).join(','))}`, token);
          Object.assign(nodes, part.nodes);
        }
        Object.assign(cache, { styleSig: sig, nodes });
      }
      styleTree = stylesToTokens(styles, nodes);
    }
  }
  if (!vars && !styleTree) {
    throw new Error(`No variables or published styles found in file ${file}${varErr ? ` (variables: ${varErr.message})` : ''}.`);
  }
  const { default: def = {}, ...modes } = vars ?? {};
  const merged = styleTree ? deepMerge(styleTree, def) : def;
  return { source: vars && styleTree ? 'variables+styles' : vars ? 'variables' : 'styles', default: merged, modes };
}

/** Accept a bare key or a full Figma URL. */
export function parseFileKey(input) {
  const m = String(input).match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  return m ? m[1] : String(input).trim();
}
