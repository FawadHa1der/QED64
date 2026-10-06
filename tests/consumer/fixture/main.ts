// A page that uses qed64/embed without the editor: refuse an incapable browser, then name what it would boot.
import { EMBED_API_REVISION, LeanSession, MEMORY64_PROBE, WORKER_URLS, probeMemory64 } from "qed64/embed";

const out = document.getElementById("out")!;
const capable = probeMemory64() && WebAssembly.validate(MEMORY64_PROBE);
out.textContent = `qed64/embed ${EMBED_API_REVISION}: memory64=${capable}, workers=${WORKER_URLS.join(",")}, session=${typeof LeanSession}`;
