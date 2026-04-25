/**
 * `runValidate` tests — covers the read-failure / JSON-parse / Zod-fail /
 * happy-path branches. The Zod content itself is exhaustively tested in
 * the SDK; here we only assert the CLI's framing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runValidate } from '../src/commands/validate';
import { makeTmpDir, rmDir, VALID_MANIFEST } from './helpers';

const tmpdirs: string[] = [];

afterEach(async () => {
  while (tmpdirs.length) await rmDir(tmpdirs.pop()!);
});

async function newProject(manifest: unknown): Promise<string> {
  const dir = await makeTmpDir();
  tmpdirs.push(dir);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

describe('runValidate', () => {
  it('reports success on a well-formed manifest', async () => {
    const dir = await newProject(VALID_MANIFEST);
    const result = await runValidate({ cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toMatch(/^✓ sample-plugin@0\.1\.0/);
  });

  it('returns a typed failure when manifest.json does not exist', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    const result = await runValidate({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/cannot read manifest/);
  });

  it('rejects malformed JSON with a parse error', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    await fs.writeFile(path.join(dir, 'manifest.json'), '{ not json }', 'utf8');
    const result = await runValidate({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/not valid JSON/);
  });

  it('returns Zod issues, one per line, with dot-paths', async () => {
    const dir = await newProject({ ...VALID_MANIFEST, version: 'not-semver', id: 'X' });
    const result = await runValidate({ cwd: dir });
    expect(result.ok).toBe(false);
    const joined = result.lines.join('\n');
    expect(joined).toMatch(/version/);
    expect(joined).toMatch(/id/);
    // Every issue line is indented two spaces — keeps the output machine-greppable.
    const issueLines = result.lines.slice(1);
    expect(issueLines.every((l) => l.startsWith('  '))).toBe(true);
  });

  it('honors an explicit --manifest path', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    const altPath = path.join(dir, 'plugin.json');
    await fs.writeFile(altPath, JSON.stringify(VALID_MANIFEST), 'utf8');
    const result = await runValidate({ cwd: dir, manifestPath: 'plugin.json' });
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(altPath);
  });

  it('flags the cross-field semantic check (http.fetch without allowlist)', async () => {
    // SDK's semantic check runs after Zod and surfaces a normal issue line.
    const dir = await newProject({ ...VALID_MANIFEST, permissions: ['http.fetch'] });
    const result = await runValidate({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/http\.allowlist/);
  });
});
