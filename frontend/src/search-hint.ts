// The pill's "first library search" hint (UX FILL-A2, HARDENING #88). A library search builds an index of the
// environment the first time it runs in a Lean session: about a minute under Mathlib, and an edit inside the proof
// meanwhile drops the partial index and starts over. There are three indexes, each built once per session
// (kernel wasm64-build/work/libsearch-bake-2026-11-06/ASSESSMENT.md §4):
//   exact  exact?, apply?, exact?%, try? (core's try? runs exact?) and Mathlib's hint and observe: LibrarySearch.ext
//   rw     rw?: core's Rewrites.ext (73-76 s measured, the slowest)
//   rwq    Mathlib's rw??: its RefinedDiscrTree (about 32 s)
// The page shows the hint while a document that names a search of a family not yet warm in this session has been
// elaborating for SEARCH_HINT_AFTER_MS; a family turns warm when an elaborating stretch ends with it in the document.
// UI-only: the timer lives in the page, never in the relay.

export type SearchFamily = "exact" | "rw" | "rwq";

// `hint` and `observe` are plain words, so they count only in tactic position (a line's start, after `by`, `;`,
// `<;>`, `·` or `(`), not in an identifier or most prose. A word that still slips through only shows the hint
// after 3 s of elaborating.
const FAMILIES: readonly (readonly [SearchFamily, RegExp])[] = [
  ["exact", /\b(?:exact|apply|try)\?|(?:^|\bby|<;>|[;·(])[ \t]*(?:hint|observe\??)(?![\w'])/m],
  ["rw", /\brw\?(?!\?)/],
  ["rwq", /\brw\?\?/],
];

export const SEARCH_HINT_AFTER_MS = 3000;
const MINUTE = "first library search in this Lean session — about a minute; editing this proof restarts it";
const HALF_MINUTE = "first library search in this Lean session — about half a minute; editing this proof restarts it";

/** The search families a document names. */
export function searchFamilies(text: string): SearchFamily[] {
  return FAMILIES.filter(([, re]) => re.test(text)).map(([f]) => f);
}

/** The pill's words for searches whose index is not built yet: rw?? alone takes about half a minute. */
export function searchHintText(cold: readonly SearchFamily[]): string {
  return cold.some((f) => f !== "rwq") ? MINUTE : HALF_MINUTE;
}

/** Per-session warm-index tracking. `status` on every page status, `tick` once a second; `shown` is the hint of the
 * current elaborating stretch, if one was shown. `now` is injectable for tests. */
export function createSearchHint(now: () => number = () => performance.now()) {
  let session = "";
  let since: number | null = null;
  let shown: string | null = null;
  let warm = new Set<SearchFamily>();
  const seen = new Set<SearchFamily>(); // families named during this stretch (the search may be gone from the text by its end)
  return {
    status(s: { session: string; phase: string }, text: string): void {
      if (s.session !== session) { session = s.session; warm = new Set(); since = null; seen.clear(); shown = null; }
      if (s.phase === "elaborating") { since ??= now(); return; }
      if (since !== null) for (const f of [...seen, ...searchFamilies(text)]) warm.add(f); // those searches ran
      since = null; seen.clear(); shown = null;
    },
    tick(text: string): string | null {
      if (since === null || shown !== null) return null;
      const cold = searchFamilies(text).filter((f) => !warm.has(f));
      if (cold.length === 0) return null;
      for (const f of cold) seen.add(f);
      if (now() - since < SEARCH_HINT_AFTER_MS) return null;
      return (shown = searchHintText(cold));
    },
    get shown(): string | null { return shown; },
  };
}
