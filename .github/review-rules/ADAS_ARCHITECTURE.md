# ADAS Architecture Review Rules

> The reviewer MUST check every changed file against these invariants.
> A violation of anything in **BLOCKING** ⇒ `decision: request_changes`.
> This is an **architecture** review, not a style review. Do not comment on
> formatting, naming preferences, or import order here unless they cause a real
> architectural problem.

## The two-system split (BLOCKING)

There are **two** systems with **different** storage. Never blur them.

| System | Storage | Role |
|--------|---------|------|
| **ADAS Core** (`apps/backend`, `apps/mcp-server`, connectors) | **MongoDB ONLY** — no filesystem for runtime data | Runtime execution engine |
| **Skill Builder** (`adas_mcp_toolbox_builder`, `_builder/`) | **Filesystem ONLY** + API calls to Core | Design-time tool |

- **BLOCKING:** Core code that persists *runtime* data to the filesystem instead
  of Mongo (config YAML / policy / trace logs are the known FS exceptions — new
  runtime state on disk is a regression).
- **BLOCKING:** Any read of `_builder/` FS from Core, or any Mongo access from
  the Builder. Data flows one way, at deploy: Builder FS → (API) → Core Mongo.

## Tenant isolation (BLOCKING)

- **One tenant = one solution.** Every runtime path must resolve tenant from a
  **verified** JWT/PAT/service-token — **never** from a bare `X-ADAS-TENANT`
  header or a caller-supplied arg.
- **NEVER fall back to a default tenant.** Missing/ambiguous tenant ⇒ **fail
  loudly** with an error. A silent default is a cross-tenant leak ⇒ BLOCKING.
- Module singletons that hold tenant state across requests (e.g. a
  `setInterval` closure capturing one tenant) are a tenant bug ⇒ BLOCKING.

## Internal communication = hidden MCP facades, NOT HTTP routes (BLOCKING)

- **ALL internal features go through hidden `cp.*_api` tool facades**
  (`planner.visible: false`) under `tools/impl/controlpanel/`, invoked via
  `POST /mcp tools/call`.
- **BLOCKING:** a new HTTP route added to `apps/backend/server.js` (or a new
  Express router) for an *internal* feature. `server.js` is the PUBLIC API
  surface only. The four facades: `cp.fe_api`, `cp.admin_api`,
  `cp.connectors_api`, `cp.triggers_api`.
- The planner must **never** be able to execute a `cp.*_api` facade
  (`executeToolStep.js` blocks it). A change that exposes one to the planner ⇒
  BLOCKING.

## Extend the kernel generically — never patch with a solution-specific hack (BLOCKING)

- A change to core/kernel/reasoning-engine code that **names a domain concept**
  (a specific skill, connector, or business noun) is a patch, not an extension
  ⇒ BLOCKING. Litmus test: if the diff hard-codes "orders" / "smart-home" /
  a specific skill id into generic engine code, reject it.
- The platform is **generic, domain-agnostic, and self-healing**. Prefer
  deriving correct state from ground truth over adding a guard for one case.

## New platform capability = new service (BLOCKING for large accretions)

- A genuinely new platform capability should be a **new service** (like
  `memory-mcp`, `docs-index-mcp`, `solution-template-registry-mcp`), not new
  weight bolted onto Core. Flag large capability accretions inside `apps/backend`
  that should have been a separate service.

## CORE is tenant/solution-agnostic & VM-portable (BLOCKING)

- **CORE must never depend on a specific tenant or solution.** No tenant id,
  solution id, solution API key, or solution-specific health check may be baked
  into CORE code, CI, deploy gates, or config. A CORE deploy/health gate that
  auths to one tenant's solution (e.g. an `ateam`/`ada` solution check) ⇒ BLOCKING
  — a solution bug or a rotated tenant key must never redden a healthy CORE.
- **CORE must run self-contained as a single VM** with *no solution present* —
  its startup, health, and CI checks must pass on a fresh install that has zero
  tenants/solutions. Anything that assumes a particular solution exists ⇒ BLOCKING.
- Solution-level concerns (a specific solution's health, keys, endpoints) belong
  in a **separate per-solution monitor**, never in CORE. Keep the platform
  generic and domain-agnostic (see also `new-capability = new service`).

## No architectural drift — reuse existing services & patterns (BLOCKING)

The reviewer must actively look for **duplication and drift**, not just local
correctness. Before accepting new code, verify it reuses what already exists.

- **Centralized DB access only.** All MongoDB access goes through the central
  **storage DAL / storage services** — never open ad-hoc `db.collection(...)` or
  hand-roll a query in a route/tool/connector when a DAL method exists. A new
  raw collection access that bypasses the storage boundary ⇒ BLOCKING.
  (The storage-boundary guard + `storage/tests/dalLeakClosure.test.js` exist for
  exactly this; a change that reintroduces scattered `db.collection()` callers is
  a regression.)
- **Do not replicate logic that already lives in a service/util.** If a helper,
  service, middleware, or DAL already implements a behavior (tenant resolution,
  LLM-usage recording via the usage DAL, actor/identity lookup, capability
  routing, config/TSEC resolution, context building, etc.), **call it** — do not
  re-implement a second copy. Two divergent implementations of the same concept
  ⇒ BLOCKING.
- **Reuse the established communication pattern.** Cross-component / cross-service
  calls must use the existing mechanism (hidden `cp.*_api` facades via `/mcp`,
  the shared-secret service-to-service call, the sys handoff/ask tools, platform
  `callTool`). Inventing a parallel channel that duplicates an existing one ⇒
  BLOCKING (this is what caused the engine + trigger-runner holes).
- **Search before adding.** When the diff introduces a new util/service/route,
  the reviewer should grep for an existing equivalent; if one exists, the new
  code should reuse it or justify why the existing one is unsuitable. Unjustified
  duplication is a maintainability + correctness defect, not a style nit.

## Settings & configuration — TSEC + UI-visible, no new env (BLOCKING)

- **Every setting/switch/flag/threshold must resolve through TSEC**
  (`settingsResolver.resolveSetting(key, {tenant, skill})`) — never a hardcoded
  constant and never a bare `process.env.X` read for behavior. A new
  `process.env` read that controls behavior ⇒ BLOCKING.
- **Every setting must be visible + changeable in the UI** — SysAdmin (system
  scope) or Tenant Admin (tenant scope). A switch with no UI control the operator
  can see and flip ⇒ BLOCKING.
- **Do NOT introduce a new environment variable** unless it is genuinely
  impossible to do via TSEC, and only with the owner's explicit approval. Keep
  the system friendly to promote as a single-env/var **VM** — a new env var in a
  PR (outside the approved bootstrap secrets) ⇒ BLOCKING until justified.
- Secrets are the exception to "no env": they stay DB/secret-store backed and
  fail-closed (see `SECURITY.md`), never plaintext, never a behavior toggle.

## Reasoning engine (BLOCKING)

- **Never bypass reasoning-engine stages** as a "fast path" without a full trace
  of the flow. Only the `greeting` intent is a safe fast-path. A diff that
  short-circuits planning/critic/finalize for other intents ⇒ BLOCKING.
- `job.state.intent` is a plain string; only `"greeting"` may be skipped.

## Backward compatibility & long-term maintainability

- Changing a tool's input/output schema, a stored document shape, an SSE event
  shape, or a public API response is BLOCKING unless the diff also handles the
  old shape (migration/back-compat) or the change is proven unused.
- Deleting or renaming a skill-declared `finalize` predicate, handoff tool
  (`sys.handoffToSkill`, `sys.askSkill`, `sys.findCapability`,
  `sys.listSkills`), or capability-index invalidation hook ⇒ BLOCKING.

## API design (BLOCKING when it breaks a contract)

- Internal service-to-service calls use the shared-secret `/mcp` pattern
  (`X-ADAS-TOKEN` = service secret + `X-ADAS-ACTOR-ID`), not ad-hoc HTTP.
- New public surface should be justified: prefer a tool over a new route,
  a new method on an existing `cp.*_api` facade over a new facade, and a
  separate tool over overloading one tool with a mode/param switch.
- Response/enum/schema changes must stay additive or ship a migration.

## Multi-agent correctness (BLOCKING)

- Routing goes through the sys tools: `sys.handoffToSkill` (terminal),
  `sys.askSkill`, `sys.findCapability`, `sys.listSkills`. Don't invent a
  parallel routing path.
- The per-tenant **capability index** must be invalidated on `saveSkill`; a
  new connector/skill whose tools don't reach the planner is a regression.
- Held-skill handoff must stay correct: a handoff must not strand a held skill
  or double-execute it. Conversation/plan state after a handoff must be
  deterministic (see `CONCURRENCY_AND_STATE.md`).

## Non-blocking (note, don't block)

- Naming, comments, docs, logging verbosity, dead-code cleanup, small local
  optimizations, test-only helpers. Report these under `non_blocking_findings`.
