#!/usr/bin/env bash
# The four HARDENING #51 probes through the REAL resident FileWorker (the
# prebuilt-environment branch), against a served page: each file is typed into
# the editor and the InfoView must show the expected text with no error marker.
#   tests/adversarial/kernel-probes/browser-check.sh <url>
set -u
Q=$(cd "$(dirname "$0")/../../.." && pwd); cd "$Q"; URL=${1:?url}; D=tests/adversarial/kernel-probes; fails=0
check() { # file cursorLine wantRegex label
  out=$(timeout 240 node tests/adversarial/buffer-probe.cjs "$URL" "$D/$1" "$2" "$3" 2>&1)
  rendered=$(echo "$out" | grep -c "^RENDERED"); errs=$(echo "$out" | grep -c "^diag: .* sev8 ")
  if [ "$rendered" = 1 ] && [ "$errs" = 0 ]; then echo " ok   $4"; else echo "FAIL  $4"; echo "$out" | grep -E "^(RENDERED|NOT RENDERED|diag:|infoview:)" | head -6 | cut -c1-200 | sed 's/^/      /'; fails=$((fails+1)); fi
}
check is-module.lean 3 'isModule=false' "legacy file: isModule=false (resident FileWorker)"
check private-default.lean 8 '\(`plainDef, false\)' "legacy file: a plain def is public (resident FileWorker)"
check rpc-attr.lean 22 'All Messages' "legacy file: attributed rpc/tactic/unexpander defs compile with no error (resident FileWorker)"
check module-file.lean 4 'isModule=true' "module file: isModule=true (resident FileWorker)"
[ $fails = 0 ] && echo "BROWSER-PROBES PASSED" || { echo "BROWSER-PROBES FAILED ($fails)"; exit 1; }
