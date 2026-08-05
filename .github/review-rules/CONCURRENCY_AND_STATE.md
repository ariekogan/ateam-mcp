# Concurrency & State Review Rules

> Covers concurrency, race conditions, state management, and deterministic
> conversation/plan state. Applies to all Core services.

## Race conditions & ownership (BLOCKING)

- **Unique ownership.** Exactly one path owns a given side effect (a job's
  execution, a connector's lifecycle, a transport turn). Two code paths that can
  both drive the same effect concurrently ⇒ race ⇒ BLOCKING.
  - Known-good example of the failure mode: a boot orphan-reaper
    (`purgeAllChainSandboxes`) re-running at runtime and force-killing a **live**
    sandbox. Fixes are run-once guards, not retries.
- **Dedup.** Per-connector / per-job dedup must survive restarts; a change that
  reintroduces ghost pileup or double-start of a connector is BLOCKING.
- **STOP / cancel must be honored.** A cancel/abort must actually halt the chain
  and not leave a detached worker running. Regressing chain STOP/cancel is
  BLOCKING.

## Module singletons & tenant capture (BLOCKING)

- A module-level singleton with a `setInterval`/timer or cached client that
  captures **one tenant** and is reused across tenants is a tenant-isolation bug
  ⇒ BLOCKING. Use AsyncLocalStorage for actor/tenant; don't hoist tenant into
  module scope. (Also a `SECURITY.md` / `ADAS_ARCHITECTURE.md` concern.)

## State management (BLOCKING when it corrupts state)

- Core runtime state lives in **Mongo**. `store.js` keeps a RAM cache for
  running jobs; `flushJob()` is the write path. Bypassing `flushJob` to mutate
  Mongo directly (or holding state only in RAM across a restart) risks loss ⇒
  BLOCKING.
- **Batch state updates.** Per-token or per-tiny-delta writes to persistent
  state under a hot loop are a performance/correctness hazard — batch them.
- **Chain-root eviction.** Evicting the chain root out from under a running
  inner loop (leaving `bld.*` empty) is a known corruption ⇒ BLOCKING.

## Deterministic conversation / plan state (BLOCKING)

- Conversation history and plan state must be deterministic across retries and
  handoffs. Non-determinism from unstable ordering, missing idempotency keys, or
  orchestrator misroute (stale `conversation_history` / focus cache) is BLOCKING.
- A handoff (`sys.handoffToSkill`) must leave conversation/plan state in a single
  well-defined shape — no half-migrated or duplicated held-skill state.

## Async correctness (BLOCKING for latency coupling)

- Don't `await` a best-effort/shadow path on the live request path — it couples
  live latency to a non-critical dependency (e.g. a rate-limited shadow starving
  time-budgeted builds). Run best-effort work off the live path.

## Non-blocking

- Micro-optimizations without a measured hot path, extra logging around a race
  you did not change, speculative locking. Report under `non_blocking_findings`.
