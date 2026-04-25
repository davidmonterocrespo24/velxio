/**
 * Hard-coded so the bundled CJS does not depend on `require('../package.json')`,
 * which esbuild will not resolve unless we mark the JSON as external.
 * Bumped manually in lock-step with `package.json`.
 */
export const CLI_VERSION = '0.1.0';
