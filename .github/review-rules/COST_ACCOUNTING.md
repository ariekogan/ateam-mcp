# Performance, Token Cost & Accounting Review Rules

> LLM calls are the dominant cost in ADAS. These rules protect both correctness
> of usage accounting and cache economics. Applies to any code that calls a
> model or records usage.

## Usage accounting (BLOCKING)

- **No double-counting.** A single model call must be billed/recorded exactly
  once. Duplicated usage accounting (same response counted in two places) is
  BLOCKING.
- **No duplicate cached-token billing.** Cached input tokens must not be counted
  as fresh input. A change that re-bills cached tokens, or that loses the
  cached/uncached split, is BLOCKING.
- Per-stage metrics must attribute to the correct stage, not a generic bucket.

## Cache-friendly prompts (BLOCKING for cache regressions)

- The prompt **prefix must stay stable** so provider prompt-caching keeps
  hitting. Injecting volatile content (timestamps, per-request ids, reordered
  tool lists) high in the prompt busts the cache ⇒ cost regression ⇒ BLOCKING.
- Put variable content at the **end**; keep system/tool preamble byte-stable.

## LLM call plumbing (BLOCKING)

- Route model selection through the **stage registry**, never a hard-coded
  `modelType` string at the call site.
- `callAiWithTools` is a **CORE seam** — changes there are high-blast-radius.
  A diff that alters its behavior needs an explicit, single, justified change
  (Problem → Current → Proposed), not an incidental tweak.
- A dead model id manifests as a 404 — verify model ids are live, not invented.

## Performance (BLOCKING for real hot-path regressions)

- No N+1 model calls or N+1 Mongo queries introduced on a request/loop hot path.
- Don't add a synchronous network hop on the live path for data that could be
  cached or batched.
- Prompt/token bloat: unbounded context growth (whole-file dumps, unpruned
  history) that scales cost with conversation length is BLOCKING — use URI
  handles / retrieval for big content.

## Prompt correctness (BLOCKING for regressions)

- Operational parameters belong **pinned in skill/stage config**, not baked into
  a prompt string. A prompt change that silently alters behavior gated elsewhere
  is a regression.
- Prompt edits must preserve the contract the downstream parser expects
  (JSON shape, tool-call format). Breaking the output contract is BLOCKING.

## Non-blocking

- Wording tweaks that don't change behavior or cache prefix, speculative
  token-savings without measurement, log verbosity. Report under
  `non_blocking_findings`.
