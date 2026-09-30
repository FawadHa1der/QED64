import Lean
open Lean Server

structure AskParams where
  n : Nat
  deriving FromJson, ToJson

-- Stock Lean accepts this in a file without `module`; under module semantics
-- it needs `public meta def` AND a `public structure` (HARDENING #51).
@[server_rpc_method]
def askServer (p : AskParams) : RequestM (RequestTask String) := do
  let doc ← RequestM.readDoc
  let lines := (doc.meta.text.source.splitOn "\n").length
  return .pure s!"{p.n * 2} (doc has {lines} lines)"

-- also: a hand-attributed elaborator and an unexpander on plain defs
open Elab Tactic in
def evalMine : Tactic := fun _ => do evalTactic (← `(tactic| trivial))
syntax "mine" : tactic
attribute [tactic «tacticMine»] evalMine
example : True := by mine

@[app_unexpander List.nil] def unexpandNil : PrettyPrinter.Unexpander
  | `($_) => `([])
