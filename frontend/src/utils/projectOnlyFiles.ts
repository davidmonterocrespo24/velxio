/**
 * Project-only files: files that belong to a project (saved, shared, exported
 * and edited like any other) but never to the device. They are not sent to
 * the compiler, not counted in the compile fingerprint, not written to an
 * emulated MicroPython filesystem, not baked into the microSD image and not
 * copied into a Linux guest.
 *
 * The open-source build declares none. An overlay installs a predicate on
 * `globalThis.__velxio_project_only_file__`, the same kind of seam as
 * `__velxio_prebuilt_firmware__`, so a build without an overlay pays nothing.
 * The predicate gets the file name and answers whether it stays with the
 * project; a predicate that throws counts as "no", so a broken overlay can
 * never hide a source file from the compiler.
 *
 * A name rule and not an extension rule on purpose: a MicroPython web server
 * serving index.html from its flash needs that file on the device.
 */

type ProjectOnlyPredicate = (name: string) => boolean;

export function isProjectOnlyFile(name: string): boolean {
  const predicate = (globalThis as { __velxio_project_only_file__?: ProjectOnlyPredicate })
    .__velxio_project_only_file__;
  if (!predicate) return false;
  try {
    return predicate(name) === true;
  } catch {
    return false;
  }
}

/** The files that go to the device: everything but the project-only ones. */
export function deviceFiles<T extends { name: string }>(files: readonly T[]): T[] {
  return files.filter((f) => !isProjectOnlyFile(f.name));
}
