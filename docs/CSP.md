# Content Security Policy

The editor ships a strict Content Security Policy to keep **plugin code
and third-party scripts from escalating beyond their declared reach**.
This document is the canonical reference for the policy string, the
reasoning behind each directive, and the validation gates the deploy
has to pass.

The CSP is emitted from three places that must stay in lockstep:

| Surface | File | Applies when |
|---|---|---|
| HTTP header (default / standalone image) | `deploy/nginx.conf` | Docker image run against the bundled nginx |
| HTTP header (production) | `deploy/nginx.prod.conf` | velxio.dev production deployment |
| `<meta http-equiv>` fallback | `frontend/index.html` | Static-file serving when no HTTP header is set (preview tools, mirrors) |

The regression test in
[`frontend/src/__tests__/csp-policy.test.ts`](../frontend/src/__tests__/csp-policy.test.ts)
parses all three at CI time and fails the build when they drift.

## The policy

```
default-src 'self';
worker-src  'self' blob:;
script-src  'self' 'wasm-unsafe-eval' https://www.googletagmanager.com https://www.google-analytics.com;
connect-src 'self' https://api.velxio.dev https://cdn.velxio.dev https://www.google-analytics.com;
img-src     'self' data: https:;
style-src   'self' 'unsafe-inline';
font-src    'self' data:;
frame-src   'none';
frame-ancestors 'self';    /* nginx only — meta tag does not support this directive */
object-src  'none';
base-uri    'self';
form-action 'self';
```

## Why each directive

**`default-src 'self'`** — deny everything not explicitly allowed. Every
other directive is an allowlist extension on top of `self`.

**`worker-src 'self' blob:`** — the plugin runtime (CORE-006) boots
workers from `URL.createObjectURL(bundleBytes)` so SHA-256-verified code
can run in the sandbox without being served from disk. Without `blob:`,
no plugin loads.

**`script-src 'self' 'wasm-unsafe-eval' https://www.googletagmanager.com
https://www.google-analytics.com`** — three additions:

- `'wasm-unsafe-eval'` lets `WebAssembly.compile` run for avr8js, rp2040js,
  and the ngspice WASM. Without it, every hardware simulator fails to
  boot. Does **not** enable plain `eval()` or `new Function(...)`.
- `https://www.googletagmanager.com` is where the `gtag/js` loader ships
  from (the async `<script>` in `index.html`).
- `https://www.google-analytics.com` is where the beacons ship to.

Notably absent: `'unsafe-inline'`. The inline gtag init that used to
live in `index.html` was extracted to
[`frontend/public/gtag-init.js`](../frontend/public/gtag-init.js) so the
directive stays clean. Adding another inline `<script>` block will be
blocked in production — either extract to a file or use the JSON-LD
`type="application/ld+json"` escape hatch (explicitly allowed because
CSP considers typed JSON-LD as inert data, not code).

**`connect-src 'self' https://api.velxio.dev https://cdn.velxio.dev
https://www.google-analytics.com`**:

- `'self'` covers the API, the WebSocket ESP32 proxy, and every relative
  `fetch`.
- `https://api.velxio.dev` is the future marketplace origin probed by
  [CORE-010](./MARKETPLACE_DISCOVERY.md).
- `https://cdn.velxio.dev` is the planned plugin bundle CDN served
  through R2 (PRO-005).
- `https://www.google-analytics.com` is where GA sends beacons.

Plugin egress to arbitrary origins is enforced on top of CSP via the
per-plugin HTTPS allowlist in [CORE-006 ScopedFetch](./PLUGIN_SDK.md).

**`img-src 'self' data: https:`** — `data:` unblocks Vite's inlined
small images plus a handful of wokwi-elements SVG data URIs. `https:`
is a pragmatic opening for user-supplied avatars and third-party blog
imagery that appears in the Pro blog. A future tightening would swap
`https:` for a concrete origin list, but requires auditing every image
source site uses today.

**`style-src 'self' 'unsafe-inline'`** — documented trade-off. Both
wokwi-elements (Lit CSS tagged-template) and styled-components emit
inline `<style>` blocks. The alternative (nonces + constructable
stylesheets) is a bigger refactor than the threat warrants: stylesheet
injection is not a remote-code-execution primitive, and the runtime
threat model (plugin sandbox, XSS) is already addressed by
`script-src`.

**`font-src 'self' data:`** — Google Fonts and self-hosted fonts, plus
some vendored data URIs from wokwi-elements.

**`frame-src 'none'`** — no iframes today. When CORE-006b-step5b ships
the iframe-sandbox worker-safe panel path, this directive will open up
to `'self'` and tighten elsewhere with `sandbox`.

**`frame-ancestors 'self'`** — nginx-only because the
`<meta http-equiv>` tag cannot express it. The `X-Frame-Options:
SAMEORIGIN` header covers the same intent for browsers that prefer
the older header.

**`object-src 'none'`** — no Flash, no `<embed>`, no `<object>`. Zero
modern use case and a known XSS vector when combined with plugin
content types.

**`base-uri 'self'`** — prevents a `<base>` injection from rebinding
every relative URL in the page to an attacker origin.

**`form-action 'self'`** — submits to same-origin only, so no form-post
exfiltration even if an attacker injects a `<form>` that bypasses the
XSS sanitiser.

## Rollout checklist

The code-side work is done (policy in both nginx configs, meta fallback
in `index.html`, regression test in CI). Validation requires a live
deploy and cannot be fully automated:

- [ ] `https://securityheaders.com/?q=https%3A%2F%2Fvelxio.dev` returns
  **A+** for velxio.dev (Core).
- [ ] Same URL for velxio.dev/blog returns **A+** (Pro).
- [ ] DevTools console across every route shows **zero** CSP
  violations:
  - `/` (landing)
  - `/editor` (Monaco + wokwi-elements + AVR8)
  - `/editor` with electrical mode on (ngspice WASM)
  - `/editor` with an ESP32 board selected (QEMU WebSocket)
  - `/:username` (user profile)
  - `/:username/:slug` (project view)
  - `/login`, `/register` (auth flows)
  - `/blog`, `/blog/<any-post>` (Pro blog surface)
- [ ] `npm run build:docker` still serves through the nginx config (the
  Dockerfile currently uses `nginx.conf`, so the standalone image
  inherits the header).

## Known gotchas

- **Vite dev server.** `npm run dev` does NOT apply the nginx config
  (the server runs on Vite's own middleware) but DOES serve the meta
  tag from `index.html`. If the dev console shows CSP violations from
  Vite's HMR client or `@react-refresh/`, that's expected — the meta
  tag is stricter than what Vite injects. Turn off the meta by
  commenting it out locally if it blocks dev, but **do not commit that
  change**.
- **New inline `<script>` blocks.** The regression test flags any
  `<script>` in `index.html` that has neither `src=` nor `type=`. Add a
  JSON-LD block with `type="application/ld+json"` (allowed) or extract
  to a file under `public/`.
- **Third-party CDNs.** The CSP whitelists three Google origins and
  nothing else. Adding a new CDN (e.g. Cloudflare R2, another analytics
  vendor, a Discord widget) requires updating all three surfaces at
  once — the regression test will block CI until they match.
- **Plugin fetch targets.** Plugin egress is double-gated: CSP's
  `connect-src` AND the plugin's own `http.allowlist` in its manifest.
  A plugin can only reach an origin that appears in BOTH.

## Links

- [CORE-006 plugin runtime](./PLUGIN_RUNTIME.md)
- [CORE-010 marketplace discovery](./MARKETPLACE_DISCOVERY.md)
- [Plugin permissions catalog](./PLUGIN_PERMISSIONS.md)
