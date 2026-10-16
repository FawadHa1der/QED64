// The vendored LZ-string port (frontend/src/lz-string.ts): round trips through
// both alphabets, the decoding cap, and the bytes lean4web's writer produces
// for one Lean text (`compressToBase64(text).replace(/=*$/, "")`), pinned as a
// literal so a `#codez=` link made by the npm package elsewhere decodes here
// (docs/EMBEDDING.md §3.1). The Zulip bot's repository vendors its own port and
// pins the same VECTOR, so the two cannot drift apart unnoticed. The literal
// was produced by this port and compared, byte for byte, with lz-string 1.5.0
// from the npm registry on 2026-10-16 (1,512 texts over both alphabets agreed).
import { describe, expect, it } from "vitest";
import { compressToBase64, compressToEncodedURIComponent, decompressFromBase64, decompressFromEncodedURIComponent } from "../../frontend/src/lz-string";

/** lean4web's `#codez=` value for `text` (tests/unit/page-api.test.ts and the bot repository pin the same pair). */
export const VECTOR = {
  text: "import Mathlib\n\nexample (x : ℝ) (h : 0 < x) : 0 < x ^ 2 + x := by positivity\n-- ∀ α, α = α\n",
  codez: "JYWwDg9gTgLgBAWQIYwBYBtgCMBQOCmAHkuOvnABSFwBccguIQCUlqtcADHADxyHN2ce1AHpwATHADUvWgF44WAJ5xIAZ2AxgANw2KcAWn1xAAERxAjcAAac3HlmcQA",
};

const LEAN_DENSE = "theorem foo (α : Type) (a b : α) (h : a = b) : b = a := by\n  rw [h]\n"
  + "-- ∀ ε > 0, ∃ δ > 0, ∀ x, |x - x₀| < δ → |f x - f x₀| < ε\n"
  + "example : (1 : ℝ) + 1 = 2 := by norm_num\n"
  + "∑ i in Finset.range n, i = n * (n - 1) / 2 ⟨⟩ ↦ ⦃⦄ ⊢ 𝔸 😀 \u0000 ￿\n";

const roundTrip = (text: string) => {
  const b64 = compressToBase64(text);
  expect(b64.length % 4).toBe(0);
  expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,3}$/);
  expect(decompressFromBase64(b64)).toBe(text);
  expect(decompressFromBase64(b64.replace(/=*$/, ""))).toBe(text); // lean4web's writer strips the padding
  const uri = compressToEncodedURIComponent(text);
  expect(uri).toMatch(/^[A-Za-z0-9+\-$]*$/);
  expect(decompressFromEncodedURIComponent(uri)).toBe(text);
  return { b64, uri };
};

describe("lz-string: round trips", () => {
  it("ASCII", () => {
    roundTrip("example : (2 : Nat) + 2 = 4 := rfl\n");
    roundTrip("a");
    roundTrip("a".repeat(4096));
    roundTrip("The quick brown fox jumps over the lazy dog. 0123456789 !@#$%^&*()_+-=[]{};':\",./<>?\\|`~\n\t");
  });
  it("Unicode-dense Lean (BMP and astral characters, NUL, U+FFFF)", () => {
    roundTrip(LEAN_DENSE);
    roundTrip("ℝ".repeat(3000));
  });
  it("the empty string compresses to 'Q===' and decodes back to ''; '' itself does not decode", () => {
    expect(compressToBase64("")).toBe("Q===");
    expect(decompressFromBase64("Q===")).toBe("");
    expect(decompressFromBase64("Q")).toBe("");
    expect(compressToEncodedURIComponent("")).toBe("Q");
    expect(decompressFromEncodedURIComponent("Q")).toBe("");
    expect(decompressFromBase64("")).toBeNull();
    expect(decompressFromEncodedURIComponent("")).toBeNull();
  });
  it("100 KB of Lean-like text, both alphabets", () => {
    const text = LEAN_DENSE.repeat(Math.ceil(100_000 / LEAN_DENSE.length));
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    const { b64 } = roundTrip(text);
    expect(b64.length).toBeLessThan(text.length / 4); // repetitive text compresses well
  });
});

describe("lz-string: lean4web's writer, pinned", () => {
  it("VECTOR: compressToBase64 of the text, padding stripped, is the literal; padded or not, it decodes to the text", () => {
    expect(compressToBase64(VECTOR.text)).toBe(`${VECTOR.codez}=`);
    expect(compressToBase64(VECTOR.text).replace(/=*$/, "")).toBe(VECTOR.codez);
    expect(decompressFromBase64(VECTOR.codez)).toBe(VECTOR.text);
    expect(decompressFromBase64(`${VECTOR.codez}=`)).toBe(VECTOR.text);
    expect(decompressFromBase64(`${VECTOR.codez}==`)).toBe(VECTOR.text);
    expect(VECTOR.text.split("\n").length - 1).toBe(4);
  });
  it("the URI-safe variant: the same stream in the `+-$` alphabet, no padding", () => {
    // This text's stream carries a 63 (`/` in base64, `-` URI-safe), so the two spellings differ.
    const text = "example (p q : Prop) (hp : p) (hq : q) : p ∧ q := ⟨hp, hq⟩\n";
    const { b64, uri } = roundTrip(text);
    expect(b64).toBe("KYDwhgtgDgNsAEAKK8CO8Bc8AKAnA9lAJRIAWKWxZ6WqJl8g5ERqYC88gF+TkA08pqgS/IAUEA==");
    expect(uri).toBe("KYDwhgtgDgNsAEAKK8CO8Bc8AKAnA9lAJRIAWKWxZ6WqJl8g5ERqYC88gF+TkA08pqgS-IAUEA");
    expect(uri).toBe(b64.replace(/=+$/, "").replace(/\//g, "-"));
    // VECTOR's stream has no 62/63, so its two spellings coincide (one reason codeFromHash sniffs `-`/`$`).
    expect(compressToEncodedURIComponent(VECTOR.text)).toBe(VECTOR.codez);
    // A `+` that a form decoder turned into a space is read back as `+`, as the package does.
    expect(decompressFromEncodedURIComponent(uri.replace(/\+/g, " "))).toBe(text);
  });
});

describe("lz-string: decoding limits", () => {
  it("maxChars: a stream that would decode to more than the cap yields null, one within it decodes", () => {
    const text = "a".repeat(100_000);
    const b64 = compressToBase64(text);
    expect(b64.length).toBeLessThan(700); // LZW on a repeat: the expansion is quadratic in the stream
    expect(decompressFromBase64(b64, 100_000)).toBe(text);
    expect(decompressFromBase64(b64, 99_999)).toBeNull();
    const uri = compressToEncodedURIComponent(LEAN_DENSE);
    expect(decompressFromEncodedURIComponent(uri, LEAN_DENSE.length)).toBe(LEAN_DENSE);
    expect(decompressFromEncodedURIComponent(uri, LEAN_DENSE.length - 1)).toBeNull();
  });
  it("garbage: a stream that ends early is '', a corrupt first code is null (the Worker port answers the same; never a throw, never text)", () => {
    expect(decompressFromBase64("N4Ig")).toBe("");
    expect(decompressFromBase64("3")).toBeNull(); // first code 3: corrupt, as qed64-zulip/src/lz-string.mjs
    expect(decompressFromBase64("3o69DwDD2rE")).toBeNull();
    expect(decompressFromBase64("!!!!")).toBe("");
    const truncated = VECTOR.codez.slice(0, 40);
    expect(decompressFromBase64(truncated)).toBe("");
    const corrupted = `${VECTOR.codez.slice(0, 30)}zzzz${VECTOR.codez.slice(34)}`;
    const out = decompressFromBase64(corrupted);
    expect(out === null || typeof out === "string").toBe(true);
    expect(out).not.toBe(VECTOR.text);
  });
});
