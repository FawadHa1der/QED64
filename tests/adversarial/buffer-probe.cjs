// Type files into the served editor and report, per file, whether a regex appears in the
// InfoView plus the language client's diagnostics (monaco markers). ONE boot serves every
// file (a cold boot of the live site downloads ~450 MB), so the probes are passed as triples:
//   node tests/adversarial/buffer-probe.cjs <url> <file.lean> <cursorLine> <regex> [<file> <line> <regex> ...]
// Env: QED64_BOOT_WAIT_S (default 90; use 900 for a cold remote origin), QED64_PROBE_WAIT_S (per file, default 60).
const { chromium } = require("playwright");
const fs = require("fs");
const url = process.argv[2];
const triples = [];
for (let i = 3; i + 2 < process.argv.length; i += 3) triples.push({ file: process.argv[i], line: Number(process.argv[i + 1]), want: new RegExp(process.argv[i + 2]) });
if (!url || triples.length === 0) { console.error("usage: buffer-probe.cjs <url> <file> <cursorLine> <regex> [...]"); process.exit(2); }
const bootWaitS = Number(process.env.QED64_BOOT_WAIT_S || 90), probeWaitS = Number(process.env.QED64_PROBE_WAIT_S || 60);
(async () => {
  const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
  const page = await browser.newPage();
  const iv = () => page.evaluate(() => { const f = document.getElementById("infoview")?.querySelector("iframe"); return f && f.contentDocument ? f.contentDocument.body.innerText : ""; }).catch(() => "");
  const phase = () => page.evaluate(() => { try { const s = globalThis.qed64.status(); return `${s.phase}/${s.header ? s.header.mode : "-"}`; } catch { return "?"; } }).catch(() => "dead");
  const pill = () => page.evaluate(() => (document.getElementById("ptext") || {}).textContent || "").catch(() => "");
  let exit = 0;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    const t0 = Date.now();
    for (;;) { const p = await phase(); if (/^(ready|headerRefused)/.test(p)) break; if (Date.now() - t0 > bootWaitS * 1000) { console.log(`BOOT TIMEOUT after ${bootWaitS}s: status ${p}, pill '${(await pill()).slice(0, 60)}'`); process.exitCode = 3; await browser.close(); return; } await page.waitForTimeout(1000); }
    console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${await phase()} — ${triples.length} probe(s)`);
    for (const t of triples) {
      await page.evaluate((s) => globalThis.qed64.editor.getModel().setValue(s), fs.readFileSync(t.file, "utf8"));
      await page.evaluate((l) => { globalThis.qed64.editor.setPosition({ lineNumber: l, column: 3 }); globalThis.qed64.editor.focus(); }, t.line);
      let ok = false, text = "";
      for (let i = 0; i < probeWaitS; i++) { await page.waitForTimeout(1000); text = await iv(); if (t.want.test(text)) { ok = true; break; } }
      const diags = await page.evaluate(async () => {
        const m = globalThis.qed64.editor.getModel();
        const monaco = await import("/node_modules/.vite/deps/monaco-editor.js").catch(() => null);
        const markers = monaco && monaco.editor ? monaco.editor.getModelMarkers({ resource: m.uri }) : [];
        return markers.map((k) => `${k.startLineNumber}:${k.startColumn} sev${k.severity} ${String(k.message).slice(0, 240)}`);
      }).catch(() => []);
      console.log(`[${t.file}] ${ok ? "RENDERED" : "NOT RENDERED"} | status ${await phase()}`);
      console.log(`   infoview: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
      for (const d of diags.slice(0, 8)) console.log(`   diag: ${d.replace(/\s+/g, " ")}`);
      if (!ok) exit = 1;
    }
  } catch (e) { console.log("threw", e.message.split("\n")[0]); exit = 1; }
  finally { await browser.close().catch(() => {}); }
  process.exitCode = exit;
})();
