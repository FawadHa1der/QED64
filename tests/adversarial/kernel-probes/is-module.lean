import Lean
open Lean Elab Command in
#eval show CommandElabM Unit from do
  logInfo m!"isModule={(← getEnv).header.isModule} main={(← getEnv).mainModule}"
