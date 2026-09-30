import Lean
open Lean Elab Command

def plainDef := 1
theorem plainThm : plainDef = 1 := rfl
public def pubDef := 2

#eval show CommandElabM Unit from do
  let env ← getEnv
  let names := env.constants.map₂.toList.map (·.1) |>.filter fun n =>
    (`plainDef).isSuffixOf n || (`plainThm).isSuffixOf n || (`pubDef).isSuffixOf n
  logInfo m!"isModule={env.header.isModule} | {names.map fun n => (repr n, isPrivateName n)}"
