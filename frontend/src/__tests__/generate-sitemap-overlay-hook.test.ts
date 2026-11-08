// @vitest-environment node
/**
 * The overlay's say in which examples the sitemap lists
 * (velxio/velxio-prod#31, #68).
 *
 * scripts/generate-sitemap.mjs is plain Node and reads the example ids from
 * the data files' text. A build that carries an overlay (VITE_PRO_BUILD and
 * PRO_OVERLAY_PATH) may leave some of them out: the overlay's gallery hides
 * examples its engines cannot run, and their pages should not be promoted to
 * crawlers. The hook is a module at <overlay>/sitemap.mjs exporting
 * sitemapExampleIds(ids), the ids to list of those found; without one (an OSS
 * build, an overlay that has none) every example is listed, as before.
 *
 * The generator writes ../public/sitemap.xml next to itself, so each case runs
 * it on a copy of the files it reads, laid out as in this frontend.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = fileURLToPath(new URL('../../', import.meta.url));
const SOURCES = ['scripts/generate-sitemap.mjs', 'src/seoRoutes.ts', 'src/data/examples.ts', 'src/data/examples-circuits.ts'];

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** The example ids the sitemap lists, the generator run on a copy of this frontend's files with `env`. */
function listedExamples(env: Record<string, string> = {}): string[] {
  const dir = tempDir('velxio-sitemap-');
  for (const f of SOURCES) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(FRONTEND, f), join(dir, f));
  }
  mkdirSync(join(dir, 'public'));
  execFileSync(process.execPath, [join(dir, 'scripts/generate-sitemap.mjs')], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: 'pipe',
  });
  const xml = readFileSync(join(dir, 'public/sitemap.xml'), 'utf-8');
  return [...xml.matchAll(/<loc>https:\/\/velxio\.dev\/examples\/([^/<]+)\/<\/loc>/g)].map((m) => m[1]);
}

/** An overlay directory holding only `files`. */
function overlay(files: Record<string, string>): string {
  const dir = tempDir('velxio-overlay-');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('the sitemap’s examples and the overlay’s hook (#31, #68)', () => {
  let all: string[] = [];
  beforeAll(() => {
    all = listedExamples();
  });

  it('an OSS build lists every example its data files hold', () => {
    expect(all.length).toBeGreaterThan(100);
    expect(all).toContain('esp32-ble-advertise');
    expect(all).toContain('esp32c3-ble-advertise');
  });

  it('an overlay with no hook leaves the list as it is', () => {
    expect(listedExamples({ VITE_PRO_BUILD: 'true', PRO_OVERLAY_PATH: overlay({}) })).toEqual(all);
  });

  it('an overlay’s sitemapExampleIds decides which of them the sitemap lists', () => {
    const hook = [
      "const LEFT_OUT = new Set(['esp32-ble-advertise', 'esp32c3-ble-advertise']);",
      'export function sitemapExampleIds(ids) {',
      '  return ids.filter((id) => !LEFT_OUT.has(id));',
      '}',
      '',
    ].join('\n');
    const listed = listedExamples({ VITE_PRO_BUILD: 'true', PRO_OVERLAY_PATH: overlay({ 'sitemap.mjs': hook }) });
    expect(listed).not.toContain('esp32-ble-advertise');
    expect(listed).not.toContain('esp32c3-ble-advertise');
    expect(listed).toEqual(all.filter((id) => id !== 'esp32-ble-advertise' && id !== 'esp32c3-ble-advertise'));
  });

  it('a build without VITE_PRO_BUILD does not ask the overlay', () => {
    const hook = 'export function sitemapExampleIds() { return []; }\n';
    expect(listedExamples({ PRO_OVERLAY_PATH: overlay({ 'sitemap.mjs': hook }) })).toEqual(all);
  });
});
