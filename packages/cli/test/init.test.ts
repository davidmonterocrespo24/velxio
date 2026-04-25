/**
 * `runInit` tests — verifies the scaffolded project is shaped such that
 * the generated `manifest.json` itself passes `runValidate`. That is the
 * end-to-end smoke: scaffold → validate without any author edits.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runInit } from '../src/commands/init';
import { runValidate } from '../src/commands/validate';
import { makeTmpDir, rmDir } from './helpers';

const tmpdirs: string[] = [];

afterEach(async () => {
  while (tmpdirs.length) await rmDir(tmpdirs.pop()!);
});

describe('runInit', () => {
  it('generates a project whose manifest.json passes validate', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    const result = await runInit({ name: 'test-led', cwd: dir });
    expect(result.ok).toBe(true);

    const projectDir = path.join(dir, 'test-led');
    expect(result.projectDir).toBe(projectDir);

    const expected = ['package.json', 'manifest.json', 'src/index.ts', 'tsconfig.json', '.gitignore', 'README.md'];
    for (const f of expected) {
      await expect(fs.access(path.join(projectDir, f))).resolves.toBeUndefined();
    }

    const validation = await runValidate({ cwd: projectDir });
    expect(validation.ok).toBe(true);
  });

  it('rejects names that are not kebab-case ids', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    const result = await runInit({ name: 'NotKebab', cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/kebab-case/);
  });

  it('refuses to overwrite a non-empty target without --force', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    const target = path.join(dir, 'occupied');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'README.md'), 'existing\n', 'utf8');
    const result = await runInit({ name: 'occupied', cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/already exists/);
  });

  it('overwrites with --force', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    const target = path.join(dir, 'occupied');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'old.txt'), 'stale\n', 'utf8');
    const result = await runInit({ name: 'occupied', cwd: dir, force: true });
    expect(result.ok).toBe(true);
    // We don't sweep the target — the new files coexist with the old.
    await expect(fs.access(path.join(target, 'manifest.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(target, 'old.txt'))).resolves.toBeUndefined();
  });

  it('accepts an empty target directory without --force', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    await fs.mkdir(path.join(dir, 'fresh'));
    const result = await runInit({ name: 'fresh', cwd: dir });
    expect(result.ok).toBe(true);
  });

  it('embeds the project name in the manifest id', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    await runInit({ name: 'cool-driver', cwd: dir });
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'cool-driver', 'manifest.json'), 'utf8'),
    );
    expect(manifest.id).toBe('cool-driver');
    expect(manifest.name).toBe('Cool Driver');
  });

  it('seeds package.json scripts that point at the CLI', async () => {
    const dir = await makeTmpDir();
    tmpdirs.push(dir);
    await runInit({ name: 'driver-x', cwd: dir });
    const pkg = JSON.parse(
      await fs.readFile(path.join(dir, 'driver-x', 'package.json'), 'utf8'),
    );
    expect(pkg.scripts.build).toBe('velxio-plugin build');
    expect(pkg.scripts.validate).toBe('velxio-plugin validate');
    expect(pkg.devDependencies['@velxio/cli']).toBeDefined();
    expect(pkg.dependencies['@velxio/sdk']).toBeDefined();
  });
});
