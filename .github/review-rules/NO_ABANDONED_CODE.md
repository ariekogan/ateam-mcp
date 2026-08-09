# THE ABANDONED APPROACH MUST LEAVE WITH IT

**Applies to:** every path, every repo. This is not a style rule.

## Why this exists

An agent starts down one path, learns something, and finishes down another. The
second path gets committed. The first one stays — exported but uncalled, a branch
that can never be true, a field nothing writes, a helper with one caller that is
itself dead.

Nothing breaks that day. The cost lands weeks later on whoever reads it: they
cannot tell the abandoned attempt from the live one, so they extend the wrong
thing, or preserve a contract nobody depends on, or spend a review round on code
that does nothing. Every one of the examples below was found by this pipeline
AFTER the work had shipped and been forgotten.

## Flag as BLOCKING

1. **Exported but uncalled** — a function or module the diff adds or leaves behind
   with no production caller. Test-only callers do not count: grep the callers and
   say what you found.
2. **A branch that can never be taken** — a condition the surrounding data cannot
   produce. These are the worst kind, because they read as handled cases.
3. **A field nothing writes, or nothing reads** — a fallback reading `job.tenant`
   when nothing in the repo ever sets it is not a fallback, it is a lie about the
   shape of the data.
4. **Two implementations of one idea**, where the diff adds the second and leaves
   the first. Say which one is live.
5. **A comment, doc, or error message describing the ABANDONED design.** Prose that
   contradicts the code is worse than no prose: the next reader believes it.
6. **A revert that removed the wiring but kept the machinery** — code now reachable
   from nothing, waiting to confuse someone.

## Not this rule

Genuinely new code that a follow-up commit will wire up, IF the diff says so.
Public API surface with external consumers. Test fixtures and helpers. Anything the
author explicitly marks as staged, with the next step named.

The distinguishing question: **would a reader six weeks from now be able to tell
this was deliberate?** If only the author's memory separates "not wired yet" from
"abandoned", it is abandoned.

## How to report it

Name the symbol, and state what you actually checked — "grep for `continueJob`
across the repo returns only its definition" is actionable; "this looks unused" is
not. If the diff is the *second* attempt at something, say which attempt is live
and which should go.

## Verified examples (all found after the fact, all in this codebase)

- `continueJob` — no callers anywhere in the repository.
- `evaluateHypothesis` — exported-but-uncalled after a revert removed its wiring,
  and its narrow `hasContent` probe was still being reported as a live bug.
- A tool-loader expansion branch that "never matched anything", reverted later.
- Legacy-shape detection in `hlrHypothesis.js` that could never fire for the shape
  its own comment documented.
- `await persistJob(job)` awaiting a synchronous void function — implying a durable
  write that does not happen.
- A dead `all` binding in the review publisher.
- A `job.tenant` / `job.__tenant` fallback where nothing in the repo writes either.
