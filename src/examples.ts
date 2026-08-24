// Bundled example programs. The `profile` field is the minimum profile whose
// module set can satisfy the example's imports.

export interface Example {
  id: string;
  title: string;
  profile: "core" | "essential";
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: "welcome",
    title: "Welcome — a first proof",
    profile: "core",
    source: `-- Welcome to QED64: the real Lean 4 compiler, running in your browser
-- on WebAssembly Memory64. Edit the proof; it rechecks as you type.

theorem add_comm' (a b : Nat) : a + b = b + a := by
  induction b with
  | zero => simp
  | succ d ih => rw [Nat.add_succ, Nat.succ_add, ih]

#check add_comm'
#eval 2 ^ 10 + 24
`,
  },
  {
    id: "platform",
    title: "Prove you're on 64-bit",
    profile: "core",
    source: `-- This page runs a genuine LP64 build of Lean: pointers are 64-bit and
-- the heap can grow past wasm32's 4 GiB limit.

#eval System.Platform.numBits   -- 64

example : System.Platform.numBits = 64 := by native_decide
`,
  },
  {
    id: "induction",
    title: "Induction & structures",
    profile: "core",
    source: `inductive Tree (α : Type) where
  | leaf : Tree α
  | node : Tree α → α → Tree α → Tree α

def Tree.size : Tree α → Nat
  | .leaf => 0
  | .node l _ r => l.size + r.size + 1

def Tree.mirror : Tree α → Tree α
  | .leaf => .leaf
  | .node l x r => .node r.mirror x l.mirror

theorem Tree.mirror_size (t : Tree α) : t.mirror.size = t.size := by
  induction t with
  | leaf => rfl
  | node l x r ihl ihr => simp [mirror, size, ihl, ihr]; omega
`,
  },
  {
    id: "mathlib-groups",
    title: "Mathlib — group theory",
    profile: "essential",
    source: `import Mathlib.Algebra.Group.Basic

-- The first Mathlib compile imports its closure once (a minute or two);
-- after that, recompiles are instant against the resident environment.

example (G : Type*) [Group G] (a b : G) :
    (a * b)⁻¹ = b⁻¹ * a⁻¹ := by
  simp

example (G : Type*) [Group G] (a : G) : a * a⁻¹ = 1 := by
  simp
`,
  },
  {
    id: "mathlib-reals",
    title: "Mathlib — real numbers",
    profile: "essential",
    source: `import Mathlib.Data.Real.Basic
import Mathlib.Tactic.Linarith

example (x y : ℝ) : x * y = y * x := mul_comm x y

example (a b : ℝ) (h : a ≤ b) : a + 1 ≤ b + 1 := by
  linarith
`,
  },
  {
    id: "sandbox",
    title: "Blank sandbox",
    profile: "core",
    source: `-- Your scratchpad. \\alpha → α, \\to → →, \\< → ⟨ (Tab commits).

`,
  },
];
