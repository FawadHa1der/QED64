import Lean
-- Regenerates the `wire` vectors of tests/fixtures/stack-limit-messages.json (HARDENING #92): upstream Lean v4.35.0
-- encodes the fork's guard messages exactly as the FileWorker does for getInteractiveDiagnostics (widgets on) and for
-- publishDiagnostics. Run: ~/.elan/toolchains/leanprover--lean4---v4.35.0/bin/lean tests/fixtures/stack-limit-wire.lean
-- (it exits 1: the guard words also reach its own log).
open Lean Elab Command Widget Server Meta

-- The fork's two guard texts, verbatim (kernel src/Lean/CoreM.lean:527, src/runtime/interrupt.cpp:100-101).
def P1 : String := "maximum recursion depth has been reached: the WebAssembly runtime's stack is exhausted (a browser gives it far less stack than native Lean has; raising maxRecDepth does not help, and the same code may succeed natively)"
def K  : String := "the WebAssembly engine's stack is exhausted: this proof recurses deeper than a browser allows (the same proof may check natively)"
def guardMd : MessageData := .tagged `runtime.maxRecDepth <| MessageData.ofFormat <| Std.Format.text P1

/-- Log `mk`'s message through the real path (logException + addMessageContext), then encode it as the FileWorker does
for an RPC reply with widgets (getInteractiveDiagnostics) and for publishDiagnostics (toDiagnostic). -/
def viaLog (name : String) (mk : TermElabM Exception) : CommandElabM Unit := do
  let fm ← getFileMap
  let s ← liftTermElabM do
    let before := (← Core.getMessageLog).toList.length
    let ex ← mk
    tryCatchRuntimeEx (throw ex) (fun ex => logException ex)
    let m := ((← Core.getMessageLog).toList.drop before).head!
    let d ← msgToInteractiveDiagnostic fm m true
    let (j, _) := (rpcEncode d.message).run {}
    return s!"\{\"name\":{(toJson name).compress},\"rpc\":{j.compress},\"pub\":{(toJson d.toDiagnostic.message).compress}}"
  IO.println s

#eval show CommandElabM Unit from do
  viaLog "E" (do return Exception.error (← getRef) guardMd)
  viaLog "E-synth" (do return Exception.error (← getRef) m!"failed to synthesize{indentExpr (mkConst ``True)}\n{guardMd}{useDiagnosticMsg}")
  viaLog "K" (do return Exception.error (← getRef) ((Kernel.Exception.other K).toMessageData {}))
  viaLog "E-simp" (do
    let e := Exception.error (← getRef) guardMd
    tryCatchRuntimeEx (Meta.throwNestedTacticEx `simp e) (fun ex => return ex))
  -- `decide`'s report of a kernel failure, with the kernel's guard words inside (Elab/Tactic/Decide.lean:141-143).
  viaLog "decide-kernel" (do
    let ex := (Kernel.Exception.other K).toMessageData {}
    return Exception.error (← getRef) m!"\
      Tactic `{`decide}` failed. The elaborator is able to reduce the \
      `{MessageData.ofConstName ``Decidable}` instance, but the kernel fails with:\n\
      {indentD ex}")
  viaLog "N1" (do tryCatchRuntimeEx (throwMaxRecDepthAt (← getRef)) (fun ex => return ex))
  viaLog "N2-simp" (do
    let e ← tryCatchRuntimeEx (throwMaxRecDepthAt (← getRef)) (fun ex => pure ex)
    tryCatchRuntimeEx (Meta.throwNestedTacticEx `simp e) (fun ex => return ex))
  viaLog "N4" (do return Exception.error (← getRef) ((Kernel.Exception.deepRecursion).toMessageData {}))
