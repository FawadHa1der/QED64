#!/bin/bash
# Prints the dev URL for the most recently CHUNKED (unpromoted) runtime + staging snapshots in resident mode.
# The hash comes from the newest chunk log (never from manifest mtimes — the chunker may touch the default).
PORT=${1:-5184}
LOG=$(ls -t work/chunk-*.log 2>/dev/null | head -1)
H=$(grep -oE 'runtime wasm64-[0-9a-f]+' "$LOG" | tail -1 | sed 's/runtime //')
echo "http://localhost:${PORT}/?resident=1&runtime=${H}&snapshots=snapshots-0031${2:+&$2}"
