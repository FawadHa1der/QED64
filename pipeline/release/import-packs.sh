#!/usr/bin/env bash
# Version-import lane: turn a kernel build dir K (built elsewhere, a new
# upstream Lean + the matching Mathlib) into a STAGED pairing — runtime,
# snapshots, library packs, manifests and profile index under
# work/staging/<buildId>/ — with nothing served touched. Promotion is a
# separate, single step afterwards.
#
#   pipeline/release/import-packs.sh <K> --lean-version <x.y.z> [--scratch <dir>]
#                                    [--dry-run] [--only <step>[,<step>…]] [--from <step>]
#
# The K contract (validated first, every violation listed):
#   K/build/stage1/bin/{lean.js,lean.wasm}   the wasm64 runtime
#   K/build/stage1/lib/lean                  its core library, five facets per module
#   K/BUILT-COMMIT                           kernel commit, 40 hex
#   K/mathlib/essential-tree/                flat olean tree: the import closure of the essential roots
#                                            minus Init/Init.*, from the matching Mathlib + its Lake deps
#                                            + the kernel's Std/Lean
#   K/mathlib/essential-modules.txt          the module list of that tree
#   K/mathlib/MATHLIB-COMMIT                 Mathlib commit, 40 hex
#
# Steps (each guarded; logs are files under <scratch>/logs):
#   pack-core     lean-core from K's Init closure            → <scratch>/packs
#   pack-mathlib  mathlib-essential from the essential tree  → <scratch>/packs
#   pack-extra    OPTIONAL: K/mathlib/extra-tree → work/staging/<buildId>/extra/mathlib-game-extra.* — an additive
#                 pack only the lean4game port mounts (its MATHLIB_EXTRA_MANIFEST). Never in profiles/, never in the
#                 profile index, never promoted, not in the umbrella or the bakes. Skipped when K does not stage it.
#   check         the two manifests as one import-closed library (stage-profiles --check-only)
#   unpack        both manifests into a FRESH <scratch>/lib-tree — the tree the browser will see
#   umbrella      QED64/Essential.lean from the NEW manifest, compiled with the NEW runtime
#   audit         the `import all` edges of the new tree (static half of the slim-bake audit)
#   profiles      work/staging/<buildId>/profiles (index + manifests + parts)
#   stage         bump-chain.sh stage-artifact: gate, chunk, slim trees, both bakes → work/staging/<buildId>
#   next          what the operator does next
# --only runs just the named steps, --from that step and every later one (resuming
# after a failure: `--from <the step that failed>`). --dry-run validates and
# prints the plan; it runs no pack, compile or bake.
#
# The lane writes under <scratch> (default work/import-<buildId>) and
# work/staging/<buildId> only — never public/, never work/snapshot, never
# work/lib-tree*. id / mount point / roots of both packs are read from the
# SERVED manifests, so the new packs mirror them.
set -u
Q=$(cd "$(dirname "$0")/../.." && pwd); cd "$Q"
STEPS="pack-core pack-mathlib pack-extra check unpack umbrella audit profiles stage next"
stage() { echo "== $1 == $(date +%H:%M:%S)"; }
fail() { echo "IMPORT-FAIL $1"; exit 1; }
usage() { echo "usage: $0 <K> --lean-version <x.y.z> [--scratch <dir>] [--dry-run] [--only <step>[,<step>…]] [--from <step>]   (steps: $STEPS)"; exit 2; }

K=""; LEANVER=""; SCRATCH=""; DRY=0; ONLY=""; FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lean-version) [ $# -ge 2 ] || usage; LEANVER=$2; shift 2;;
    --scratch)      [ $# -ge 2 ] || usage; SCRATCH=$2; shift 2;;
    --only)         [ $# -ge 2 ] || usage; ONLY=$2; shift 2;;
    --from)         [ $# -ge 2 ] || usage; FROM=$2; shift 2;;
    --dry-run)      DRY=1; shift;;
    -h|--help)      usage;;
    --*)            echo "unknown option $1"; usage;;
    *)              [ -z "$K" ] || usage; K=$1; shift;;
  esac
done
[ -n "$K" ] || usage
[ -z "$ONLY" ] || [ -z "$FROM" ] || { echo "--only and --from are exclusive"; usage; }

# Which steps run.
RUN=""
if [ -n "$ONLY" ]; then
  for s in $(echo "$ONLY" | tr ',' ' '); do
    case " $STEPS " in *" $s "*) RUN="$RUN $s";; *) echo "unknown step '$s'"; usage;; esac
  done
elif [ -n "$FROM" ]; then
  case " $STEPS " in *" $FROM "*) ;; *) echo "unknown step '$FROM'"; usage;; esac
  on=0; for s in $STEPS; do [ "$s" = "$FROM" ] && on=1; [ $on = 1 ] && RUN="$RUN $s"; done
else
  RUN=" $STEPS"
fi
want() { case " $RUN " in *" $1 "*) return 0;; esac; return 1; }

# ---- (0) the K contract, loudly ------------------------------------------
stage "validate"
PROBLEMS=0
problem() { echo "  MISSING  $1"; PROBLEMS=$((PROBLEMS + 1)); }
present() { echo "  ok       $1"; }
[ -d "$K" ] || fail "K=$K is not a directory"
K=$(cd "$K" && pwd -P)   # canonical: logs and refusals name the real path
ART="$K/build/stage1"; KLIB="$ART/lib/lean"; TREE="$K/mathlib/essential-tree"
if [ -z "$LEANVER" ]; then problem "--lean-version <x.y.z> (required; there is no default — every manifest, the runtime manifest and the profile index carry it)"
elif ! echo "$LEANVER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$'; then problem "--lean-version '$LEANVER' is not x.y.z[-tag] (no leading v)"
else present "--lean-version $LEANVER"; fi
for f in "$ART/bin/lean.js" "$ART/bin/lean.wasm" "$KLIB/Init.olean" "$KLIB/Init.olean.server" "$KLIB/Init.olean.private" "$KLIB/Init.ir" "$KLIB/Init.ir.sig" "$KLIB/Init/Prelude.olean"; do
  if [ -s "$f" ]; then present "$f"; else problem "$f"; fi
done
hex40() { [ -f "$1" ] && tr -d ' \n\r' < "$1" | grep -Eq '^[0-9a-f]{40}$'; }
if hex40 "$K/BUILT-COMMIT"; then COMMIT=$(tr -d ' \n\r' < "$K/BUILT-COMMIT"); present "$K/BUILT-COMMIT ($COMMIT)"
elif [ -f "$K/BUILT-COMMIT" ]; then COMMIT=""; problem "$K/BUILT-COMMIT exists but is not 40 lowercase hex"
else COMMIT=""; problem "$K/BUILT-COMMIT"; fi
# The Mathlib half is needed by every step except a lone pack-core.
NEED_MATHLIB=1; [ "$RUN" = " pack-core" ] && [ $DRY = 0 ] && NEED_MATHLIB=0
MATHLIB_COMMIT=""
if [ $NEED_MATHLIB = 1 ]; then
  if [ -d "$TREE" ]; then
    present "$TREE/"
    if [ -e "$TREE/Init.olean" ] || [ -d "$TREE/Init" ]; then problem "$TREE must NOT contain Init/Init.* (the contract is 'closure minus Init'; lean-core carries it and both unpack into one tree)"; fi
    if [ -d "$TREE/QED64" ]; then problem "$TREE must NOT contain QED64/ (the umbrella is generated from this tree's manifest; it cannot be in it)"; fi
    if [ -d "$TREE/Mathlib" ] && [ -d "$TREE/Lean" ] && [ -d "$TREE/Std" ]; then present "$TREE/{Mathlib,Lean,Std}/"; else problem "$TREE/{Mathlib,Lean,Std}/ (a FLAT tree: Mathlib, its Lake deps and the kernel's Std/Lean side by side)"; fi
  else problem "$TREE/"; fi
  if [ -s "$K/mathlib/essential-modules.txt" ]; then present "$K/mathlib/essential-modules.txt"; else problem "$K/mathlib/essential-modules.txt"; fi
  if hex40 "$K/mathlib/MATHLIB-COMMIT"; then MATHLIB_COMMIT=$(tr -d ' \n\r' < "$K/mathlib/MATHLIB-COMMIT"); present "$K/mathlib/MATHLIB-COMMIT ($MATHLIB_COMMIT)"
  elif [ -f "$K/mathlib/MATHLIB-COMMIT" ]; then problem "$K/mathlib/MATHLIB-COMMIT exists but is not 40 lowercase hex"
  else problem "$K/mathlib/MATHLIB-COMMIT"; fi
fi

ID=""
if [ -s "$ART/bin/lean.wasm" ]; then
  ID="wasm64-$(shasum -a 256 "$ART/bin/lean.wasm" | cut -c1-16)"
  SERVED=$(node -p 'JSON.parse(require("fs").readFileSync("public/runtime/runtime-manifest.json","utf8")).buildId' 2>/dev/null)
  echo "  buildId  $ID   (served: ${SERVED:-unknown})"
  [ -n "$SERVED" ] || fail "cannot read the served buildId from public/runtime/runtime-manifest.json"
  [ "$ID" != "$SERVED" ] || fail "K's runtime IS the served runtime ($ID) — nothing to import"
fi

# What the new packs mirror: id, mount point and roots of the served manifests.
mirror() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).content; console.log(process.argv[2]==="mount"?c.workerfs.mountPoint:c.roots.join(","))' "public/profiles/$1.manifest.json" "$2" 2>/dev/null; }
CORE_MOUNT=$(mirror lean-core mount); CORE_ROOTS=$(mirror lean-core roots)
ESS_MOUNT=$(mirror mathlib-essential mount); ESS_ROOTS=$(mirror mathlib-essential roots)
[ -n "$CORE_MOUNT" ] && [ -n "$CORE_ROOTS" ] && [ -n "$ESS_MOUNT" ] && [ -n "$ESS_ROOTS" ] || fail "cannot read mount point / roots from public/profiles/{lean-core,mathlib-essential}.manifest.json"
[ "$CORE_ROOTS" = "Init" ] || fail "the served lean-core roots are '$CORE_ROOTS', not 'Init' — this lane packs lean-core as Init + Init/** and must be taught the new shape"
echo "  mirror   lean-core: mount $CORE_MOUNT roots $CORE_ROOTS · mathlib-essential: mount $ESS_MOUNT roots $ESS_ROOTS"
if [ -d "$TREE" ]; then
  for r in $(echo "$ESS_ROOTS" | tr ',' ' '); do
    rf="$TREE/$(echo "$r" | tr '.' '/').olean"
    if [ -s "$rf" ]; then present "essential root $r"; else problem "essential root $r ($rf) — renamed or dropped at this Mathlib? the roots come from the served manifest"; fi
  done
fi

SHORT=$(echo "$COMMIT" | cut -c1-12); MSHORT=$(echo "$MATHLIB_COMMIT" | cut -c1-7)
SCRATCH=${SCRATCH:-work/import-${ID:-unknown}}
case "$SCRATCH" in /*) ;; *) SCRATCH="$Q/$SCRATCH";; esac
PACKS="$SCRATCH/packs"; LIBTREE="$SCRATCH/lib-tree"; UMB="$SCRATCH/umbrella"; LOGS="$SCRATCH/logs"
STAGING="work/staging/$ID"
CORE_RELEASE="lean-core-$LEANVER-$ID"; ESS_RELEASE="mathlib-essential-${MSHORT:-<mathlib7>}-$ID"
# The scratch dir gets a lib-tree/ and a snapshot/ of its own: it must never be
# a directory where those names are the SERVED pairing's trees.
case "$SCRATCH/" in "$Q/work/"|"$Q/"|"$Q/public/"*|"$Q/work/staging/"*|"$Q/work/snapshot/"*|"$Q/work/lib-tree"*|"$Q/pipeline/"*) fail "--scratch $SCRATCH is not a private scratch dir (its lib-tree/ and snapshot/ would be the served pairing's, or it is inside a tracked/served tree)";; esac

echo
echo "plan for $ID (Lean ${LEANVER:-?}, kernel ${SHORT:-?}, Mathlib ${MSHORT:-?}) — steps:$RUN"
echo "  scratch  $SCRATCH"
echo "  pack-core     rsync --link-dest Init + Init/** from $KLIB → $SCRATCH/core-src"
echo "                node pipeline/artifacts/pack.mjs --lib $SCRATCH/core-src --id lean-core --out $PACKS --mount $CORE_MOUNT --roots $CORE_ROOTS --lean-version ${LEANVER:-?} --revision ${SHORT:-?} --release $CORE_RELEASE --url-prefix /profiles/"
echo "  pack-mathlib  node pipeline/artifacts/pack.mjs --lib $TREE --id mathlib-essential --out $PACKS --mount $ESS_MOUNT --roots $ESS_ROOTS --lean-version ${LEANVER:-?} --revision ${SHORT:-?} --release $ESS_RELEASE --url-prefix /profiles/"
echo "  check         node pipeline/release/stage-profiles.mjs --check-only --packs $PACKS --build-id $ID --lean-version ${LEANVER:-?} --expect-modules $K/mathlib/essential-modules.txt"
if [ -d "$K/mathlib/extra-tree" ]; then echo "  pack-extra    node pipeline/artifacts/pack.mjs --lib $K/mathlib/extra-tree --id mathlib-game-extra --out $STAGING/extra   (after a disjointness check against essential-tree and Init.*)"
else echo "  pack-extra    extra: not staged by K (skipped)"; fi
echo "  unpack        rm -rf $LIBTREE; node pipeline/artifacts/unpack.mjs --manifest $PACKS/{lean-core,mathlib-essential}.manifest.json --out $LIBTREE"
echo "  umbrella      node pipeline/artifacts/gen-umbrella.mjs --manifest $PACKS/mathlib-essential.manifest.json --out $UMB/Essential.lean"
echo "                node pipeline/snapshot/supervised-run.mjs --target $UMB/Essential.olean -- --artifact $ART --work $UMB --lib $LIBTREE -- -o /work/Essential.olean /work/Essential.lean"
echo "                cp $UMB/Essential.olean* $LIBTREE/QED64/"
echo "  audit         node pipeline/artifacts/olean-imports.mjs --audit $LIBTREE"
echo "  profiles      node pipeline/release/stage-profiles.mjs --packs $PACKS --build-id $ID --lean-version ${LEANVER:-?} → $STAGING/profiles"
echo "  stage         QED64_ARTIFACT=$ART QED64_LIB_TREE=$LIBTREE QED64_SLIM=$SCRATCH/slim QED64_SNAP_WORK=$SCRATCH/snapshot QED64_LEAN_VERSION=${LEANVER:-?} pipeline/release/bump-chain.sh stage-artifact"
echo "                node pipeline/toolchain/chunk-runtime.mjs --bin $ART/bin --lean-version ${LEANVER:-?} --revision 'qed64-wasm64@${SHORT:-?} (upstream v${LEANVER:-?})'   # restamp: stage-artifact's default names the SERVED fork checkout"
echo "  next          print the operator's steps (slim-bake audit, dev test, pyramid, KERNEL-PIN, one-step promote)"
echo

if [ $PROBLEMS -gt 0 ]; then
  echo "IMPORT-FAIL the K contract is not met: $PROBLEMS problem(s) above (each line starting MISSING)"
  exit 1
fi
if [ $DRY = 1 ]; then echo "DRY RUN — contract met, nothing was run"; exit 0; fi

mkdir -p "$LOGS" "$PACKS" || fail "cannot create $SCRATCH"
# Packs (raw .pack + parts), the unpacked tree, raw .snap files and the staged copies: ~15 GB.
FREE_KB=$(df -Pk "$SCRATCH" | awk 'NR==2{print $4}')
[ "${FREE_KB:-0}" -ge 20971520 ] || [ -n "${QED64_IMPORT_IGNORE_DISK:-}" ] || fail "less than 20 GB free under $SCRATCH (${FREE_KB:-?} KB); free space, move --scratch, or set QED64_IMPORT_IGNORE_DISK=1"

pack() { # id lib mount roots release log
  rm -f "$PACKS/$1.pack" "$PACKS/$1.manifest.json" "$PACKS/$1.pack.gzip."*
  node pipeline/artifacts/pack.mjs --lib "$2" --id "$1" --out "$PACKS" --mount "$3" --roots "$4" \
    --lean-version "$LEANVER" --revision "$SHORT" --release "$5" --url-prefix /profiles/ > "$6" 2>&1
}

if want pack-core; then
  stage "pack-core"
  # lean-core is the Init closure — Init + Init/** — not the whole of lib/lean
  # (Std/Lean travel in the essential pack, Lake is not shipped). pack.mjs packs
  # everything under --lib, so the selection is a hard-linked side tree.
  CORE_SRC="$SCRATCH/core-src"; rm -rf "$CORE_SRC"; mkdir -p "$CORE_SRC"
  rsync -a --link-dest="$KLIB" --include='/Init/' --include='/Init.olean' --include='/Init.olean.server' --include='/Init.olean.private' \
    --include='/Init.ir' --include='/Init.ir.sig' --exclude='/*' "$KLIB/" "$CORE_SRC/" > "$LOGS/pack-core-select.log" 2>&1 || fail "selecting Init from $KLIB ($LOGS/pack-core-select.log)"
  HAVE=$(find "$CORE_SRC" -name '*.olean' | wc -l | tr -d ' '); WANT=$(( $(find "$KLIB/Init" -name '*.olean' | wc -l | tr -d ' ') + 1 ))
  [ "$HAVE" = "$WANT" ] || fail "core-src holds $HAVE .olean files, K's Init closure has $WANT (the rsync filter did not select what it should)"
  [ "$(find "$CORE_SRC" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 1 ] || fail "core-src has top-level directories besides Init/"
  pack lean-core "$CORE_SRC" "$CORE_MOUNT" "$CORE_ROOTS" "$CORE_RELEASE" "$LOGS/pack-core.log" || { tail -5 "$LOGS/pack-core.log"; fail "pack lean-core ($LOGS/pack-core.log)"; }
  tail -1 "$LOGS/pack-core.log" | cut -c1-220
fi

if want pack-mathlib; then
  stage "pack-mathlib"
  pack mathlib-essential "$TREE" "$ESS_MOUNT" "$ESS_ROOTS" "$ESS_RELEASE" "$LOGS/pack-mathlib.log" || { tail -5 "$LOGS/pack-mathlib.log"; fail "pack mathlib-essential ($LOGS/pack-mathlib.log)"; }
  tail -1 "$LOGS/pack-mathlib.log" | cut -c1-220
fi

if want pack-extra; then
  if [ -d "$K/mathlib/extra-tree" ]; then
    stage "pack-extra"
    # The pack is DEFINED as a set difference (closure of the game's roots minus
    # essential minus Init.*). A module present twice is mounted twice, and which
    # olean wins is only visible in the browser — so the difference is checked.
    ( cd "$K/mathlib/extra-tree" && find . -name '*.olean' | sed 's|^\./||' | sort ) > "$LOGS/extra-modules.lst"
    ( cd "$TREE" && find . -name '*.olean' | sed 's|^\./||' | sort ) > "$LOGS/essential-modules.lst"
    DUP=$(comm -12 "$LOGS/extra-modules.lst" "$LOGS/essential-modules.lst" | wc -l | tr -d ' ')
    INIT=$(grep -cE '^(Init\.olean|Init/)' "$LOGS/extra-modules.lst" || true)
    [ "$DUP" = 0 ] || { comm -12 "$LOGS/extra-modules.lst" "$LOGS/essential-modules.lst" | head -5; fail "extra-tree shares $DUP module(s) with essential-tree (first ones above)"; }
    [ "$INIT" = 0 ] || fail "extra-tree contains $INIT Init module(s)"
    [ -s "$LOGS/extra-modules.lst" ] || fail "extra-tree holds no .olean files"
    EXTRA="$STAGING/extra"; mkdir -p "$EXTRA"; rm -f "$EXTRA"/mathlib-game-extra.*
    node pipeline/artifacts/pack.mjs --lib "$K/mathlib/extra-tree" --id mathlib-game-extra --out "$EXTRA" --mount "$ESS_MOUNT" \
      --lean-version "$LEANVER" --revision "$SHORT" --release "mathlib-game-extra-$MSHORT-$ID" > "$LOGS/pack-extra.log" 2>&1 || { tail -5 "$LOGS/pack-extra.log"; fail "pack mathlib-game-extra ($LOGS/pack-extra.log)"; }
    rm -f "$EXTRA/mathlib-game-extra.pack"   # the raw pack; the manifest + gzip parts are the deliverable
    for f in extra-modules.txt extra-selection.json; do [ -f "$K/mathlib/$f" ] && cp "$K/mathlib/$f" "$EXTRA/"; done
    tail -1 "$LOGS/pack-extra.log" | cut -c1-220
    echo "  MATHLIB_EXTRA_MANIFEST=$Q/$EXTRA/mathlib-game-extra.manifest.json   ($(wc -l < "$LOGS/extra-modules.lst" | tr -d ' ') modules; part URLs are bare basenames beside it)"
  else
    echo "== pack-extra == extra: not staged by K (skipped)"
  fi
fi

if want check; then
  stage "check"
  node pipeline/release/stage-profiles.mjs --check-only --packs "$PACKS" --build-id "$ID" --lean-version "$LEANVER" \
    --expect-modules "$K/mathlib/essential-modules.txt" > "$LOGS/check.log" 2>&1 || { tail -5 "$LOGS/check.log"; fail "the two packs are not one import-closed library ($LOGS/check.log)"; }
  cat "$LOGS/check.log"
fi

if want unpack; then
  stage "unpack"
  # FRESH: a leftover module from an earlier attempt would be importable under
  # Node and absent in the browser. Packing first and baking from the unpacked
  # packs is the point — the bake sees exactly the bytes the browser mounts.
  rm -rf "$LIBTREE"
  for m in lean-core mathlib-essential; do
    [ -f "$PACKS/$m.manifest.json" ] || fail "no $PACKS/$m.manifest.json (run the pack steps)"
    node pipeline/artifacts/unpack.mjs --manifest "$PACKS/$m.manifest.json" --out "$LIBTREE" > "$LOGS/unpack-$m.log" 2>&1 || { tail -5 "$LOGS/unpack-$m.log"; fail "unpack $m ($LOGS/unpack-$m.log)"; }
    tail -1 "$LOGS/unpack-$m.log"
  done
fi

if want umbrella; then
  stage "umbrella"
  [ -d "$LIBTREE/Init" ] && [ -d "$LIBTREE/Mathlib" ] || fail "no unpacked tree at $LIBTREE (run the unpack step)"
  mkdir -p "$UMB"; rm -f "$UMB"/Essential.*
  node pipeline/artifacts/gen-umbrella.mjs --manifest "$PACKS/mathlib-essential.manifest.json" --out "$UMB/Essential.lean" > "$LOGS/umbrella-gen.log" 2>&1 || { tail -5 "$LOGS/umbrella-gen.log"; fail "gen-umbrella ($LOGS/umbrella-gen.log)"; }
  cat "$LOGS/umbrella-gen.log"
  echo "  compiling with the new runtime (tens of minutes; follow $LOGS/umbrella-compile.log)"
  # The one-shot CLI never exits (keepalive guard): supervised-run judges the
  # compile by its output and reaps the runner once Essential.olean is stable.
  node pipeline/snapshot/supervised-run.mjs --target "$UMB/Essential.olean" -- --artifact "$ART" --work "$UMB" --lib "$LIBTREE" \
    -- -o /work/Essential.olean /work/Essential.lean > "$LOGS/umbrella-compile.log" 2>&1 || { grep -E ': error|supervised-run' "$LOGS/umbrella-compile.log" | tail -8; fail "umbrella compile ($LOGS/umbrella-compile.log)"; }
  tail -1 "$LOGS/umbrella-compile.log"
  mkdir -p "$LIBTREE/QED64" && cp "$UMB"/Essential.olean* "$LIBTREE/QED64/" || fail "copying Essential.olean* into $LIBTREE/QED64"
  ls "$LIBTREE/QED64" | tr '\n' ' '; echo
fi

if want audit; then
  stage "audit"
  [ -d "$LIBTREE/Mathlib" ] || fail "no unpacked tree at $LIBTREE (run the unpack step)"
  node pipeline/artifacts/olean-imports.mjs --audit "$LIBTREE" > "$LOGS/import-all-audit.log" 2>&1 || { tail -5 "$LOGS/import-all-audit.log"; fail "import-all audit ($LOGS/import-all-audit.log)"; }
  grep -E '^import-all audit|outside Init' "$LOGS/import-all-audit.log"
fi

if want profiles; then
  stage "profiles"
  node pipeline/release/stage-profiles.mjs --packs "$PACKS" --build-id "$ID" --lean-version "$LEANVER" \
    --expect-modules "$K/mathlib/essential-modules.txt" > "$LOGS/profiles.log" 2>&1 || { tail -5 "$LOGS/profiles.log"; fail "staging the profiles ($LOGS/profiles.log)"; }
  tail -1 "$LOGS/profiles.log"
fi

if want stage; then
  stage "stage (bump-chain.sh stage-artifact: gate, chunk, slim trees, bake init, bake mathlib — hours; follow $LOGS/stage-artifact.log)"
  [ -s "$LIBTREE/QED64/Essential.olean" ] || fail "no $LIBTREE/QED64/Essential.olean (run the umbrella step) — the mathlib bake probes 'import QED64.Essential'"
  QED64_ARTIFACT="$ART" QED64_LIB_TREE="$LIBTREE" QED64_SLIM="$SCRATCH/slim" QED64_SNAP_WORK="$SCRATCH/snapshot" QED64_LEAN_VERSION="$LEANVER" \
    pipeline/release/bump-chain.sh stage-artifact > "$LOGS/stage-artifact.log" 2>&1 || { tail -12 "$LOGS/stage-artifact.log"; fail "bump-chain.sh stage-artifact ($LOGS/stage-artifact.log)"; }
  grep -E '^(BUMP-STAGED|baked)' "$LOGS/stage-artifact.log" | cut -c1-200
  # stage-artifact chunks without --revision, and the chunker's default reads the
  # SERVED fork checkout (pipeline/toolchain/work/lean4) — the wrong commit for a
  # runtime built elsewhere. Same bytes, same chunks; only the manifest's
  # sourceRevision (shown in the page's build info) is restamped.
  node pipeline/toolchain/chunk-runtime.mjs --bin "$ART/bin" --lean-version "$LEANVER" --revision "qed64-wasm64@$(echo "$COMMIT" | cut -c1-9) (upstream v$LEANVER)" > "$LOGS/chunk-restamp.log" 2>&1 || { tail -5 "$LOGS/chunk-restamp.log"; fail "restamping the staged runtime manifest ($LOGS/chunk-restamp.log)"; }
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
  ' "$STAGING" "$ID" "$LEANVER" || fail "the staged pairing under $STAGING is not complete"
fi

if want next; then
  rawsize() { if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo "?"; fi; }
  INIT_RAW=$(rawsize "$SCRATCH/snapshot/init.snap"); MATH_RAW=$(rawsize "$SCRATCH/snapshot/mathlib.snap")
  for d in runtime snapshots profiles; do [ -d "$STAGING/$d" ] || echo "NOTE: $STAGING/$d does not exist yet — the steps below assume a complete run"; done
  cat <<EOF

IMPORT-STAGED $ID — Lean $LEANVER, kernel $COMMIT, Mathlib $MATHLIB_COMMIT
  staged   $STAGING/{runtime,snapshots,profiles}
  scratch  $SCRATCH/{packs,lib-tree,umbrella,slim,snapshot,logs}
Nothing under public/, work/snapshot or work/lib-tree* was touched. Next, in order:

 1. SLIM-BAKE AUDIT — required at every Mathlib pin, not optional. Both snapshots were baked from trees
    WITHOUT *.olean.private; docs/SERVER-SLIM-REBAKE.md proved that harmless at Mathlib de3a9cf only.
      a. $LOGS/stage-artifact.log → work/bake-bump-mathlib.log: every module of the umbrella imported, zero errors.
      b. $LOGS/import-all-audit.log: the \`import all\` edges of the new tree. New edges outside Init/Std/Lean
         mean that library now reaches into private facets; a user file doing \`import all M\` fails loudly on slim.
      c. Differential, the part only a run can answer — a non-module user file natively sees private bodies, a slim
         snapshot does not, so kernel reduction (rfl / decide / simp unfolding a non-@[expose] definition) is where
         slim and fat can disagree ("unknown constant"). Bake a FAT umbrella beside the slim one and compare messages
         byte for byte on the battery's Mathlib cases and a stress file (rw chains, linarith, norm_num, decide, simp,
         field_simp, omega, #eval):
           npm run bake:snapshot -- --name mathlib --lib $LIBTREE --reserve 4294967296 --probe 'import QED64.Essential' \\
             --artifact $ART --work $SCRATCH/snapshot-fat --out $SCRATCH/fat-snapshots
           node --stack-size=8192 pipeline/snapshot/snapshot-probe.mjs --artifact $ART --lib $SCRATCH/slim/lib-tree-slim --snap $SCRATCH/snapshot/mathlib.snap --probe-file <stress.lean>
           node --stack-size=8192 pipeline/snapshot/snapshot-probe.mjs --artifact $ART --lib $LIBTREE --snap $SCRATCH/snapshot-fat/mathlib.snap --probe-file <stress.lean>
         Identical → ship slim and record the audit (pin, date, counts) in docs/SERVER-SLIM-REBAKE.md. Different → ship
         the fat bake instead (copy it over $STAGING/snapshots, 2.5x the download, and resize the page's pre-commit).
 2. Dev test of the staged pairing (additive; the served default does not move):
      cp -n $STAGING/runtime/chunks/* public/runtime/chunks/
      cp $STAGING/runtime/runtime-manifest.$ID.json public/runtime/
      ln -sfn ../$STAGING/snapshots public/snapshots-0031
      ln -sfn ../$STAGING/profiles  public/profiles-staged
      restart the dev server, then open \$(tests/adversarial/resident-url.sh)
    resident-url.sh adds &profiles=profiles-staged when that symlink belongs to the same build: the page then
    installs the STAGED packs (index, manifests and parts re-rooted by basename), never the served ones —
    the olean githash gate is compiled off, so foreign oleans would be misread, not refused. preflight refuses a
    profile index that names another runtime. Remove public/profiles-staged after promotion.
 3. Pyramid, one gate at a time: tests/adversarial/resident-gate.sh, then the two crash gauntlets. Expect to
    re-gold battery messages upstream reworded, and the unit tests that pin the served manifests
    (tests/unit/profiles.test.ts: 629 modules / 3145 files) once the new manifests are promoted.
 4. pipeline/toolchain/KERNEL-PIN: commit $COMMIT, runtime $ID, init.snap $INIT_RAW bytes raw, mathlib.snap $MATH_RAW bytes raw.
 5. Promote in ONE step — runtime + snapshots + packs + manifests + profile index together:
      node pipeline/release/promote-staging.mjs --staging $STAGING --dry-run     # read the plan first
      node pipeline/release/promote-staging.mjs --staging $STAGING && npm run verify:release
    (promote-staging.mjs must be the version that also promotes $STAGING/profiles; if its plan lists no /profiles/
    files, stop — a runtime promoted without its packs serves 4.33 oleans to a $LEANVER runtime.)
    Only then: cp $SCRATCH/snapshot/{init,mathlib}.snap work/snapshot/ (the battery's paired raw set), point
    work/lib-tree at the new tree, update docs/PROVENANCE.md (toolchain identity, Mathlib $MSHORT, pack digests),
    commit public/ manifests + KERNEL-PIN. The user uploads the artifacts and pushes.
EOF
fi
