// Type a file into the served editor, put the cursor on a line, and report whether a regex
// appears in the InfoView, plus the language client's diagnostics (monaco markers).
// Usage: node tests/adversarial/buffer-probe.cjs <url> <file.lean> <cursorLine> <regex>
const { chromium } = require("playwright");
const fs = require("fs");
const url = process.argv[2], file = process.argv[3], cursorLine = Number(process.argv[4]), want = new RegExp(process.argv[5]);
(async () => {
  const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
  const page = await browser.newPage();
  const iv = () => page.evaluate(() => { const f = document.getElementById("infoview")?.querySelector("iframe"); return f && f.contentDocument ? f.contentDocument.body.innerText : ""; }).catch(() => "");
  const phase = () => page.evaluate(() => { try { const s = globalThis.qed64.status(); return `${s.phase}/${s.header ? s.header.mode : "-"}`; } catch { return "?"; } }).catch(() => "dead");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    for (let i = 0; i < 90 && !/^(ready|headerRefused)/.test(await phase()); i++) await page.waitForTimeout(1000);
    await page.evaluate((t) => globalThis.qed64.editor.getModel().setValue(t), fs.readFileSync(file, "utf8"));
    await page.evaluate((l) => { globalThis.qed64.editor.setPosition({ lineNumber: l, column: 3 }); globalThis.qed64.editor.focus(); }, cursorLine);
    let ok = false, text = "";
    for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); text = await iv(); if (want.test(text)) { ok = true; break; } }
    console.log(ok ? "RENDERED" : "NOT RENDERED", "| status", await phase());
    console.log("infoview:", text.replace(/\s+/g, " ").slice(0, 700));
    // diagnostics the language client holds for the document
    const diags = await page.evaluate(async () => {
      const m = globalThis.qed64.editor.getModel();
      const monaco = await import("/node_modules/.vite/deps/monaco-editor.js").catch(() => null);
      const markers = monaco && monaco.editor ? monaco.editor.getModelMarkers({ resource: m.uri }) : [];
      return markers.map((k) => `${k.startLineNumber}:${k.startColumn} sev${k.severity} ${String(k.message).slice(0, 240)}`);
    }).catch((e) => ["markers unavailable: " + e.message.split("\n")[0]]);
    for (const d of diags.slice(0, 8)) console.log("diag:", d.replace(/\s+/g, " "));
    // open "All Messages" by moving the cursor to the end (messages list shows below)
    await page.evaluate(() => { const m = globalThis.qed64.editor.getModel(); globalThis.qed64.editor.setPosition({ lineNumber: m.getLineCount(), column: 1 }); });
    await page.waitForTimeout(2500);
    console.log("infoview@end:", (await iv()).replace(/\s+/g, " ").slice(0, 900));
  } catch (e) { console.log("threw", e.message.split("\n")[0]); }
  finally { await browser.close().catch(() => {}); }
})();
