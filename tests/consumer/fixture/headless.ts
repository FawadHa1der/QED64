// docs/EMBEDDING.md §6.1 (a): QED64 without an editor. Boot the resident session behind the relay and
// be the language client yourself on relay.clientPort. Type-checked and built by `npm run test:consumer`
// against the packed tarball; never run there (it needs a browser, COOP/COEP and the served artifacts).
import {
  LspRelay, MEMORY64_PROBE, ResidentSession, installArtifacts, makeEditorPolicy,
  type FailureCause, type JsonRpcMessage, type RelayStatus, type StatusSink,
} from "qed64/embed";

export async function checkHeadless(text: string, onDiagnostics: (diagnostics: unknown[]) => void): Promise<{ relay: LspRelay; edit(next: string): void }> {
  if (!crossOriginIsolated) throw new Error("serve the page with COOP same-origin and COEP require-corp");
  if (!WebAssembly.validate(MEMORY64_PROBE)) throw new Error("this browser has no WebAssembly Memory64");

  // Boot progress as data (§7.1): stage, subject, loaded/total; `error` is a FailureCause (§7.2).
  const ui: StatusSink = {
    busy: (label, info) => console.log("[qed64] busy", label, info?.stage ?? ""),
    progress: (label, info) => console.log("[qed64]", label, info?.loaded ?? "", info?.total ?? ""),
    idle: (label) => console.log("[qed64] idle", label),
  };
  // The runtime manifest, the snapshot index and the core library pack, from /runtime, /snapshots, /profiles.
  const artifacts = await installArtifacts(ui, { overrides: "none" });
  const policy = makeEditorPolicy(artifacts.snapshots); // which snapshots a header needs, and the memory to commit
  let current = text; // the document a (re)boot serves: keep it current as you send didChanges

  const relay = new LspRelay(
    (opts) => new ResidentSession({ artifacts, ui, policy, headerText: current }, opts ?? {}),
    {
      status: (s: RelayStatus) => {
        const cause: FailureCause | undefined = s.lastDeath?.cause;
        console.log("[qed64] relay", s.relay, s.phase, cause ? `${cause.kind}: ${cause.message}` : "");
      },
    },
    () => new Promise((resolve) => setTimeout(resolve, 1500)), // the heap-release settle inside a reboot
  );
  addEventListener("pagehide", () => relay.unload(), { once: true });

  // You are the language client: JSON-RPC in and out of relay.clientPort (§7.9).
  const port = relay.clientPort;
  port.onmessage = (e: MessageEvent<JsonRpcMessage>) => {
    const m = e.data as { method?: string; params?: { diagnostics?: unknown[] } };
    if (m.method === "textDocument/publishDiagnostics") onDiagnostics(m.params?.diagnostics ?? []);
  };
  const uri = "file:///project/Probe.lean";
  port.postMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
  port.postMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
  port.postMessage({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "lean4", version: 1, text } } });

  // An edit is a full-text didChange; the session coalesces bursts (§7.8).
  let version = 1;
  const edit = (next: string) => {
    current = next;
    port.postMessage({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: ++version }, contentChanges: [{ text: next }] } });
  };
  return { relay, edit };
}
