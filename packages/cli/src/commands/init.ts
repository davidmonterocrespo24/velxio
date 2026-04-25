/**
 * `velxio-plugin init <name> [--template component]` — generates a new
 * plugin project ready for `npm install` + `npm run build`.
 *
 * Templates are emitted programmatically (no on-disk template directory)
 * so the published CJS bundle is self-contained — no `files: [templates]`
 * trickery and no runtime `__dirname` resolution that breaks under bundlers.
 *
 * Currently only the `component` template is supported. The other shapes
 * from the SDK-009 roadmap (template/library/hook/panel/theme) ship in
 * SDK-009-step1b once we have feedback from the first batch of authors.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLI_VERSION } from '../version';
import { renderComponentTemplate, type TemplateFile } from '../templates/component';

export type TemplateName = 'component';

export interface InitOptions {
  /** Slug-like project name. Becomes `manifest.id` and the folder name. */
  readonly name: string;
  /** Template to scaffold from. Defaults to `component`. */
  readonly template?: TemplateName;
  /** Parent directory the project folder is created in. Defaults to cwd. */
  readonly cwd?: string;
  /** Force overwrite if target already exists. Defaults to false. */
  readonly force?: boolean;
}

export interface InitResult {
  readonly ok: boolean;
  readonly projectDir: string;
  readonly files: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string>;
}

const NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;
const TEMPLATES: Record<TemplateName, (name: string) => ReadonlyArray<TemplateFile>> = {
  component: renderComponentTemplate,
};

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const template = opts.template ?? 'component';
  const projectDir = path.resolve(cwd, opts.name);

  if (!NAME_RE.test(opts.name)) {
    return {
      ok: false,
      projectDir,
      files: [],
      lines: [
        `✗ "${opts.name}" is not a valid plugin id`,
        '  must be kebab-case, 3–64 chars, start with a letter (e.g. "my-led-driver")',
      ],
    };
  }

  const renderer = TEMPLATES[template];
  if (!renderer) {
    return {
      ok: false,
      projectDir,
      files: [],
      lines: [`✗ unknown template "${template}" (available: ${Object.keys(TEMPLATES).join(', ')})`],
    };
  }

  // Existence check. We only refuse on a non-empty target — an empty dir
  // (mkdir + cd before init) is the common "already created the folder"
  // workflow and shouldn't be a tripwire.
  const exists = await dirExists(projectDir);
  if (exists && !opts.force) {
    const entries = await fs.readdir(projectDir);
    if (entries.length > 0) {
      return {
        ok: false,
        projectDir,
        files: [],
        lines: [
          `✗ ${projectDir} already exists and is not empty`,
          '  pass --force to overwrite, or pick a different name',
        ],
      };
    }
  }

  await fs.mkdir(projectDir, { recursive: true });

  const files = renderer(opts.name);
  const written: string[] = [];
  for (const file of files) {
    const abs = path.join(projectDir, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.contents, 'utf8');
    written.push(file.path);
  }

  return {
    ok: true,
    projectDir,
    files: written,
    lines: [
      `✓ created ${path.relative(cwd, projectDir) || '.'} from template "${template}" (CLI v${CLI_VERSION})`,
      ...written.map((f) => `  + ${f}`),
      '',
      'Next steps:',
      `  cd ${path.relative(cwd, projectDir) || '.'}`,
      '  npm install',
      '  npm run build',
    ],
  };
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
