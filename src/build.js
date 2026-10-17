// Load tokens (from Figma or local JSON), resolve them and render output files.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { load, selectSets } from './tokens.js';
import { render } from './formats.js';
import { pull } from './figma.js';
import { kebab } from './formats.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTok = v => isObj(v) && ('$value' in v || 'value' in v);

function merge(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (isObj(v) && !isTok(v) && isObj(into[k]) && !isTok(into[k])) merge(into[k], v);
    else into[k] = structuredClone(v);
  }
  return into;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`File not found: ${file}`);
    throw new Error(`Couldn't read ${file}: ${e.message}`);
  }
}

/**
 * Get raw token documents.
 * opts.figma: file key/URL (uses opts.token or FIGMA_TOKEN)
 * opts.input: local JSON file; opts.sets: Tokens Studio sets; opts.themes: { name: 'file.json' | 'sets:a,b' }
 * Returns { base: tree, themes: { name: tree } } where each theme is already merged over base.
 */
export async function loadSource(opts) {
  if (opts.figma) {
    const res = await pull({ file: opts.figma, token: opts.token ?? process.env.FIGMA_TOKEN, prefer: opts.prefer, cache: opts.figmaCache });
    const themes = {};
    for (const [mode, tree] of Object.entries(res.modes)) themes[kebab(mode)] = merge(structuredClone(res.default), tree);
    return { base: res.default, themes, source: `figma:${res.source}` };
  }
  if (!opts.input) throw new Error('Nothing to build. Pass a tokens JSON file or --figma <file-key>.');
  const doc = await readJson(opts.input);
  const base = selectSets(doc, opts.sets);
  const themes = {};
  for (const [name, spec] of Object.entries(opts.themes ?? {})) {
    if (spec.startsWith('sets:')) themes[name] = selectSets(doc, spec.slice(5).split(',').map(s => s.trim()));
    else themes[name] = merge(structuredClone(base), selectSets(await readJson(resolvePath(dirname(opts.input), spec)), undefined));
  }
  return { base, themes, source: `file:${opts.input}` };
}

/** Resolve + render. Returns { files, count, hash }. */
export function buildFiles(src, opts = {}) {
  const tokens = load(src.base);
  if (!tokens.size) throw new Error('No tokens found. Check the file has token groups with $value (DTCG) or value (Tokens Studio).');
  const themes = {};
  for (const [name, tree] of Object.entries(src.themes)) themes[name] = load(tree);
  const files = render(tokens, { ...opts, themes });
  const hash = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  return { files, count: tokens.size, themes: Object.keys(themes), hash, tokens };
}

export async function writeFiles(files, outDir) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const p = join(outDir, name);
    await writeFile(p, content);
    written.push(p);
  }
  return written;
}
