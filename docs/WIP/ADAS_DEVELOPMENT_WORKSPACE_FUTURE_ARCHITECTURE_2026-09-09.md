# FUTURE ADAS — Development Workspace / GitHub Architecture

**Date:** 2026-09-09  
**Status:** Architecture project handoff / investigation target  
**Scope:** Future architecture only. This is not a current Ada Guide, Builder bug-fix, or Core bug-fix work item.

## 1. Why this project exists

ADAS is moving toward a model where **any capable AI agent can develop a complete ADAS solution**, not only an AI that happens to have access to Arie's Mac, a particular desktop application, or ADAS-specific file-editing wrappers.

The discussion started as a GitHub simplification question: why should ADAS reimplement normal Git/GitHub operations through `ateam_github_*` when capable development agents already understand repositories, branches, commits, diffs, merges, history and normal development workflows?

That led to the direct-GitHub architecture documented in:

- `docs/WIP/DIRECT_GITHUB_ACCESS_DESIGN_2026-09-07.md` in `ariekogan/ateam-mcp`.

That document established the responsibility split:

```text
External AI Agent
  ├── ateam-mcp          -> ADAS knowledge, validation, build, deploy, test, runtime truth
  └── Native GitHub      -> normal source-control operations
```

It also established an important principle:

> ADAS-specific tools should add ADAS semantics and safety, not replace generic Git/GitHub abilities that capable agents already possess.

However, that is not sufficient for real software development.

An AI developer needs more than GitHub. It needs somewhere to **actually work**: a filesystem, real Git checkout, shell, runtimes, dependency installation, builds, tests and development tools.

Therefore the project has expanded from "direct GitHub access" into a more fundamental product capability:

> **ADAS Development Workspace — a full isolated remote software-development environment that ADAS can securely provide to ANY authorized AI agent for a particular ADAS solution.**

This is deliberately broader than a "GitHub MCP".

---

## 2. Existing evidence that led here

### 2.1 ADAS already tried to abstract GitHub

Current `ateam-mcp` exposes a substantial proprietary GitHub surface including `ateam_github_read`, `patch`, `write`, `push`, `pull`, `promote`, `rollback`, `diff` and related operations.

The Builder implements the corresponding GitHub routes and synchronization machinery.

This works, but it means ADAS is recreating part of a development environment instead of letting a capable development agent use the development model it already understands.

### 2.2 A prior Builder investigation independently reached the real-Git conclusion

Relevant Builder document:

- `ariekogan/adas_mcp_toolbox_buider`, branch `dev`
- `docs/DIRECTION_real_git_working_copy.md`
- status in that document: **direction, not a decision; nothing built**

It proposed giving agents a **real Git clone** instead of continuously extending proprietary REST-based Git behavior.

The document records concrete bug classes caused by recreating Git behavior:

1. repository-name derivation disagreed between code paths;
2. custom promotion missed merge-direction behavior that ordinary Git already provides;
3. Builder filesystem and repository were separate copies and could drift;
4. normal Git capabilities such as conflict resolution, rebase, cherry-pick, reset, stash and history otherwise have to be rebuilt or omitted.

Its core observation remains highly relevant:

> A real Git working copy removes an entire class of custom synchronization and Git-semantics bugs.

It also correctly identified security requirements: credentials must be injected per operation rather than stored in `.git/config`, concurrent agents cannot blindly share one mutable index, and exposing unrestricted Git command strings creates an execution boundary rather than merely a source-control API.

### 2.3 The direct-GitHub design then clarified responsibilities

Relevant document:

- `ariekogan/ateam-mcp`
- `docs/WIP/DIRECT_GITHUB_ACCESS_DESIGN_2026-09-07.md`
- commit that introduced the design: `89690fa0561001f81a1ec4911b07fab34c4f181d`

It established:

- capable agents should use native/full GitHub when available;
- `ateam-mcp` remains the ADAS-specific surface;
- repository state is not runtime truth;
- ADAS validation/deployment/runtime verification remain ADAS responsibilities;
- deployments should ultimately identify immutable source provenance rather than pretend a moving branch name is the deployed artifact;
- do not build another proprietary GitHub MCP unless a concrete requirement proves it necessary.

### 2.4 The missing piece became obvious

Native GitHub solves repository operations, but **not development execution**.

A cloud AI agent still needs somewhere to:

- clone/check out the repository;
- inspect and edit the complete tree;
- run `npm install` or equivalent;
- execute tests;
- build bundles;
- run linters/compilers;
- use Node, Python or future runtimes;
- inspect diffs and generated output;
- iterate before asking ADAS to deploy.

Therefore the correct abstraction is not merely "GitHub access".

It is a **full remote development workspace**.

---

## 3. Target architecture

Conceptually:

```text
ANY AI Agent
      │
      ├── ADAS Development Workspace
      │      ├── isolated filesystem
      │      ├── real Git working copy
      │      ├── terminal / shell
      │      ├── GitHub access
      │      ├── Node / npm
      │      ├── Python / other runtimes
      │      ├── dependency installation
      │      ├── builds / compilers / linters
      │      └── tests and development tools
      │
      └── ateam-mcp
             ├── ADAS capability/specification knowledge
             ├── ADAS construction guidance
             ├── validation
             ├── build/deploy operations
             └── runtime/device/platform verification
```

Behind that, for a GitHub-backed solution:

```text
GitHub
   ↕
Isolated real development workspace
   │
   ├── AI development activity
   │
   └── ADAS validation/build/deploy request
                     ↓
                  Builder
                     ↓
                   Core
```

The Development Workspace is **generic software-development infrastructure**.

`ateam-mcp` is **ADAS-specific knowledge and platform operations**.

Do not merge those responsibilities merely because both may be exposed through MCP.

---

## 4. Source-of-truth modes already agreed in the architecture discussion

GitHub must remain optional. Simple solutions must not require GitHub merely because the future advanced development architecture supports it.

### Mode 1 — GitHub OFF / local mode

```text
AI Agent
   ↓
Builder Authored Store
   ↓
Build / Deploy
   ↓
Core
```

The Builder Authored Store is canonical.

### Mode 2 — GitHub-backed mode

At some point ADAS or the user may decide the solution now needs GitHub-backed development. The user connects GitHub and the solution **graduates**.

```text
AI Agents
     ↓
GitHub
     ↕
Isolated Development Workspace
     ↓
Builder
     ↓
Core
```

In this mode **GitHub is canonical source**. The workspace is a real working copy/projection of that source. Builder/Core must not silently become competing authored truths.

### Sticky-mode decision

Once a solution has graduated into GitHub-backed mode, a temporary GitHub/auth/network failure does **not** downgrade it back to local mode.

If GitHub is unavailable:

- source-changing operations are **BLOCKED**;
- safe reads and testing of already-existing/deployed state may continue where appropriate;
- ADAS must surface the outage honestly;
- it must never accept a source edit into a second local authority and hope to reconcile it later.

Reason: silent fallback would recreate the exact two-truth/drift problem the architecture is intended to eliminate.

Leaving GitHub-backed mode requires an **explicit user disconnect**. Exact graduation and disconnect semantics are still open design work.

---

## 5. Why this is a Development Workspace, not a GitHub MCP

GitHub is durable source control. It is not the execution environment.

A development agent needs both:

```text
GitHub = durable source/history/collaboration
Workspace = place where development actually happens
```

A workspace must support normal software engineering activities before deployment. If ADAS only exposes repository file APIs, agents will continue needing proprietary build/edit wrappers or some unrelated external computer.

That defeats the product goal that **ADAS itself can provide a complete development environment to any authorized AI agent**.

Therefore Git/GitHub should be capabilities *inside or adjacent to* the Development Workspace, not the definition of the workspace.

---

## 6. Product requirement

The target is:

> **ADAS can provision a secure, isolated, full software-development environment to ANY authorized AI agent for a particular ADAS solution.**

This must not be designed specifically around:

- ChatGPT;
- Claude;
- Codex;
- Ada Guide;
- Arie's Mac;
- Node.js;
- today's GitHub integration.

Those are clients/use cases, not the architecture boundary.

The environment must be extensible enough for future agents, runtimes and development toolchains.

---

## 7. Isolation scope

The previous real-Git Builder direction discussed one clone per tenant because that matched the Builder filesystem at the time.

For this new product, **tenant isolation alone is not enough as an assumed design**.

The Development Workspace should be investigated as at least **solution-scoped**, because:

- different solutions have different repositories and dependencies;
- resource/network permissions may differ;
- multiple AI agents may work for the same tenant simultaneously;
- destroying/rebuilding one development environment must not damage another solution;
- solution identity is the natural ADAS authorization/deployment boundary.

Whether the final physical isolation is per solution, per agent session, per branch/worktree, or layered combinations is an open question to prove through design.

---

## 8. Major architecture questions — intentionally NOT decided yet

Do **not** jump directly to Docker, Kubernetes, Firecracker, VMs, Codespaces or any other implementation because it sounds familiar.

First inspect the actual requirements and current ADAS infrastructure.

The new architecture project must answer:

### Execution and isolation

- container vs microVM vs VM vs another sandbox technology;
- trust boundary for arbitrary AI-authored code;
- kernel/process/filesystem isolation;
- privilege model;
- CPU/RAM/disk/process/time limits;
- protection against fork bombs, disk exhaustion and malicious build scripts.

### Workspace lifecycle

- create;
- initialize/clone;
- start;
- suspend;
- resume;
- snapshot if needed;
- rebuild;
- destroy;
- idle timeout;
- long-lived vs ephemeral workspace semantics.

### Persistence

- what persists when execution stops;
- Git working tree persistence;
- caches such as npm/pip without cross-tenant contamination;
- generated files;
- uncommitted work recovery;
- whether workspace storage is durable or reconstructable from GitHub.

### Git/GitHub

- real clone/worktree model;
- branches and concurrent agents;
- credentials per operation/session;
- no long-lived token in repository/config/snapshot;
- repository binding to ADAS solution identity;
- direct/native GitHub vs standard Git/GitHub MCP vs thin ADAS workspace gateway;
- migration away from proprietary `ateam_github_*` where evidence proves it redundant.

### Execution toolchain

- shell/terminal API;
- Node/npm initially where required by current ADAS projects;
- Python and other runtimes;
- dependency installation;
- builds/tests/lint/compilers;
- extensible tool/runtime images rather than hardcoding one language forever.

### Networking

- outbound internet policy;
- GitHub access;
- package registries;
- ADAS Builder/Core access;
- tenant-specific external services;
- inbound access if development servers/previews are needed;
- DNS and metadata-service protection;
- network auditability.

### Secrets

- GitHub credentials;
- ADAS credentials;
- build-time secrets;
- short-lived credential injection;
- redaction from logs;
- preventing secrets from being committed;
- preventing credentials from surviving workspace handoff/snapshot;
- solution/tenant authorization boundaries.

### Agent connectivity

Any authorized cloud/desktop AI must be able to discover and connect to its workspace without access to Arie's physical machine.

Determine:

- MCP vs API vs both;
- authentication handshake;
- workspace/solution binding;
- capability discovery;
- terminal/filesystem/Git surfaces;
- reconnect/resume;
- revocation;
- audit identity for every operation.

### Concurrency

- two AI agents on one solution;
- shared workspace vs separate worktrees/workspaces;
- branches;
- locking;
- conflicting edits;
- merge/review workflow;
- preventing one agent from corrupting another agent's index/build state.

### Scaling and operations

- provisioning latency;
- warm pools if justified;
- resource quotas;
- idle suspension;
- cleanup;
- storage growth;
- observability;
- audit trails;
- cost attribution;
- failure recovery.

---

## 9. Relationship to Builder and Core

Do not make the workspace a second ADAS runtime.

The conceptual responsibilities remain:

```text
Development Workspace -> develop/test source
Builder               -> ADAS validation/build/deploy semantics
Core                  -> running ADAS product/runtime truth
```

The workspace may run local development tests, compilers and builds, but **a successful workspace test is not an ADAS deployment and is not runtime verification**.

The existing ADAS distinction remains important:

- **built** — source/artifact exists;
- **deployed** — ADAS accepted/deployed it;
- **verified** — live behavior was exercised successfully.

GitHub and the workspace must not be treated as Core runtime truth.

---

## 10. Relationship to `ateam-mcp`

`ateam-mcp` remains the **ADAS teacher and ADAS operations interface**.

It should continue to tell an agent:

- what ADAS can do;
- which capabilities/realizations exist;
- how ADAS artifacts are constructed;
- validation requirements;
- how to deploy;
- how to inspect runtime/device/platform truth.

The Development Workspace gives the agent the **generic engineering environment** in which it can implement that knowledge.

Do not turn `ateam-mcp` into an unrestricted arbitrary-shell service merely to avoid creating a proper workspace boundary.

---

## 11. Existing ADAS pieces to inspect/reuse before designing new infrastructure

Evidence-first review must cover at least:

### Builder — `ariekogan/adas_mcp_toolbox_buider`

Inspect current `dev`, especially:

- `docs/DIRECTION_real_git_working_copy.md`;
- GitHub service and `/github/*` routes;
- `gitSync.js`;
- `gitSyncBootstrap.js`;
- `gitSyncBackfill.js`;
- solution identity/storage layout;
- tenant context/isolation;
- repository connection/auth handling;
- Builder authored-source storage;
- validation/build/deploy path.

Do not assume the August direction document still exactly matches current code. It is evidence/history, not current implementation truth.

### `ateam-mcp` — `ariekogan/ateam-mcp`

Inspect current `main`, especially:

- `docs/WIP/DIRECT_GITHUB_ACCESS_DESIGN_2026-09-07.md`;
- current `ateam_github_*` tool family;
- bootstrap/agent teaching;
- solution/repository discovery;
- build/deploy/test APIs;
- authentication model;
- what an external AI can currently discover without filesystem access.

### Core — `ariekogan/ai-dev-assistant`

Inspect only where relevant to the future workspace boundary:

- deployment/runtime interface;
- existing connector/container execution architecture;
- tenant security boundaries;
- runtime provenance;
- networking/auth boundaries that a workspace would need to call.

Do not move arbitrary development execution into Core merely because Core already runs runtime containers.

---

## 12. Interaction with current work

This document defines a **future architecture track**.

Do not interrupt or broaden current Builder/Core/Ada Guide fixes to implement this architecture opportunistically.

Current work may provide useful evidence, but the Development Workspace must get its own design and implementation sequence after evidence review.

In particular, current source-store refactors should not be silently expanded into a remote execution platform.

---

## 13. Working hypotheses vs decisions

### Decisions / agreed direction

- **SUPPORTED/DECIDED:** target client is ANY authorized AI agent.
- **SUPPORTED/DECIDED:** a full development environment is needed; GitHub access alone is insufficient.
- **SUPPORTED/DECIDED:** `ateam-mcp` remains ADAS-specific and separate from generic development execution.
- **SUPPORTED/DECIDED:** GitHub remains optional for simple/local solutions.
- **SUPPORTED/DECIDED:** once a solution enters GitHub-backed mode, GitHub becomes canonical source.
- **SUPPORTED/DECIDED:** GitHub-backed mode is sticky across temporary outages.
- **SUPPORTED/DECIDED:** source writes are blocked during GitHub unavailability rather than creating a second source of truth.
- **SUPPORTED/DECIDED:** leaving GitHub-backed mode requires explicit user action.
- **SUPPORTED/DECIDED:** do not create another proprietary GitHub abstraction when normal Git/GitHub capabilities satisfy the requirement.

### Supported hypotheses requiring design proof

- **SUPPORTED:** solution-scoped isolation is a better starting boundary than the older tenant-wide clone proposal.
- **SUPPORTED:** a real Git working copy should replace substantial custom Git synchronization behavior in GitHub-backed mode.
- **SUPPORTED:** the workspace should expose standard development concepts so agents need less ADAS-specific teaching.

### Unknown / deliberately open

- **UNKNOWN:** container vs microVM vs VM vs other sandbox technology.
- **UNKNOWN:** exact persistence model.
- **UNKNOWN:** shared workspace vs per-agent workspace/worktree model.
- **UNKNOWN:** exact MCP/API implementation.
- **UNKNOWN:** whether an existing standard workspace/Git MCP is sufficient.
- **UNKNOWN:** exact graduation transaction from local to GitHub-backed mode.
- **UNKNOWN:** exact explicit-disconnect transaction back to local mode.
- **UNKNOWN:** hosting/orchestration platform and scaling model.

---

## 14. First mission for the dedicated architecture session

Do not start implementation.

### Step 1 — map current reality

Inspect the current Builder, `ateam-mcp` and relevant Core code and produce a concise evidence map of:

1. what can already be reused;
2. what is currently only a design/document;
3. what genuinely does not exist;
4. current security/identity boundaries;
5. current GitHub credential model;
6. current filesystem/build execution model;
7. current source-of-truth transitions.

### Step 2 — derive requirements

From that evidence, define the minimum and eventual Development Workspace capabilities without selecting technology prematurely.

### Step 3 — evaluate technical isolation choices

Only then compare realistic implementation architectures — containers, microVMs, VMs, managed sandbox/workspace systems, etc. — against the actual ADAS requirements.

### Step 4 — architecture decision

Produce:

- component architecture;
- trust/security model;
- lifecycle/state machine;
- source-of-truth state machine;
- agent connection protocol;
- Git/GitHub model;
- execution/runtime model;
- persistence model;
- concurrency model;
- deployment integration;
- phased implementation plan;
- acceptance tests.

---

## 15. Architecture method

ChatGPT is the architecture/design driver for this track.

Use this reasoning discipline:

1. inspect evidence;
2. challenge the premise;
3. understand why current behavior exists;
4. classify important claims as **PROVEN / SUPPORTED / HYPOTHESIS / UNKNOWN**;
5. design from requirements;
6. compare technologies only after requirements are explicit;
7. implement only after architecture review.

Do not treat historical documents as proof of current code. They are pointers and rationale.

---

## 16. Desired end state

The architecture succeeds when this is normal:

```text
User asks an AI to build/change an ADAS product
                    ↓
ADAS authorizes that AI for one solution
                    ↓
AI receives an isolated Development Workspace
                    ↓
AI uses normal filesystem + Git + shell + runtimes + tests
                    ↓
AI uses ateam-mcp to understand ADAS and validate/deploy
                    ↓
Builder deploys explicitly identified source
                    ↓
Core runs it
                    ↓
AI verifies the live product through ADAS
```

No dependence on Arie's Mac. No requirement that the agent be ChatGPT/Claude/Codex. No proprietary imitation of a full development machine through dozens of narrow source-editing endpoints.

**The product is a real, secure ADAS development environment for AI agents.**
