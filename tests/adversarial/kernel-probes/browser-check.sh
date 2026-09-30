#!/usr/bin/env bash
# The four HARDENING #51 probes through the REAL resident FileWorker (the
# prebuilt-environment branch), against a served page — ONE boot for all four,
# so it also gates the live site after a deploy (cold download ~450 MB):
#   tests/adversarial/kernel-probes/browser-check.sh <url>
#   QED64_BOOT_WAIT_S=900 tests/adversarial/kernel-probes/browser-check.sh https://qed64.<account>.workers.dev/
set -u
Q=$(cd "$(dirname "$0")/../../.." && pwd); cd "$Q"; URL=${1:?url}; D=tests/adversarial/kernel-probes
out=$(timeout $(( ${QED64_BOOT_WAIT_S:-90} + 4 * ${QED64_PROBE_WAIT_S:-60} + 120 )) node tests/adversarial/buffer-probe.cjs "$URL" \
  "$D/is-module.lean" 3 'isModule=false' \
  "$D/private-default.lean" 8 '\(`plainDef, false\)' \
  "$D/rpc-attr.lean" 22 'All Messages' \
  "$D/module-file.lean" 4 'isModule=true' 2>&1)
echo "$out" | grep -E "^booted|^BOOT TIMEOUT|^threw" | cut -c1-160
fails=0
verdict() { # file label
  block=$(echo "$out" | awk -v f="[$1]" 'index($0,f)==1{p=1;print;next} /^\[/{p=0} p{print}')
  if echo "$block" | grep -q "RENDERED" && ! echo "$block" | grep -q "NOT RENDERED" && ! echo "$block" | grep -q "diag: .* sev8 "; then echo " ok   $2"
  else echo "FAIL  $2"; echo "$block" | head -6 | cut -c1-200 | sed 's/^/      /'; fails=$((fails+1)); fi
}
verdict "$D/is-module.lean" "legacy file: isModule=false (resident FileWorker)"
verdict "$D/private-default.lean" "legacy file: a plain def is public (resident FileWorker)"
verdict "$D/rpc-attr.lean" "legacy file: attributed rpc/tactic/unexpander defs compile with no error (resident FileWorker)"
verdict "$D/module-file.lean" "module file: isModule=true (resident FileWorker)"
[ $fails = 0 ] && echo "BROWSER-PROBES PASSED" || { echo "BROWSER-PROBES FAILED ($fails)"; exit 1; }
