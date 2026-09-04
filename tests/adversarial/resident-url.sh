#!/usr/bin/env bash
# Prints the resident dev URL for the pairing the dev server actually serves:
# public/snapshots-0031 is a symlink into work/staging/<runtime-id>/snapshots,
# and that directory name is the runtime id the page must boot (KERNEL-PIN:
# snapshots are binary-paired to one runtime). Falls back to the newest
# chunker log only when the symlink is absent.
PORT=${1:-5184}
T=$(readlink public/snapshots-0031 2>/dev/null)
H=$(basename "$(dirname "$T")" 2>/dev/null)
if [[ ! "$H" =~ ^wasm64-[0-9a-f]+$ ]]; then
  LOG=$(ls -t work/chunk-*.log 2>/dev/null | head -1)
  H=$(grep -oE 'runtime wasm64-[0-9a-f]+' "$LOG" | tail -1 | sed 's/runtime //')
fi
echo "http://localhost:${PORT}/?resident=1&runtime=${H}&snapshots=snapshots-0031${2:+&$2}"
