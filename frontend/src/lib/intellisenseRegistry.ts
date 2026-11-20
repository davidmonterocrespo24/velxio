/**
 * Intellisense registry.
 *
 * Seam between the OSS editor and the pro overlay's code-completion engine
 * (the private `velxio-intellisense` package). The built-in providers defer
 * completion and hover to that engine when an overlay registers one.
 *
 * Two-sided handshake, because arrival order is not guaranteed:
 *
 *   - CodeEditor's `beforeMount` calls `attachIntellisenseMonaco(monaco)`
 *     every time an editor instance is created (which happens on every
 *     file switch — the editor is keyed by file id).
 *   - The overlay calls `installIntellisenseImpl(impl)` from `mountPro()`,
 *     which lands via an async `import('@pro/index')` and may resolve
 *     before or after the first editor mounted.
 *
 * Whichever side arrives last triggers the install. The impl itself is
 * responsible for being idempotent per monaco instance (the package guards
 * with a WeakSet), so replaying it on every mount is safe and cheap.
 */

type IntellisenseImpl = (monaco: unknown) => void;

let _impl: IntellisenseImpl | null = null;
let _monaco: unknown = null;

export function installIntellisenseImpl(impl: IntellisenseImpl | null): void {
  _impl = impl;
  if (_impl && _monaco) run(_impl, _monaco);
}

export function attachIntellisenseMonaco(monaco: unknown): void {
  _monaco = monaco;
  if (_impl) run(_impl, monaco);
}

export function hasIntellisenseImpl(): boolean {
  return _impl !== null;
}

function run(impl: IntellisenseImpl, monaco: unknown): void {
  try {
    impl(monaco);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] intellisense impl threw:', err);
  }
}

/**
 * Compile-diagnostics seam. The editor toolbar publishes the raw compiler
 * output after every build (empty string on success, to clear); with the
 * pro overlay loaded, its sink parses gcc/mpy positions out of the text
 * and paints Monaco markers on the affected lines. Inert in OSS.
 */

type CompileOutputSink = (raw: string) => void;

let _compileSink: CompileOutputSink | null = null;

export function installCompileDiagnosticsSink(sink: CompileOutputSink | null): void {
  _compileSink = sink;
}

export function publishCompileOutput(raw: string): void {
  try {
    _compileSink?.(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] compile-diagnostics sink threw:', err);
  }
}
