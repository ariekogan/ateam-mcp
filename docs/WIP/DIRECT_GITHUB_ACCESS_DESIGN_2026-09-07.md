# ADAS Direct GitHub Access — Architecture & Implementation Design

**Date:** 2026-09-07  
**Status:** Design / implementation target

## 1. Decision

Capable external AI agents should use **full/native GitHub access directly** for source control, while `ateam-mcp` remains the ADAS gateway for platform knowledge and ADAS-specific operations.

Target model:

```text
External AI Agent
  ├── ateam-mcp          -> ADAS knowledge, validate, build, deploy, test, runtime truth
  └── Native GitHub      -> repo, files, branches, commits, diffs, PRs, reviews, merges
```

Existing `ateam_github_*` tools remain as a compatibility/fallback path for agents that do not have native GitHub capability.

**Do not build another proprietary GitHub MCP unless a concrete requirement cannot be satisfied by standard/native GitHub access.**

---

## 2. Current state confirmed in code

`ateam-mcp` already exposes a substantial reduced GitHub abstraction, including:

- `ateam_github_read`
- `ateam_github_patch`
- `ateam_github_write`
- `ateam_github_log`
- `ateam_github_diff`
- `ateam_github_push`
- `ateam_github_pull`
- `ateam_github_promote`
- `ateam_github_rollback`

The current generated agent workflow teaches a proprietary `dev -> promote -> main` flow, and `ateam_build_and_run` currently states that it always deploys `main`.

The Builder implements corresponding `/github/*` routes.

Therefore this is mainly an **interface, deployment-source and policy change**, not a rewrite of ADAS.

---

## 3. Responsibility split

### `ateam-mcp` owns

- ADAS capability discovery and specifications.
- Realizations and construction guidance.
- Solution/repository binding discovery.
- ADAS validation.
- Build/deploy/redeploy operations.
- Runtime solution/skill/connector/widget health.
- Live tests and verification.
- Device/mobile platform knowledge and actions.
- Source-to-runtime provenance/consistency checks.
- GitHub fallback tools for clients without native GitHub.

### Native GitHub owns

- Repository tree and source exploration.
- General file editing.
- Branch creation/management.
- Commits and history.
- Diffs.
- Pull requests.
- Reviews/comments.
- Merge/conflict workflows.
- GitHub Actions interaction where supported by the agent's GitHub integration.

### Builder/Core owns

- Validation and deployment semantics.
- Runtime execution.
- Tenant/security enforcement.
- Runtime truth.

GitHub repository state must **never be treated as runtime truth**.

---

## 4. Target user/agent flow

1. Agent authenticates to ADAS through `ateam-mcp`.
2. Agent gets or creates a solution.
3. ADAS creates/links the GitHub repository as it does today.
4. `ateam-mcp` returns a machine-readable repository binding.
5. Agent opens that repository using its native GitHub capability.
6. Agent works normally in GitHub: inspect, edit, branch, commit, diff, PR/review/merge as appropriate.
7. Agent asks ADAS to validate/build/deploy a precise Git ref or commit SHA.
8. ADAS resolves the requested ref to an immutable SHA, validates and deploys it.
9. ADAS returns the exact deployed SHA plus runtime evidence.
10. Agent verifies the live solution using ADAS tools.

The user should **not** need to manually find/copy the repository URL between systems.

---

## 5. Repository binding contract

ADAS already knows the relationship:

```text
solution -> GitHub repository
```

That binding must become a first-class machine-readable contract exposed by `ateam-mcp`.

Recommended fields:

| Field | Purpose |
|---|---|
| `provider` | `github`; future-proof for other providers |
| `solution_id` | Stable ADAS solution identity |
| `repository_id` | Stable GitHub repository ID; safer than name alone |
| `owner` | GitHub owner/org |
| `repo` | Repository name |
| `html_url` | Human/navigation URL |
| `clone_url` / `ssh_url` | Optional machine endpoints |
| `default_branch` | Repository default branch |
| `production_ref` | ADAS production convention, if defined |
| `binding_status` | `linked`, `provisioning`, `disconnected`, `error` |
| `permissions` | Known read/write/PR/merge capability |
| `installation/account identity` | Authorization context identifier, never a secret |

Expose it from solution status/get and preferably via a small explicit discovery operation such as:

```text
ateam_get_repository_binding(solution_id)
```

Bootstrap can advertise that direct GitHub is supported, but solution-specific repository identity must come from the solution binding.

---

## 6. Authentication and authorization

Repository discovery does **not** itself grant GitHub access.

Rules:

1. Never return GitHub tokens through MCP output, prompts, solution files, logs or connector configuration.
2. Prefer the AI host's native GitHub authentication when the host already has authorized GitHub access.
3. ADAS exposes repository identity and required permission scope; the AI host accesses the repository through its own GitHub connection.
4. If the AI host has no native GitHub connection, direct mode is unavailable and existing `ateam_github_*` tools remain the fallback.
5. If future product requirements need one-click delegated access, design a separate short-lived authorization/broker flow. Do not turn repository metadata into credentials.
6. Authorization remains tenant- and solution-scoped. A binding from tenant A must never authorize or reveal tenant B repositories.

### Required investigation

Before implementation, verify whether the current ADAS GitHub App authorization makes an ADAS-created private repository immediately accessible through the user's normal/native GitHub connection. Do not assume this.

---

## 7. Deployment contract — critical architectural change

The current `build_and_run` coupling to `main` is the largest issue for direct GitHub operation.

Direct GitHub needs an explicit source contract.

Suggested conceptual input:

```json
{
  "solution_id": "...",
  "source": "github",
  "ref": "branch | tag | commit-sha"
}
```

Required behavior:

1. Confirm the solution has a valid linked repository.
2. Resolve requested `ref` to an **immutable commit SHA** before build.
3. Verify the repository is the repository bound to the solution.
4. Apply tenant/environment deployment policy.
5. Fetch/build/validate exactly that SHA.
6. Store source repository ID + resolved SHA as deployment provenance.
7. Return the resolved/deployed SHA in the deployment result.
8. Runtime/status APIs expose the deployed source SHA.

### Invariant

**ADAS deploys an immutable commit, not a moving branch name.**

If the agent requests `dev`, ADAS resolves `dev -> abc123...`, deploys `abc123...`, and reports `abc123...` as runtime provenance.

A later movement of `dev` must not change what ADAS claims was deployed.

---

## 8. Safety boundary

Do not cripple GitHub in order to make deployment safe.

The boundary should be:

```text
Normal GitHub work -> unrestricted according to GitHub permissions
ADAS deployment    -> ADAS policy + validation + runtime verification
```

Possible production policies:

- production only deploys `main`;
- production deploys an approved PR merge SHA;
- production deploys any explicitly approved immutable SHA;
- development/test allows arbitrary branches/SHAs.

This is a policy decision and should not be hidden inside general Git operations.

Keep lifecycle states distinct:

- **built** — artifact/source exists;
- **deployed** — platform accepted/deployed it;
- **verified** — live behavior was actually exercised successfully.

A Git commit is not a deployment. A successful deployment is not verification.

---

## 9. Agent capability negotiation

`ateam-mcp` cannot assume every external agent has native GitHub.

Teach two valid modes.

### Mode A — Direct GitHub (preferred)

Use when the agent has native/full GitHub capability:

```text
discover solution repo
-> use GitHub directly
-> choose exact ref/SHA
-> ADAS validate/deploy
-> ADAS runtime verify
```

### Mode B — MCP fallback

Use when the agent does not have native GitHub capability:

```text
use ateam_github_* tools
-> ADAS validate/deploy
-> ADAS runtime verify
```

Agent docs/advisor should say:

> Prefer direct GitHub when available. Use the ADAS GitHub tools as the fallback when native GitHub access is unavailable.

The proprietary GitHub tools must no longer be taught as the mandatory development workflow.

---

## 10. Required implementation work

### P0 — required for first usable version

1. **Repository binding discovery**
   - Add canonical machine-readable solution -> repository binding.
   - Expose through `ateam-mcp`.

2. **Agent teaching**
   - Update bootstrap/agent docs/advisor/examples.
   - Direct GitHub preferred when available.
   - Existing GitHub tools remain fallback.

3. **Exact-ref deployment**
   - Builder deploy API accepts branch/tag/SHA where policy allows.
   - Resolve to immutable SHA before build.

4. **Repository identity enforcement**
   - Reject attempts to deploy source from a repository not bound to the solution unless an explicit future rebind operation authorizes it.

5. **Deployment provenance**
   - Store repository ID, requested ref and resolved SHA.
   - Return them in deploy result.

6. **Runtime provenance**
   - Solution/deploy status exposes exact deployed SHA.

7. **Deployment policy**
   - Define allowed refs for dev/test and production.
   - Do not silently retain `main` assumptions in consumers.

### P1 — hardening

8. Keep all existing `ateam_github_*` fallback behavior working.
9. Add audit logs: actor, tenant, solution, repo, requested ref, resolved SHA, deployment result.
10. Surface linked repository and deployed commit in product/admin UI where useful.
11. Add source-vs-runtime consistency checks around exact SHA provenance.

### P2 — later simplification

12. Measure direct-mode use against fallback mode.
13. De-emphasize redundant proprietary GitHub tools only after direct mode is proven.
14. Never remove fallback solely for architectural cleanliness; retain what unsupported clients actually need.

---

## 11. Existing assumptions/consumers that must be audited

Before code changes, search all repositories for assumptions equivalent to:

- `dev -> promote -> main` is mandatory;
- `build_and_run` always reads `main`;
- GitHub writes must pass through `ateam_github_patch/write`;
- deployment success implies GitHub push success;
- repository mirror equals deployed runtime state;
- rollback means proprietary tag only;
- repository URL/name is sufficient identity without stable repository ID;
- GitHub App connection means every external agent automatically has direct repository access.

This audit must cover at least:

- `ateam-mcp`
- `adas_mcp_toolbox_builder`
- relevant `ai-dev-assistant`/Core consumers
- deployment provenance/status APIs
- agent documentation/spec examples

---

## 12. Tests required before release

### Direct mode

1. Fresh solution -> ADAS auto-creates repo -> agent discovers binding -> native GitHub commit -> deploy exact SHA -> live verification.
2. Existing solution with already-linked repository.
3. Branch ref resolves to SHA and that exact SHA is recorded.
4. Branch moves after deployment begins; deployed provenance remains the originally resolved SHA.
5. PR/merge workflow followed by exact production SHA deployment.
6. Rollback to a previously deployed SHA.

### Security / failure

7. Wrong repository is rejected.
8. Cross-tenant repository is rejected.
9. Unauthorized GitHub client gets a clear authorization failure.
10. Missing/disconnected/deleted/renamed repository gives actionable binding status.
11. Production rejects a ref that violates policy.
12. Repository-binding identity mismatch fails closed.

### Runtime truth

13. Builder/runtime status reports the same source SHA actually deployed.
14. GitHub source changing after deploy does not alter runtime provenance.
15. Built/deployed/verified states remain distinct.

### Compatibility

16. Agent without native GitHub can still build through `ateam_github_*` fallback.
17. Existing clients do not break when repository-binding fields are added.
18. Existing deployment path remains valid during migration.

---

## 13. Migration plan

### Phase 1 — Add, do not remove

Add:

- repository binding;
- exact-ref/SHA deployment;
- source provenance;
- runtime SHA visibility.

Keep all current workflows working.

### Phase 2 — Teach dual mode

Update:

- bootstrap;
- `CLAUDE.md`/agent document generation;
- advisor;
- examples;
- workflow descriptions.

Direct GitHub becomes preferred when available.

### Phase 3 — Prove with real agents

Run fresh ChatGPT and Claude solution builds using native GitHub.

Compare with proprietary GitHub workflow:

- number of tool calls;
- failures/retries;
- context consumption;
- build time;
- correctness;
- ability to understand history/diffs/conflicts;
- user intervention required.

### Phase 4 — Simplify from evidence

Only after proof:

- de-emphasize redundant `ateam_github_*` tools;
- retain minimum useful fallback capability;
- remove obsolete teaching and assumptions.

---

## 14. Decisions still requiring proof

1. Which native GitHub integration(s) are guaranteed in target environments: ChatGPT, Claude, Codex and other external agents?
2. Are current GitHub App permissions sufficient for direct-agent workflows?
3. Can a native GitHub client reliably access an ADAS-created private repository immediately after ADAS provisioning?
4. Should production continue requiring `main`, approved merge SHA, or any policy-approved immutable SHA?
5. Should ADAS continue only auto-creating repositories, or also support explicitly binding an existing repository?
6. Which current Builder/Core structures already store commit provenance, and which must be extended?

These are **investigation items**, not assumptions.

---

## 15. Non-goals

- Do not build a new ADAS GitHub MCP that duplicates GitHub.
- Do not expose long-lived GitHub credentials through `ateam-mcp`.
- Do not delete existing GitHub fallback tools before direct mode is proven.
- Do not equate repository state with runtime state.
- Do not weaken ADAS deployment validation or security.
- Do not make this Ada Guide-specific. This is a general ADAS external-agent development architecture.

---

## 16. Definition of done

This architecture is complete only when:

> A fresh capable external AI agent receives an ordinary product request, discovers the ADAS-linked repository without human copy/paste, uses its full GitHub capability naturally, deploys an explicitly identified immutable commit through ADAS, and proves that the running solution came from that exact commit — while an MCP-only agent can still complete the workflow through the fallback path.

---

## 17. Next engineering step

Perform one focused evidence-first review across `ateam-mcp` + Builder (+ Core consumers where relevant) to map:

1. current solution -> repo binding;
2. GitHub App authorization model;
3. `build_and_run` / `main` coupling;
4. existing deployment provenance fields;
5. every consumer that assumes proprietary `dev -> main` promotion;
6. direct-GitHub authentication behavior for an ADAS-created private repo.

Then produce a bounded Phase-1 implementation plan from the actual code before changing behavior.
