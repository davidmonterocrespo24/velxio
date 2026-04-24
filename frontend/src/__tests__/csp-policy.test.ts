/**
 * CORE-006b-step2 — Content Security Policy regression guard.
 *
 * Asserts that the three CSP surfaces stay in sync:
 *   1. `deploy/nginx.conf`       (HTTP header, local + standalone image)
 *   2. `deploy/nginx.prod.conf`  (HTTP header, production)
 *   3. `frontend/index.html`     (<meta http-equiv> fallback)
 *
 * Rules enforced:
 *   - All three declare the same directives (minus `frame-ancestors`,
 *     which the meta tag cannot express — X-Frame-Options covers that).
 *   - Required directives are present with the exact values the worker
 *     runtime (CORE-006) and the WebAssembly simulators depend on.
 *   - No directive uses `*` — always-explicit origin allowlisting.
 *   - The script-src allowlist includes the Google Analytics origins
 *     that the inline-free gtag loader needs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function read(relativeFromRepoRoot: string): string {
  return readFileSync(path.join(REPO_ROOT, relativeFromRepoRoot), 'utf8');
}

/** Pull the policy string out of an `add_header Content-Security-Policy "..."` line. */
function extractNginxCsp(nginxConf: string): string {
  const match = nginxConf.match(
    /add_header\s+Content-Security-Policy\s+"([^"]+)"/,
  );
  if (!match) throw new Error('CSP header not found in nginx config');
  return match[1];
}

/** Pull the policy string out of `<meta http-equiv="Content-Security-Policy" content="..." />`. */
function extractHtmlMetaCsp(html: string): string {
  const match = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  );
  if (!match) throw new Error('CSP meta tag not found in index.html');
  return match[1];
}

/**
 * Parse a CSP string into a map of directive → sources.
 * CSP syntax: directives are separated by `;`, the first token of each
 * directive is the name and the rest are sources. Sources are preserved
 * in their literal form (including quotes around keywords like 'self').
 */
function parseCsp(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/\s+/);
    out.set(name, sources);
  }
  return out;
}

describe('CORE-006b-step2 — CSP surfaces stay in sync', () => {
  const nginxConf = read('deploy/nginx.conf');
  const nginxProdConf = read('deploy/nginx.prod.conf');
  const indexHtml = read('frontend/index.html');

  const nginxPolicy = parseCsp(extractNginxCsp(nginxConf));
  const nginxProdPolicy = parseCsp(extractNginxCsp(nginxProdConf));
  const metaPolicy = parseCsp(extractHtmlMetaCsp(indexHtml));

  it('nginx.conf and nginx.prod.conf declare identical policies', () => {
    const a = [...nginxPolicy.entries()]
      .map(([k, v]) => `${k} ${v.join(' ')}`)
      .sort();
    const b = [...nginxProdPolicy.entries()]
      .map(([k, v]) => `${k} ${v.join(' ')}`)
      .sort();
    expect(a).toEqual(b);
  });

  it('meta fallback matches nginx, minus frame-ancestors', () => {
    const metaKeys = new Set(metaPolicy.keys());
    const nginxKeys = new Set(nginxPolicy.keys());
    nginxKeys.delete('frame-ancestors');
    expect([...metaKeys].sort()).toEqual([...nginxKeys].sort());
    for (const key of metaKeys) {
      expect(metaPolicy.get(key)).toEqual(nginxPolicy.get(key));
    }
  });

  describe('required directives', () => {
    it('default-src is self-only', () => {
      expect(nginxPolicy.get('default-src')).toEqual(["'self'"]);
    });

    it('worker-src allows blob: so the plugin loader can boot verified bundles', () => {
      // CORE-006 creates `blob:` URLs from SHA-256-verified bytes and imports
      // them as a Worker. Without blob:, the plugin runtime cannot start.
      expect(nginxPolicy.get('worker-src')).toEqual(["'self'", 'blob:']);
    });

    it("script-src carries 'wasm-unsafe-eval' for AVR8/RP2040/ngspice", () => {
      // The three WebAssembly simulators use WebAssembly.compile which is
      // gated behind `wasm-unsafe-eval` when the CSP omits `unsafe-eval`.
      const scriptSrc = nginxPolicy.get('script-src') ?? [];
      expect(scriptSrc).toContain("'wasm-unsafe-eval'");
      expect(scriptSrc).toContain("'self'");
    });

    it('script-src does NOT include unsafe-inline (gtag moved to /gtag-init.js)', () => {
      const scriptSrc = nginxPolicy.get('script-src') ?? [];
      expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    it('script-src allows the Google Analytics origins', () => {
      const scriptSrc = nginxPolicy.get('script-src') ?? [];
      expect(scriptSrc).toContain('https://www.googletagmanager.com');
      expect(scriptSrc).toContain('https://www.google-analytics.com');
    });

    it('connect-src is the marketplace + analytics allowlist', () => {
      const connectSrc = nginxPolicy.get('connect-src') ?? [];
      // CORE-010 marketplace discovery + CORE-007 plugin CDN + GA beacons.
      expect(connectSrc).toEqual([
        "'self'",
        'https://api.velxio.dev',
        'https://cdn.velxio.dev',
        'https://www.google-analytics.com',
      ]);
    });

    it('frame-src is none (no plugin-side iframe panels until CORE-006b-step5b)', () => {
      expect(nginxPolicy.get('frame-src')).toEqual(["'none'"]);
    });

    it('object-src is none — no Flash/ActiveX/plugins', () => {
      expect(nginxPolicy.get('object-src')).toEqual(["'none'"]);
    });

    it('base-uri is self — no meta-base rebinding', () => {
      expect(nginxPolicy.get('base-uri')).toEqual(["'self'"]);
    });

    it('form-action is self — no exfiltration via form submit', () => {
      expect(nginxPolicy.get('form-action')).toEqual(["'self'"]);
    });
  });

  describe('no wildcards in sensitive directives', () => {
    const sensitive = [
      'default-src',
      'script-src',
      'connect-src',
      'worker-src',
      'frame-src',
      'object-src',
      'base-uri',
      'form-action',
    ];
    for (const directive of sensitive) {
      it(`${directive} does not contain *`, () => {
        const sources = nginxPolicy.get(directive) ?? [];
        expect(sources).not.toContain('*');
      });
    }
  });

  it('the shared gtag-init.js exists (no inline scripts left in index.html)', () => {
    // If somebody reverts to inline gtag, the CSP will block it in prod.
    // Guard that by keeping the external file in place.
    const gtag = read('frontend/public/gtag-init.js');
    expect(gtag).toContain('dataLayer');
    expect(gtag).toContain("gtag('config'");

    // index.html must not contain an inline executable <script> block
    // (JSON-LD `type="application/ld+json"` is inert data — explicitly allowed).
    const inlineExecutable = indexHtml.match(/<script(?![^>]*type=)(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/g);
    expect(inlineExecutable).toBeNull();
  });
});
