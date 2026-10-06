#!/usr/bin/env bash
# Adopt a lean4-wasm64 release (plan step B2a): fetch and verify it, unpack the base trees, bake
# the two snapshots against its runtime, stage runtime + snapshots (+ packs when they change) under
# work/staging/<buildId>, promote them into an ISOLATED served tree and write the generated
# KERNEL-PIN. Replaces import-packs.sh and bump-chain.sh: the release already did packing, the
# pair/closure checks, the gate, chunking and the build id (docs/REBUILD.md §3).
#
#   pipeline/release/adopt-release.sh --id <lean-vX.Y.Z-hash> --digest sha256:<hex>
#     (--from <https://github.com/FawadHa1der/lean4/releases/download/<id>/> | --from-dir <release dir>)
#     --public <isolated served tree> [--tools <lean4-wasm64 dir>]
#     [--umbrella <dir with QED64/Essential.olean{,.server}> | --rebuild-umbrella] [--fat-tree]
#     [--gate] [--init-lib lean-lib|lean-core] [--allow-served] [--dry-run] [--keep]
#
# lean4-wasm64 runs only as a process: node <tools>/cli.mjs … (<tools>: --tools, else
# $LEAN4_WASM64_DIR, else node_modules/lean4-wasm64). Writes go to work/adopt/<id>/ ($W),
# work/staging/<buildId>/ and --public, never under the release dir or a checkout's public/.
# A runtime-only release (every served pack's raw digest is in release.packs) reuses the umbrella
# pair (--umbrella); otherwise --rebuild-umbrella recompiles it and the packs are staged too.
# --fat-tree also writes $W/lib-tree (no --slim). --dry-run validates and prints the plan, fetching
# and writing nothing. --keep keeps $W/release's chunks and pack parts after a successful run.
# Refusals: one stderr line `adopt-release: …`, exit 2. A failed step: ADOPT-FAIL <step>, exit 1.
# Env: QED64_PUBLIC_DIR (the served tree a release is compared with, default public/; read only),
# QED64_ADOPT_IGNORE_DISK=1 (skip the free-space floor: 12 GB under work/, 16 GB with the fat tree).
set -u
Q=$(cd "$(dirname "$0")/../.." && pwd -P); cd "$Q" || exit 2
H=(node "$Q/pipeline/release/adopt-helper.mjs")
refuse() { echo "adopt-release: $1" >&2; exit 2; }
fail() { echo "ADOPT-FAIL $1"; exit 1; }
say() { echo "== $1 == $(date +%H:%M:%S)"; }
USAGE="usage: adopt-release.sh --id <id> --digest sha256:<hex> (--from <url> | --from-dir <dir>) --public <dir> [--tools <dir>] [--umbrella <dir> | --rebuild-umbrella] [--fat-tree] [--gate] [--init-lib lean-lib|lean-core] [--allow-served] [--dry-run] [--keep]"
ID=""; DIG=""; SRC=""; FROMDIR=0; PUB=""; T=""; UMBD=""; REBUILD=0; FAT=0; GATE=0; INITLIB=lean-lib; ALLOW=(); DRY=0; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in --id|--digest|--from|--from-dir|--public|--tools|--umbrella|--init-lib) [ $# -ge 2 ] && [ -n "$2" ] || refuse "$1 needs a value";; esac
  case "$1" in
    --id) ID=$2; shift 2;; --digest) DIG=$2; shift 2;; --public) PUB=$2; shift 2;; --tools) T=$2; shift 2;;
    --from|--from-dir) [ -z "$SRC" ] || refuse "--from and --from-dir are exclusive"; SRC=$2; [ "$1" = --from-dir ] && FROMDIR=1; shift 2;;
    --umbrella) UMBD=$2; shift 2;; --init-lib) INITLIB=$2; shift 2;; --rebuild-umbrella) REBUILD=1; shift;; --fat-tree) FAT=1; shift;;
    --gate) GATE=1; shift;; --allow-served) ALLOW=(--allow-served); shift;; --dry-run) DRY=1; shift;; --keep) KEEP=1; shift;;
    -h|--help) echo "$USAGE"; exit 0;;
    *) refuse "unknown argument $1 — $USAGE";;
  esac
done
[ -n "$ID" ] || refuse "--id <release id> is required"
[ -n "$DIG" ] || refuse "--digest sha256:<64 hex> is required: a release is pinned by id AND digest"
echo "$ID" | grep -Eq '^lean-v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$' || refuse "--id $ID is not a release id (lean-v<x.y.z>-…)"
echo "$DIG" | grep -Eq '^sha256:[0-9a-f]{64}$' || refuse "--digest $DIG is not sha256:<64 lowercase hex>"
[ -n "$SRC" ] || refuse "--from <release URL> or --from-dir <release dir> is required"
[ -n "$PUB" ] || refuse "--public <isolated served tree> is required"
case "$INITLIB" in lean-lib|lean-core) ;; *) refuse "--init-lib is lean-lib or lean-core, not $INITLIB";; esac
[ -z "$UMBD" ] || [ $REBUILD = 0 ] || refuse "--umbrella and --rebuild-umbrella are exclusive"
T=${T:-${LEAN4_WASM64_DIR:-$Q/node_modules/lean4-wasm64}}
node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name === "lean4-wasm64" ? 0 : 1)' "$T/package.json" 2>/dev/null && [ -f "$T/cli.mjs" ] \
  || refuse "lean4-wasm64 not found at $T — pass --tools <package dir>, set LEAN4_WASM64_DIR, or install it: npm i -D <release tgz URL> (toolchain/lean4-wasm64-release.json names it)"
T=$(cd "$T" && pwd -P); TV=$(node "$T/cli.mjs" --version 2>/dev/null) || refuse "node $T/cli.mjs --version failed: not a usable lean4-wasm64"
if [ $FROMDIR = 1 ]; then [ -f "$SRC/release.json" ] || refuse "--from-dir $SRC holds no release.json"; SRC=$(cd "$SRC" && pwd -P)
else echo "$SRC" | grep -Eq '^https://' || refuse "--from $SRC is not an https:// URL (a local release dir is --from-dir)"; fi
MAIN=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); MAIN=${MAIN%/.git}
FORBID=(--forbid "$Q/public"); [ -n "$MAIN" ] && FORBID+=(--forbid "$MAIN/public"); [ $FROMDIR = 1 ] && FORBID+=(--forbid "$SRC")
"${H[@]}" confine --public "$PUB" "${FORBID[@]}" || exit 2
PUB=$(cd "$PUB" && pwd -P)
for f in runtime/runtime-manifest.json snapshots/index.json profiles/index.json; do
  [ -f "$PUB/$f" ] || refuse "--public $PUB has no $f — fill the isolated tree first: npm run -s fetch:artifacts -- --out $PUB --with-manifests [--release <the served release>]"
done
for d in work work/adopt work/staging; do [ ! -L "$d" ] || refuse "$Q/$d is a symlink: the adoption writes only into this checkout's own work/"; done
case "$Q/" in "$SRC/"*) refuse "this checkout lies inside the release dir $SRC, which is never written";; esac
W="$Q/work/adopt/$ID"; SERVED=${QED64_PUBLIC_DIR:-$Q/public}; FLOOR=$(node -p 'require("./embedding/closure.json").runtime.minKernelPatch')
patch_ge() { echo "$1 $2" | awk '{ if ($1 !~ /^[0-9][0-9][0-9][0-9][a-z]?$/ || $2 !~ /^[0-9][0-9][0-9][0-9][a-z]?$/) exit 2;
  na = substr($1, 1, 4) + 0; nb = substr($2, 1, 4) + 0; exit (na > nb || (na == nb && substr($1, 5) >= substr($2, 5))) ? 0 : 1 }'; }
checkrecord() { # <release.json>: the pin, the floor, the served check and the umbrella mode
  LINE=$("${H[@]}" record --release "$1" --id "$ID" --digest "$DIG" --served "$SERVED" --init-lib "$INITLIB" ${ALLOW[@]+"${ALLOW[@]}"}) || exit 2
  IFS=$'\t' read -r _ _ BID PATCH KCOMMIT LEANVER MODE <<< "$LINE"
  patch_ge "$PATCH" "$FLOOR" || refuse "the release's kernel.patch $PATCH is below embedding/closure.json runtime.minKernelPatch $FLOOR"
  if [ "$MODE" = runtime-only ]; then
    [ $REBUILD = 0 ] || refuse "a runtime-only release reuses the served umbrella pair: pass --umbrella <dir>, not --rebuild-umbrella (a recompile changes the base tree's bytes)"
    [ -n "$UMBD" ] || refuse "a runtime-only release reuses the umbrella pair: pass --umbrella <dir holding QED64/Essential.olean and .olean.server>"
  else
    [ $REBUILD = 1 ] || refuse "the release's packs are not the served ones: pass --rebuild-umbrella (the umbrella is compiled from the new packs)"
    FAT=1
  fi
}
BID="?"; PATCH="?"; KCOMMIT="?"; LEANVER="?"; MODE="?"
if [ $FROMDIR = 1 ]; then checkrecord "$SRC/release.json"; fi
if [ -n "$UMBD" ]; then for f in Essential.olean Essential.olean.server; do [ -s "$UMBD/QED64/$f" ] || refuse "--umbrella $UMBD has no QED64/$f"; done; UMBD=$(cd "$UMBD" && pwd -P); fi
derive() { # what follows from the record: re-run once a URL release's record is fetched
  STAGING="$Q/work/staging/$BID"; NEED_GB=12; [ $FAT = 1 ] && NEED_GB=16
  SKIP=""; [ "$MODE" = runtime-only ] && SKIP=" --skip-packs"; TREES="core-lib-slim lib-tree-slim"; [ $FAT = 1 ] && TREES="$TREES lib-tree"
  USRC="$UMBD/QED64"; [ $REBUILD = 1 ] && USRC="$W/umbrella"
  BAKE=(node --stack-size=8192 pipeline/snapshot/bake-snapshot.mjs --artifact "$W/artifact" --work "$W/snapshot" --out "$STAGING/snapshots")
}
derive; R="$W/release/profiles"; FREE_KB=$(df -Pk "$Q/work" | awk 'NR==2{print $4}')
cat <<EOF
plan for $ID: runtime $BID, Lean $LEANVER, kernel $KCOMMIT (patch $PATCH, floor $FLOOR), $MODE; lean4-wasm64 $TV at $T
  work     $W
  staging  $STAGING
  public   $PUB
  disk     $((${FREE_KB:-0} / 1048576)) GB free under $Q/work, floor $NEED_GB GB
  fetch           node $T/cli.mjs fetch --from $SRC --out $W/release --only runtime-chunks,lean-lib,lean-core,mathlib-essential --id $ID --digest $DIG
                  node $T/cli.mjs fetch --from $SRC --out $W/artifact --only runtime --id $ID --digest $DIG
  verify          $([ $FROMDIR = 1 ] && echo "node $T/cli.mjs verify --release $SRC$SKIP" || echo "skipped: --from is a URL (the fetch verifies every file against the pinned record)")
  checks          the --id/--digest pin, kernel.patch >= $FLOOR, runtime not the served one${ALLOW[@]+" (--allow-served: a rehearsal)"}, umbrella mode
  artifact-lib    rm -rf $W/artifact/lib; node $T/cli.mjs unpack --manifest $R/lean-lib.manifest.json --out $W/artifact/lib/lean
  base-trees      rm -rf $(for t in $TREES; do printf '%s ' "$W/$t"; done)
                  node $T/cli.mjs unpack --slim --manifest $R/$INITLIB.manifest.json --out $W/core-lib-slim
                  node $T/cli.mjs unpack --slim --manifest $R/{lean-core,mathlib-essential}.manifest.json --out $W/lib-tree-slim$([ $FAT = 1 ] && printf '\n                  node %s unpack --manifest %s/{lean-core,mathlib-essential}.manifest.json --out %s/lib-tree' "$T/cli.mjs" "$R" "$W")
  umbrella        $([ $REBUILD = 1 ] && echo "node pipeline/artifacts/gen-umbrella.mjs --manifest $R/mathlib-essential.manifest.json --out $USRC/Essential.lean; node pipeline/snapshot/supervised-run.mjs --target $USRC/Essential.olean -- --artifact $W/artifact --work $USRC --lib $W/lib-tree -- -o /work/Essential.olean /work/Essential.lean; then " || echo "reuse ")cp $USRC/Essential.olean{,.server} → $(for t in $TREES; do [ $t = core-lib-slim ] || printf '%s ' "$W/$t/QED64/"; done)$([ $FAT = 1 ] && echo " (+ Essential.olean.private into lib-tree: $([ $REBUILD = 1 ] || [ -f "$USRC/Essential.olean.private" ] && echo present || echo "ABSENT in the source, pair only"))")$([ $REBUILD = 1 ] && echo "; node $T/cli.mjs olean-imports --audit $W/lib-tree")
  base-tree       node pipeline/release/adopt-helper.mjs base-tree → $W/base-tree.json (packs, umbrella sha256/bytes, tree digests of: $TREES)
  gate            $([ $GATE = 1 ] && echo "node $T/cli.mjs gate --artifact $W/artifact > $W/logs/gate.log (' ok ' lines and GATE PASSED)" || echo "skipped (no --gate; recommended for an unpublished release)")
  bake-init       ${BAKE[*]} --name init --lib $W/core-lib-slim --reserve 1073741824
  bake-mathlib    ${BAKE[*]} --name mathlib --lib $W/lib-tree-slim --reserve 3221225472 --probe 'import QED64.Essential'
  stage-runtime   cp $W/release/runtime/runtime-manifest.json + chunks/ → $STAGING/runtime/ (no chunker, no restamp)
  stage-profiles  $([ "$MODE" = packs-change ] && echo "node pipeline/release/stage-profiles.mjs --packs $R --build-id $BID --lean-version $LEANVER --expect-modules $W/release/lists/essential-modules.txt --out $STAGING/profiles" || echo "none: the served packs stay (a kernel-only promote re-points profiles/index.json)")
  pairing         the staged runtime manifest and both snapshot entries name $BID, Lean $LEANVER
  promote         node pipeline/release/promote-staging.mjs --staging $STAGING --public $PUB --dry-run, then without --dry-run
                  node pipeline/release/verify-release.mjs --public $PUB; cmp $PUB/runtime/runtime-manifest.json $W/release/runtime/runtime-manifest.json
  kernel-pin      node pipeline/release/adopt-helper.mjs kernel-pin → $W/KERNEL-PIN
  next            print the operator's landing steps (not performed)
EOF
if [ $DRY = 1 ]; then echo "DRY RUN — inputs valid, nothing was fetched or written"; exit 0; fi
[ "${FREE_KB:-0}" -ge $((NEED_GB * 1048576)) ] || [ -n "${QED64_ADOPT_IGNORE_DISK:-}" ] || fail "disk: less than $NEED_GB GB free under $Q/work (set QED64_ADOPT_IGNORE_DISK=1 to override)"
mkdir -p "$W/logs" || fail "cannot create $W"; L="$W/logs"
step() { local name=$1; shift; "$@" > "$L/$name.log" 2>&1 || { tail -8 "$L/$name.log"; fail "$name ($L/$name.log)"; }; }
pkg() { node "$T/cli.mjs" "$@"; }
say fetch
[ $FROMDIR = 1 ] || { step fetch-record pkg fetch --from "$SRC" --out "$W/release" --only lists --id "$ID" --digest "$DIG"; checkrecord "$W/release/release.json"; derive; echo "record: runtime $BID, kernel.patch $PATCH, $MODE"; }
step fetch-release pkg fetch --from "$SRC" --out "$W/release" --only runtime-chunks,lean-lib,lean-core,mathlib-essential --id "$ID" --digest "$DIG"
step fetch-artifact pkg fetch --from "$SRC" --out "$W/artifact" --only runtime --id "$ID" --digest "$DIG"
[ "$MODE" = runtime-only ] || step fetch-lists pkg fetch --from "$SRC" --out "$W/release" --only lists --id "$ID" --digest "$DIG"
checkrecord "$W/release/release.json"; [ "$STAGING" = "$Q/work/staging/$BID" ] || fail "the fetched record names runtime $BID, not the one planned"
if [ $FROMDIR = 1 ]; then say verify; step verify pkg verify --release "$SRC"${SKIP}; grep -E '^RELEASE' "$L/verify.log"; fi
say artifact-lib; rm -rf "$W/artifact/lib"; step artifact-lib pkg unpack --manifest "$R/lean-lib.manifest.json" --out "$W/artifact/lib/lean"
[ -n "$(find "$W/artifact/lib/lean" -name '*.ilean' -print -quit)" ] || echo "note: lean-lib carries no .ilean files: the persistent-path test's patch-0010 check (docs/TESTING.md) is skipped on $W/artifact, not failed (the test runs)" | tee -a "$L/notes.log"
say base-trees; for t in $TREES; do rm -rf "${W:?}/$t"; done
step core-lib-slim pkg unpack --slim --manifest "$R/$INITLIB.manifest.json" --out "$W/core-lib-slim"
for m in lean-core mathlib-essential; do
  step "lib-tree-slim-$m" pkg unpack --slim --manifest "$R/$m.manifest.json" --out "$W/lib-tree-slim"
  [ $FAT = 0 ] || step "lib-tree-$m" pkg unpack --manifest "$R/$m.manifest.json" --out "$W/lib-tree"
done
say umbrella
if [ $REBUILD = 1 ]; then
  rm -rf "$USRC"; mkdir -p "$USRC"; step umbrella-gen node pipeline/artifacts/gen-umbrella.mjs --manifest "$R/mathlib-essential.manifest.json" --out "$USRC/Essential.lean"
  step umbrella-compile node pipeline/snapshot/supervised-run.mjs --target "$USRC/Essential.olean" -- --artifact "$W/artifact" --work "$USRC" --lib "$W/lib-tree" -- -o /work/Essential.olean /work/Essential.lean
fi
for t in $TREES; do [ $t = core-lib-slim ] || { mkdir -p "$W/$t/QED64" && cp "$USRC/Essential.olean" "$USRC/Essential.olean.server" "$W/$t/QED64/"; } || fail "umbrella copy into $W/$t"; done
if [ $FAT = 1 ]; then if [ -f "$USRC/Essential.olean.private" ]; then cp "$USRC/Essential.olean.private" "$W/lib-tree/QED64/" || fail "umbrella copy into $W/lib-tree"
  else echo "note: $USRC has no Essential.olean.private: $W/lib-tree carries the umbrella pair only" | tee -a "$L/notes.log"; fi; fi
[ $REBUILD = 0 ] || { step audit pkg olean-imports --audit "$W/lib-tree"; grep -E '^import-all audit|outside Init' "$L/audit.log"; }
say base-tree; step base-tree "${H[@]}" base-tree --work "$W" --release "$W/release/release.json" --init-lib "$INITLIB" --umbrella-source "$([ $REBUILD = 1 ] && echo "rebuilt with $BID" || echo "reused from $UMBD")" $([ $FAT = 1 ] && echo --fat); cat "$L/base-tree.log"
[ $GATE = 0 ] || { say gate; pkg gate --artifact "$W/artifact" > "$L/gate.log" 2>&1; grep -E '^(FAIL| ok )' "$L/gate.log"; grep -q '^ ok ' "$L/gate.log" && grep -q '^GATE PASSED' "$L/gate.log" || fail "gate ($L/gate.log)"; }
rm -rf "$STAGING"; mkdir -p "$STAGING/runtime" || fail "cannot create $STAGING"
say bake-init; step bake-init "${BAKE[@]}" --name init --lib "$W/core-lib-slim" --reserve 1073741824
say bake-mathlib; step bake-mathlib "${BAKE[@]}" --name mathlib --lib "$W/lib-tree-slim" --reserve 3221225472 --probe 'import QED64.Essential'
grep -hE '^baked' "$L/bake-init.log" "$L/bake-mathlib.log" | cut -c1-200
say stage-runtime; cp "$W/release/runtime/runtime-manifest.json" "$STAGING/runtime/" && cp -R "$W/release/runtime/chunks" "$STAGING/runtime/" || fail "stage-runtime"
[ "$MODE" = runtime-only ] || { say stage-profiles; step stage-profiles node pipeline/release/stage-profiles.mjs --packs "$R" --build-id "$BID" --lean-version "$LEANVER" --expect-modules "$W/release/lists/essential-modules.txt" --out "$STAGING/profiles"; tail -1 "$L/stage-profiles.log"; }
say pairing
node -e '
  const fs = require("fs"); const [dir, id, ver] = process.argv.slice(1);
  const rt = JSON.parse(fs.readFileSync(`${dir}/runtime/runtime-manifest.json`, "utf8"));
  const sn = JSON.parse(fs.readFileSync(`${dir}/snapshots/index.json`, "utf8"));
  const bad = [];
  if (rt.buildId !== id) bad.push(`runtime manifest is ${rt.buildId}`);
  if (rt.leanVersion !== ver) bad.push(`runtime manifest says Lean ${rt.leanVersion}`);
  for (const name of ["init", "mathlib"]) {
    const e = sn.snapshots.find((s) => s.name === name);
    if (!e) bad.push(`no ${name} snapshot in the staged index`);
    else if (e.runtime !== id) bad.push(`${name} snapshot is paired with ${e.runtime}`);
  }
  if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
  console.log(`staged pairing ${id}: ` + sn.snapshots.map((s) => `${s.name} ${s.bytes} raw / ${s.transfer} wire`).join(", "));
' "$STAGING" "$BID" "$LEANVER" || fail "the staged pairing under $STAGING is not complete"
say promote
step promote-dry node pipeline/release/promote-staging.mjs --staging "$STAGING" --public "$PUB" --dry-run; tail -2 "$L/promote-dry.log"
step promote node pipeline/release/promote-staging.mjs --staging "$STAGING" --public "$PUB"; tail -3 "$L/promote.log"
step verify-public node pipeline/release/verify-release.mjs --public "$PUB"; tail -2 "$L/verify-public.log"
cmp "$PUB/runtime/runtime-manifest.json" "$W/release/runtime/runtime-manifest.json" || fail "the promoted runtime manifest is not the release's bytes"
say kernel-pin; step kernel-pin "${H[@]}" kernel-pin --work "$W" --release "$W/release/release.json" --init-lib "$INITLIB" --staging "work/staging/$BID/{runtime,snapshots$([ "$MODE" = runtime-only ] || echo ,profiles)}"; cat "$L/kernel-pin.log"
[ $KEEP = 1 ] || rm -rf "$W/release/runtime/chunks" "$R"/*.part-[0-9]*
cat <<EOF

ADOPT-STAGED $ID — runtime $BID promoted into $PUB (nothing under any checkout's public/ was touched)
  artifact $W/artifact   base trees $(for t in $TREES; do printf '%s ' "$W/$t"; done)  raw snapshots $W/snapshot
Landing, by the operator (NOT performed here):
 1. cp $W/release/release.json toolchain/lean4-wasm64-release.json
 2. cp $W/KERNEL-PIN pipeline/toolchain/KERNEL-PIN
 3. cp $PUB/runtime/runtime-manifest.json public/runtime/; cp $PUB/snapshots/index.json public/snapshots/; cp $PUB/profiles/index.json public/profiles/$([ "$MODE" = runtime-only ] || echo " (+ the two pack manifests)")
 4. once published: npm install --package-lock-only -D https://github.com/FawadHa1der/lean4/releases/download/$ID/lean4-wasm64-$TV.tgz
 5. the wrangler var naming the release (plan B2b)
 6. USER: upload the snapshots (scripts/upload-artifacts.sh), then push and deploy
EOF
