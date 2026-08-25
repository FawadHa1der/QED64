// QED64 × lean4monaco: the live.lean-lang.org editing experience (Monaco +
// the real vscode-lean4 InfoView) with zero servers — the Lean file worker
// runs in this browser tab on the wasm64 runtime.
import { LeanMonaco, LeanMonacoEditor, type LeanMonacoOptions } from "lean4monaco";
import { bootQed64 } from "./qed64-boot";
import { WatchdogShim } from "./watchdog-shim";

const statusEl = document.getElementById("status")!;
const editorEl = document.getElementById("editor")! as HTMLElement;
const infoviewEl = document.getElementById("infoview")! as HTMLElement;
const status = (line: string) => {
  statusEl.textContent = line;
  console.log(`[qed64] ${line}`);
};

const EXAMPLE = `theorem probe (n : Nat) : n + 0 = n := by
  simp

example (a b : Nat) (h : a = b) : a + 1 = b + 1 := by
  rw [h]

example : False := sorry
`;

async function main() {
  const { session } = await bootQed64(status);
  const shim = new WatchdogShim(session, status);

  status("starting Monaco + InfoView…");
  const leanMonaco = new LeanMonaco();
  const editor = new LeanMonacoEditor();
  leanMonaco.setInfoviewElement(infoviewEl);

  const options: LeanMonacoOptions = {
    // The undocumented-but-load-bearing seam: `websocket` spreads LAST into
    // monaco-editor-wrapper's connection config, so a WorkerDirect override
    // routes the LSP client at our MessagePort instead of a WebSocket.
    websocket: {
      $type: "WorkerDirect",
      worker: { postMessage() {} },
      messagePort: shim.clientPort,
    } as unknown as { url: string },
    vscode: {
      "workbench.colorTheme": "Visual Studio Light",
      "lean4.input.leader": "\\",
    },
  };
  await leanMonaco.start(options);
  await editor.start(editorEl, "/project/Probe.lean", EXAMPLE);
  status("ready — put the cursor inside a proof to see goals");
}

void main().catch((err) => {
  status(`FAILED: ${err?.message ?? err}`);
  console.error(err);
});
