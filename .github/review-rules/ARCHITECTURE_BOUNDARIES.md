# ai-dev-assistant Architecture Boundaries (BLOCKING)

> **Scope guard:** applies ONLY to the `ai-dev-assistant` monorepo. If you are
> reviewing a different repo, SKIP this file. For ai-dev-assistant PRs, the full
> module map + boundary contracts live in **`Docs/ARCHITECTURE_MAP.md`** — open and
> read it; judge the change against the module boundaries it documents, not just
> local correctness.

## The two axes (memorize)

- **`attachActor()` line (`apps/backend/server.js`):** above = pre-auth/public,
  below = inside a frozen ALS `{tenant, actorId, auth}` frame. Auth is positional.
- **Two `/mcp` surfaces:** backend `/mcp` (dispatcher; `cp.*`/`platform.*`/`sys.*`
  local, else proxy) vs adas-mcp `/mcp` (:4310, out-of-process tool execution).
  Don't confuse them.

## Boundary violations to BLOCK

1. New HTTP route on `server.js` (above `attachActor`, not in `PUBLIC_SURFACE`) for
   an **internal** feature → must be a `cp.*_api` facade via `/mcp`.
2. A `cp.*_api` facade/method without `gateCpMethod` (or extending `KNOWN_UNGATED`
   to dodge the guard).
3. Weakening the planner→facade block in `executeToolStep.js`.
4. Tenant/actor from a **bare header** on an auth path (must be the JWT claim / ALS
   frame; only a shared-secret caller may assert actor, via the constant-time secret).
5. Raw Mongo bypassing `getTenantDb()`/`getSystemDb()`; any `|| "default"` tenant.
6. A connector `/mcp` (or new REST route) without an **in-handler** token gate, or a
   gate on a sibling route only (round-031 trap).
7. A new parallel HTTP channel into Core, or a new platform capability **bolted into
   Core** instead of a new gated service/connector.
8. Sandbox/solution code addressing a connector directly or acquiring
   `ADAS_MCP_TOKEN` instead of going through `platform.callTool`.
9. A direct LLM-provider call / hardcoded model string bypassing `callAI` (stage
   registry tiering + `llm_usage` attribution).
10. A main-process-only tool (touches connectorManager/job store/SSE/`callAI`) not
    added to the backend `/mcp` local-dispatch allowlist → silently proxied to
    adas-mcp (ghost jobs / empty LLM responses).
11. Plugin id / serving-path drift (`mcp:<conn>:<plugin>`; platform vs
    `/tenants/<t>/mcp-store` assets); an RN bundle missing its `bundleHash` (SHA-256).
12. A satellite service reaching Core-owned Mongo (actors/skills/conversations)
    directly, or authorizing off a bare `X-ADAS-TENANT`.
13. A setting not routed through TSEC or not UI-visible; a new env var (see
    `feedback`/settings rule).

For anything non-obvious, trace the crossing in `Docs/ARCHITECTURE_MAP.md` §4 (the
allowed crossings) and §5 (the full violation list) before deciding.
