# figma-live-tokens

[![npm](https://img.shields.io/npm/v/@tirthlabs/figma-live-tokens?color=c2410c)](https://www.npmjs.com/package/@tirthlabs/figma-live-tokens) [![CI](https://github.com/tirthkparikh/figma-live-tokens/actions/workflows/ci.yml/badge.svg)](https://github.com/tirthkparikh/figma-live-tokens/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@tirthlabs/figma-live-tokens)](LICENSE) · [Live demo](https://tirthparikh.com/tools/figma-live-tokens/)

Turn Figma variables and styles into CSS variables, Tailwind (v3 and v4), SCSS and JS, and **keep your live website in sync with Figma without a redeploy.**

A designer changes a colour in Figma, publishes, and every open page picks up the new value within seconds.

```bash
npx @tirthlabs/figma-live-tokens build --figma <file-url> -f css,tailwind4
```

- Works with **Figma Variables** (including modes such as Light/Dark), and falls back to **published styles** (colours, text styles, shadows) on plans without the Variables API.
- Also reads **W3C DTCG** and **Tokens Studio** JSON, so you can use it without Figma.
- Resolves `{references}` and maths such as `{space.base} * 4`.
- Outputs: `css`, `scss`, `js` (ESM, CJS and `.d.ts`), `json`, `tailwind` (v3 preset), `tailwind4` (`@theme`).
- Themes write only the values that change. `dark` also gets a `prefers-color-scheme` block.
- No dependencies. Node 18.17 or newer.

## Quick start

```bash
npm i -D @tirthlabs/figma-live-tokens
export FIGMA_TOKEN=figd_...            # Figma → Settings → Security → Personal access tokens

npx figma-live-tokens build --figma https://www.figma.com/design/AbC123/Website -f css,tailwind4,js -o src/tokens
```

Without Figma:

```bash
npx figma-live-tokens init             # example tokens.json, tokens.dark.json and config
npx figma-live-tokens build            # → tokens/tokens.css, tokens/tailwind.theme.css, tokens/tokens.js
npx figma-live-tokens build --watch    # rebuild on save
```

## Live mode: Figma → website, no redeploy

Run the token server somewhere your site can reach (a small VPS, Railway, Fly, a container):

```bash
FIGMA_TOKEN=figd_... npx figma-live-tokens serve --figma <file-url> --port 4100 --webhook-passcode "$SECRET"
```

Add one line to your site, after your normal stylesheet:

```html
<script src="https://tokens.example.com/client.js" defer></script>
```

What happens:

1. The server pulls tokens from Figma when it starts, then every `--interval` seconds (default 30).
2. With a [Figma webhook](https://www.figma.com/developers/api#webhooks_v2) (`FILE_UPDATE` or `LIBRARY_PUBLISH`) pointed at `https://tokens.example.com/webhook`, updates arrive within about two seconds of publishing.
3. When the CSS changes, the server pushes it to every open page over Server-Sent Events. `client.js` swaps the variables in place, so utilities and components restyle immediately.
4. If Figma is unreachable or a token is broken, the last good CSS keeps being served. Check `GET /status` to see what went wrong.

Endpoints:

| Path | What it returns |
| --- | --- |
| `GET /tokens.css` | Current CSS variables (with an ETag) |
| `GET /tokens.json` | Flat `{ name: value }` map |
| `GET /client.js` | The browser script |
| `GET /events` | Server-Sent Events stream (`event: tokens`) |
| `GET /status` | Version, token count, last update, last error |
| `POST /webhook` | Figma webhook receiver (checks `passcode`) |
| `POST /refresh` | Pull now (`Authorization: Bearer <--refresh-token>`) |

The page fires `tokens:update` on `document` after each change, in case your JS needs to react to it.

Tip: ship the built `tokens.css` with your site too, for the first paint and as an offline fallback. The live script overrides it when it connects.

## Tailwind

**v4**: import the generated theme after Tailwind:

```css
@import "tailwindcss";
@import "./tokens/tokens.css";
@import "./tokens/tailwind.theme.css";
```

`bg-brand-500`, `p-4`, `rounded-md`, `shadow-card` and `font-sans` now use your Figma values, and opacity modifiers like `bg-brand-500/50` still work.

**v3**: use the preset:

```js
// tailwind.config.js
module.exports = { presets: [require('./tokens/tailwind.preset.cjs')], content: ['./src/**/*.{html,js,tsx}'] };
```

Both point at CSS variables, so live updates restyle Tailwind utilities as well.

## Themes

Figma variable modes become themes automatically (`Dark` → `[data-theme="dark"]`). From files:

```bash
npx figma-live-tokens build tokens.json --theme dark=tokens.dark.json --theme brand-b=brand-b.json
# Tokens Studio sets:
npx figma-live-tokens build tokens.json --sets core,light --theme dark=sets:core,dark
```

## Config file

`figma-live-tokens.config.json` (command-line flags win):

```json
{
  "figma": "https://www.figma.com/design/AbC123/Website",
  "formats": ["css", "tailwind4", "js"],
  "out": "src/tokens",
  "prefix": "ds",
  "interval": 60,
  "selector": ":root",
  "themeSelector": "[data-theme=\"{name}\"]",
  "darkMedia": true
}
```

`selector` is where base variables go, `themeSelector` is the selector for each theme (`{name}` is replaced), and `darkMedia: false` turns off the automatic `prefers-color-scheme` block for the `dark` theme.

## Use from code

```js
import { load, render, pull, createLiveServer } from '@tirthlabs/figma-live-tokens';

const tokens = load(JSON.parse(fs.readFileSync('tokens.json', 'utf8')));
const files = render(tokens, { formats: ['css', 'tailwind4'], prefix: 'ds' });

// or embed the live server in an existing Node app
const live = createLiveServer({ figma: 'AbC123', token: process.env.FIGMA_TOKEN });
app.use('/tokens', live.handler);   // Express or any (req, res) handler
await live.refresh();
```

## Figma notes

- The Variables REST API is available on Figma Enterprise. On other plans the tool reads **published styles** instead. Use `--prefer styles|variables|both` to choose.
- Give the personal access token read access to file content, library styles and variables (`file_content:read`, `library_content:read`, `file_variables:read`).
- Variables hidden from publishing are skipped. Aliases become `{references}`, so semantic tokens stay linked to primitives as `var(--…)`.

## License

MIT © Tirth Parikh, [tirthparikh.com](https://tirthparikh.com)
