#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, access, stat } from 'node:fs/promises';
import { watchFile } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSource, buildFiles, writeFiles } from '../src/build.js';
import { pull } from '../src/figma.js';
import { createLiveServer } from '../src/server.js';
import { FORMATS, kebab } from '../src/formats.js';

const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));

const HELP = `figma-live-tokens ${pkg.version}
Design tokens from Figma to your website: build CSS/Tailwind files, or serve them live.

Usage
  figma-live-tokens build [tokens.json]   Write CSS / SCSS / JS / Tailwind files
  figma-live-tokens serve [tokens.json]   Live server: pages update when tokens change
  figma-live-tokens pull                  Save Figma variables/styles as tokens.json
  figma-live-tokens init                  Create an example tokens.json and config

Source (pick one)
  [tokens.json]              DTCG or Tokens Studio JSON file
  --figma <key|url>          Figma file (needs FIGMA_TOKEN or --token)
  --prefer <mode>            auto | variables | styles | both     (default: auto)
  --sets <a,b>               Tokens Studio sets to merge, in order
  --theme <name=file>        Extra theme, e.g. dark=tokens.dark.json or dark=sets:core,dark
                             (repeatable; Figma modes become themes automatically)

Output
  --out <dir>                Output folder (build); output file (pull) (default: tokens)
  --formats <list>           ${FORMATS.join(',')}  (default: css)
  --prefix <name>            Prefix for variable names, e.g. ds -> --ds-color-brand
  --no-refs                  Write final values instead of var(--other-token)
  --watch                    Rebuild when the file changes (build only)

Live server (serve)
  --port <n>                 Port                                    (default: 4100)
  --host <addr>              Host                                    (default: 0.0.0.0)
  --interval <s>             Poll Figma every n seconds (min 30), 0 = off (default: 60)
  --webhook-passcode <s>     Passcode for Figma webhooks (POST /webhook)
  --refresh-token <s>        Bearer token for POST /refresh
  --cors <origin>            Allowed origin                          (default: *)

Add to your site:  <script src="https://your-token-server/client.js" defer></script>

Options can also live in figma-live-tokens.config.json. Docs: ${pkg.homepage}`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      figma: { type: 'string' }, token: { type: 'string' }, prefer: { type: 'string' },
      sets: { type: 'string' }, theme: { type: 'string', multiple: true },
      out: { type: 'string', short: 'o' }, formats: { type: 'string', short: 'f' }, prefix: { type: 'string' },
      'no-refs': { type: 'boolean' }, watch: { type: 'boolean', short: 'w' },
      port: { type: 'string', short: 'p' }, host: { type: 'string' }, interval: { type: 'string' },
      'webhook-passcode': { type: 'string' }, 'refresh-token': { type: 'string' }, cors: { type: 'string' },
      config: { type: 'string', short: 'c' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
} catch (e) {
  fail(`${e.message}\nRun figma-live-tokens --help for usage.`);
}
const { values: flags, positionals } = args;
if (flags.version) { console.log(pkg.version); process.exit(0); }
const [command, input] = positionals;
if (flags.help || !command) { console.log(HELP); process.exit(command || flags.help ? 0 : 1); }

function fail(msg) { console.error(`\x1b[31m✖\x1b[0m ${msg}`); process.exit(1); }
const ok = msg => console.log(`\x1b[32m✔\x1b[0m ${msg}`);

async function config() {
  const file = flags.config ?? 'figma-live-tokens.config.json';
  let cfg = {};
  try { cfg = JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (flags.config || e.code !== 'ENOENT') fail(`Couldn't read config ${file}: ${e.message}`);
  }
  const themes = { ...(cfg.themes ?? {}) };
  for (const t of flags.theme ?? []) {
    const i = t.indexOf('=');
    if (i < 1) fail(`--theme expects name=file, got "${t}"`);
    themes[t.slice(0, i)] = t.slice(i + 1);
  }
  const formats = (flags.formats ?? (cfg.formats ? [].concat(cfg.formats).join(',') : 'css')).split(',').map(s => s.trim()).filter(Boolean);
  for (const f of formats) if (!FORMATS.includes(f)) fail(`Unknown format "${f}". Use: ${FORMATS.join(', ')}`);
  const num = (v, name) => { if (v == null) return undefined; const n = Number(v); if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a number`); return n; };
  return {
    input: input ?? cfg.input, figma: flags.figma ?? cfg.figma, token: flags.token ?? process.env.FIGMA_TOKEN,
    prefer: flags.prefer ?? cfg.prefer ?? 'auto', sets: (flags.sets ?? cfg.sets)?.toString().split(',').map(s => s.trim()).filter(Boolean),
    themes, formats, prefix: flags.prefix ?? cfg.prefix, refs: !(flags['no-refs'] ?? cfg.refs === false),
    out: flags.out ?? cfg.out ?? 'tokens', port: num(flags.port ?? cfg.port, 'port') ?? 4100, host: flags.host ?? cfg.host ?? '0.0.0.0',
    interval: num(flags.interval ?? cfg.interval, 'interval') ?? 60, webhookPasscode: flags['webhook-passcode'] ?? cfg.webhookPasscode ?? process.env.FIGMA_WEBHOOK_PASSCODE,
    refreshToken: flags['refresh-token'] ?? cfg.refreshToken, cors: flags.cors ?? cfg.cors,
    // CSS output details, config file only
    selector: cfg.selector, themeSelector: cfg.themeSelector, darkMedia: cfg.darkMedia, classes: cfg.classes,
  };
}

const EXAMPLE = {
  color: {
    $type: 'color',
    brand: { 50: { $value: '#fff7ed' }, 500: { $value: '#f97316' }, 700: { $value: '#c2410c' } },
    gray: { 50: { $value: '#fafaf9' }, 900: { $value: '#1c1917' } },
    bg: { $value: '{color.gray.50}' }, text: { $value: '{color.gray.900}' }, accent: { $value: '{color.brand.500}' },
  },
  spacing: { $type: 'dimension', 1: { $value: '4px' }, 2: { $value: '{spacing.1} * 2' }, 4: { $value: '{spacing.1} * 4' } },
  radius: { $type: 'dimension', md: { $value: '8px' }, full: { $value: '9999px' } },
  font: { sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui', 'sans-serif'] } },
  shadow: { card: { $type: 'shadow', $value: { offsetX: '0px', offsetY: '4px', blur: '16px', spread: '0px', color: '#0000001f' } } },
  typography: {
    heading: { $type: 'typography', $value: { fontFamily: '{font.sans}', fontWeight: 'Bold', fontSize: '32px', lineHeight: 1.2 } },
  },
};
const EXAMPLE_DARK = { color: { bg: { $value: '{color.gray.900}' }, text: { $value: '{color.gray.50}' } } };

async function exists(p) { try { await access(p); return true; } catch { return false; } }

try {
  if (command === 'init') {
    for (const [file, data] of [['tokens.json', EXAMPLE], ['tokens.dark.json', EXAMPLE_DARK],
      ['figma-live-tokens.config.json', { input: 'tokens.json', themes: { dark: 'tokens.dark.json' }, formats: ['css', 'tailwind4', 'js'], out: 'tokens' }]]) {
      if (await exists(file)) { console.log(`  skipped ${file} (already exists)`); continue; }
      await writeFile(file, JSON.stringify(data, null, 2) + '\n');
      ok(`created ${file}`);
    }
    console.log('\nNext: npx figma-live-tokens build   or   npx figma-live-tokens serve');
  } else if (command === 'build') {
    const cfg = await config();
    const run = async () => {
      const t0 = performance.now();
      const src = await loadSource(cfg);
      const { files, count, themes } = buildFiles(src, cfg);
      const written = await writeFiles(files, cfg.out);
      ok(`${count} tokens${themes.length ? ` + themes: ${themes.join(', ')}` : ''} -> ${written.map(w => w.replace(process.cwd() + '/', '')).join(', ')} (${Math.round(performance.now() - t0)}ms)`);
    };
    await run();
    if (flags.watch) {
      if (cfg.figma) fail('--watch works with local files. For Figma use: figma-live-tokens serve --figma <key>');
      const files = [cfg.input, ...Object.values(cfg.themes).filter(s => !s.startsWith('sets:')).map(s => resolve(dirname(cfg.input), s))];
      let t;
      for (const f of files) watchFile(f, { interval: 300 }, () => { clearTimeout(t); t = setTimeout(() => run().catch(e => console.error(`\x1b[31m✖\x1b[0m ${e.message}`)), 100); });
      console.log(`  watching ${files.join(', ')}`);
    }
  } else if (command === 'pull') {
    const cfg = await config();
    if (!cfg.figma) fail('pull needs --figma <file key or URL>.');
    const res = await pull({ file: cfg.figma, token: cfg.token, prefer: cfg.prefer });
    let out = flags.out ?? 'tokens.json';
    if (out.endsWith('/') || (await stat(out).catch(() => null))?.isDirectory()) out = join(out, 'tokens.json');
    await writeFile(out, JSON.stringify(res.default, null, 2) + '\n');
    ok(`saved ${out} (from Figma ${res.source})`);
    for (const [mode, tree] of Object.entries(res.modes)) {
      const file = out.replace(/\.json$/, '') + `.${kebab(mode)}.json`;
      await writeFile(file, JSON.stringify(tree, null, 2) + '\n');
      ok(`saved ${file} (mode "${mode}"; build with --theme ${kebab(mode)}=${file})`);
    }
  } else if (command === 'serve') {
    const cfg = await config();
    const live = createLiveServer({ ...cfg, formats: cfg.formats, log: m => console.log(`  ${new Date().toLocaleTimeString()}  ${m}`) });
    const addr = await live.start(cfg.port, cfg.host);
    if (live.state.error && !live.state.hash) console.error(`\x1b[33m!\x1b[0m first load failed: ${live.state.error} ${/rate limit/.test(live.state.error) ? '' : cfg.figma && cfg.interval ? '(will keep retrying)' : '(fix it and save again)'}`);
    const url = `http://${addr.address === '0.0.0.0' || addr.address === '::' ? 'localhost' : addr.address}:${addr.port}`;
    ok(`live token server on ${url}`);
    console.log(`  CSS:     ${url}/tokens.css\n  Script:  <script src="${url}/client.js" defer></script>`);
    if (cfg.figma) console.log(`  Figma:   ${cfg.interval ? `polling every ${Math.max(30, cfg.interval)}s` : 'polling off'}${cfg.webhookPasscode ? `, webhook at ${url}/webhook` : ''}`);
    const stop = () => live.stop().then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } else {
    fail(`Unknown command "${command}". Run figma-live-tokens --help.`);
  }
} catch (e) {
  fail(e.message);
}
