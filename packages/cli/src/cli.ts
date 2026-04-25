/**
 * `velxio-plugin` shell binary. Thin argv→command adapter — every command
 * delegates to the same library function exposed by `index.ts`, so tests
 * exercise the real code path without subprocess boilerplate.
 *
 * Exit codes:
 *   0 — success
 *   1 — validation/build/init failure (user error or invalid manifest)
 *   2 — unexpected internal error (bug in the CLI itself)
 */

import { Command, InvalidArgumentError } from 'commander';
import { runValidate } from './commands/validate';
import { runBuild } from './commands/build';
import { runInit, type TemplateName } from './commands/init';
import { CLI_VERSION } from './version';

const ALLOWED_TEMPLATES: ReadonlyArray<TemplateName> = ['component'];

function parseTemplate(value: string): TemplateName {
  if ((ALLOWED_TEMPLATES as ReadonlyArray<string>).includes(value)) {
    return value as TemplateName;
  }
  throw new InvalidArgumentError(
    `unknown template "${value}" (available: ${ALLOWED_TEMPLATES.join(', ')})`,
  );
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const program = new Command();
  program
    .name('velxio-plugin')
    .description('Author CLI for Velxio plugins')
    .version(CLI_VERSION);

  let exitCode = 0;

  program
    .command('validate')
    .description('Validate manifest.json against the SDK schema')
    .option('--manifest <path>', 'path to manifest.json (default: ./manifest.json)')
    .action(async (opts: { manifest?: string }) => {
      const result = await runValidate(
        opts.manifest !== undefined ? { manifestPath: opts.manifest } : {},
      );
      for (const line of result.lines) console.log(line);
      exitCode = result.ok ? 0 : 1;
    });

  program
    .command('build')
    .description('Bundle the plugin (esbuild) and emit dist/manifest.json + integrity.json')
    .option('--entry <path>', 'entry source file (default: src/index.ts)')
    .option('--outdir <path>', 'output directory (default: dist)')
    .option('--manifest <path>', 'path to manifest.json (default: ./manifest.json)')
    .option('--no-minify', 'disable minification (useful for debugging)')
    .action(async (opts: { entry?: string; outdir?: string; manifest?: string; minify?: boolean }) => {
      const buildOpts: {
        entry?: string;
        outdir?: string;
        manifestPath?: string;
        minify?: boolean;
      } = {};
      if (opts.entry !== undefined) buildOpts.entry = opts.entry;
      if (opts.outdir !== undefined) buildOpts.outdir = opts.outdir;
      if (opts.manifest !== undefined) buildOpts.manifestPath = opts.manifest;
      if (opts.minify !== undefined) buildOpts.minify = opts.minify;
      const result = await runBuild(buildOpts);
      for (const line of result.lines) console.log(line);
      exitCode = result.ok ? 0 : 1;
    });

  program
    .command('init <name>')
    .description('Scaffold a new plugin project from a template')
    .option('-t, --template <name>', `template (${ALLOWED_TEMPLATES.join(' | ')})`, parseTemplate, 'component')
    .option('--force', 'overwrite an existing non-empty target directory')
    .action(async (name: string, opts: { template: TemplateName; force?: boolean }) => {
      const initOpts: {
        name: string;
        template: TemplateName;
        force?: boolean;
      } = {
        name,
        template: opts.template,
      };
      if (opts.force !== undefined) initOpts.force = opts.force;
      const result = await runInit(initOpts);
      for (const line of result.lines) console.log(line);
      exitCode = result.ok ? 0 : 1;
    });

  try {
    await program.parseAsync(argv as string[], { from: 'user' });
  } catch (err) {
    if (err instanceof InvalidArgumentError) {
      console.error(`✗ ${err.message}`);
      return 1;
    }
    console.error('✗ unexpected error:', err);
    return 2;
  }

  return exitCode;
}

// Auto-run when invoked as the bin (commander's parseAsync ignores
// `import.meta` so we use a direct argv check). When loaded as a library
// (e.g. for tests), `main` is invoked explicitly.
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      console.error('✗ fatal:', err);
      process.exit(2);
    },
  );
}
