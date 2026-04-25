/**
 * `@velxio/cli` — programmatic entry. Mirrors the surface of the
 * `velxio-plugin` binary so tests and downstream tooling can drive the
 * same code paths the user invokes from the shell.
 *
 * The shell binary lives in `cli.ts` and only adds argv parsing on top
 * of these functions.
 */

export { runValidate, type ValidateOptions, type ValidateResult } from './commands/validate';
export { runBuild, type BuildOptions, type BuildResult } from './commands/build';
export { runInit, type InitOptions, type InitResult } from './commands/init';
export { CLI_VERSION } from './version';
