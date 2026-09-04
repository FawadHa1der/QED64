#!/bin/bash
# Post-rebuild resident gate: restart the dev server (vite indexes public/ at
# startup — the chunked runtime + staging snapshots are new files), PREFLIGHT
# both pairings (manifest, chunks, snapshot index, runtime↔snapshot pairing,
# one boot smoke — refuses with exit 3 before any lane runs, HARDENING #32/#33),
# then run the resident-mode e2e suite, the pump-vs-resident editing-latency
# benchmark, and the compiler battery on the new pairing, with a browser
# cool-down between lanes (HARDENING #34). Usage: tests/adversarial/resident-gate.sh
set -u
Q=$(cd "$(dirname "$0")/../.." && pwd); cd "$Q"
npm run typecheck:site || { echo "GATE-REFUSED: typecheck:site failed"; exit 3; }
for P in $(lsof -ti :5184 2>/dev/null); do kill $P 2>/dev/null; done; sleep 2
(cd frontend && PORT=5184 nohup npx vite > /tmp/vite5184.log 2>&1 &); sleep 7
curl -s -o /dev/null -w "vite5184=%{http_code}\n" http://localhost:5184/
URL=$(tests/adversarial/resident-url.sh 5184)
PUMP="http://localhost:5184/?resident=0"
echo "resident url: $URL"
RUN=$(node tests/adversarial/harness.mjs run-dir --url "$URL")
echo "run dir: $RUN"
echo "=== preflight: resident ==="; node tests/adversarial/preflight.mjs --url "$URL" --run-dir "$RUN" || { echo "GATE-REFUSED: resident preflight (exit $?)"; exit 3; }
echo "=== preflight: pump ==="; node tests/adversarial/preflight.mjs --url "$PUMP" --no-boot || { echo "GATE-REFUSED: pump preflight (exit $?)"; exit 3; }
# --kill-strays: the preflight's own boot-smoke browser is the usual "stray" (a
# refusal here skipped every resident lane on 2026-09-03); the memory floor is
# an argument so a busy machine can still run with a lower bar.
cool() { node tests/adversarial/harness.mjs cooldown --kill-strays --cooldown-gb "${QED64_COOLDOWN_GB:-6}" || { echo "GATE-REFUSED: cool-down (stray browsers / memory)"; exit 3; }; }
cool
echo "=== resident e2e ==="; node tests/adversarial/e2e.mjs --url "$URL" --run-dir "$RUN" > work/adversarial/e2e-resident.log 2>&1; echo "e2e-exit=$?"
cp work/adversarial/e2e-report.json work/adversarial/e2e-resident-report.json
python3 -c "
import json; r=json.load(open('work/adversarial/e2e-resident-report.json'))
print(f\"resident e2e: {r['total']-r['failed']}/{r['total']} (infra {r.get('infra',0)}, aborted {r.get('aborted',0)})\")
[print('  ', x.get('outcome','fail').upper(), x['name'], '::', str(x.get('detail',''))[:140]) for x in r['results'] if x.get('outcome','fail')!='pass']"
cool
echo "=== editing latency: pump ==="; node tests/adversarial/editing-latency.mjs --url "$PUMP" --label pump --rounds 3 --run-dir "$RUN" 2>&1 | grep -E "SUMMARY|round|alive"
cool
echo "=== editing latency: resident ==="; node tests/adversarial/editing-latency.mjs --url "$URL" --label resident --rounds 3 --run-dir "$RUN" 2>&1 | grep -E "SUMMARY|round|alive"
echo "=== compiler battery (0031 pairing) ==="; node tests/adversarial/compiler-battery.mjs --run-dir "$RUN" > work/adversarial/battery-0031h.log 2>&1; echo "battery-exit=$?"
python3 -c "
import json; r=json.load(open('work/adversarial/compiler-report.json')); print(f\"battery: {r['total']-r['failed']}/{r['total']} (infra {r.get('infra',0)})\")"
echo "run dir: $RUN"
echo GATE-DONE
