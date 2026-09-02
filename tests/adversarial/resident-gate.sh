#!/bin/bash
# Post-rebuild resident gate: restart the dev server (vite indexes public/ at
# startup — the chunked runtime + staging snapshots are new files), then run
# the resident-mode e2e suite, the pump-vs-resident editing-latency benchmark,
# and the compiler battery on the new pairing. Usage: tests/adversarial/resident-gate.sh
set -u
Q=$(cd "$(dirname "$0")/../.." && pwd); cd "$Q"
for P in $(lsof -ti :5184 2>/dev/null); do kill $P 2>/dev/null; done; sleep 2
(cd frontend && PORT=5184 nohup npx vite > /tmp/vite5184.log 2>&1 &); sleep 7
curl -s -o /dev/null -w "vite5184=%{http_code}\n" http://localhost:5184/
URL=$(tests/adversarial/resident-url.sh 5184)
echo "resident url: $URL"
echo "=== resident e2e ==="; node tests/adversarial/e2e.mjs --url "$URL" > work/adversarial/e2e-resident.log 2>&1; echo "e2e-exit=$?"
cp work/adversarial/e2e-report.json work/adversarial/e2e-resident-report.json
python3 -c "
import json; r=json.load(open('work/adversarial/e2e-resident-report.json'))
print(f\"resident e2e: {r['total']-r['failed']}/{r['total']}\")
[print('  FAIL', x['name'], '::', str(x.get('detail',''))[:140]) for x in r['results'] if not x.get('pass')]"
echo "=== editing latency: pump ==="; node tests/adversarial/editing-latency.mjs --url "http://localhost:5184/" --label pump --rounds 3 2>&1 | grep -E "SUMMARY|round|alive"
echo "=== editing latency: resident ==="; node tests/adversarial/editing-latency.mjs --url "$URL" --label resident --rounds 3 2>&1 | grep -E "SUMMARY|round|alive"
echo "=== compiler battery (0031 pairing) ==="; node tests/adversarial/run.mjs --skip-e2e > work/adversarial/battery-0031h.log 2>&1; echo "battery-exit=$?"
python3 -c "
import json; r=json.load(open('work/adversarial/compiler-report.json')); print(f\"battery: {r['total']-r['failed']}/{r['total']}\")"
echo GATE-DONE
