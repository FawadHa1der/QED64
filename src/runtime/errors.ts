// Failure classification for compile-time exceptions.
//
// Compile diagnostics (Lean errors in user code) never reach these helpers —
// they arrive as structured results. What reaches the catch path is
// infrastructure failure, and one family is recoverable: the browser
// invalidating the storage behind a mounted library pack mid-session.
// Observed live (Electron pane, after an OPFS quota event): every WORKERFS
// read fails with FileReaderSync NotFoundError while the OPFS directory
// silently reports empty — the session's File objects are dead, but a
// reinstall (which revalidates the cache or re-downloads) plus a reboot
// fully recovers.

/** True when a compile-path exception means the storage behind a mounted
 * library pack went stale (deleted, evicted, or snapshot-invalidated) —
 * i.e. reinstall + reboot is worth one automatic attempt. */
export function isStaleStorageError(message: string): boolean {
  return (
    /FileReaderSync|FileReader/.test(message) ||
    /NotFoundError|NotReadableError/.test(message) ||
    /could not be found at the time an operation was processed/i.test(message) ||
    /requested file could not be read/i.test(message)
  );
}
