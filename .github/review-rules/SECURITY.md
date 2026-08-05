# Security Review Rules

> Deny-by-default. These mirror the executable guards under
> `apps/backend/security/tests/` (round-031 audit). A change that trips one of
> these is BLOCKING. See `Docs/security/AUDIT_PLAYBOOK.md` for the recurring
> traps (esp. *gate-on-sibling-route-but-`/mcp`-open* and *verify-the-real-caller*).

## No unauthenticated route on Core (BLOCKING)

- Anything mounted **above** `app.use(attachActor())` in `server.js` is public.
  A new pre-auth route is BLOCKING unless it is added to
  `security/publicSurface.js` with a reviewed reason.
- Internal features go **below** attachActor (JWT/PAT) or behind a hidden
  `cp.*_api` tool — **never** a new pre-auth HTTP route.
- The only sanctioned pre-auth service-to-service gate is
  `middleware/requireServiceSecret.js`.

## Every `cp.*_api` facade calls `gateCpMethod` (BLOCKING)

- Enforced by `security/facadeGates.js`. A new facade (or a facade method) that
  skips the role gate is BLOCKING. The planner can never execute a `cp.*_api`
  facade — a diff that lets it is BLOCKING.

## Connector `/mcp` is token-gated, fail-closed, constant-time (BLOCKING)

- Pattern: `requireMcpToken` (see `connectors/memory-mcp/server.js`),
  fail-closed, `crypto.timingSafeEqual`. A connector exposing `/mcp` without
  the token gate is BLOCKING (`connectorMcpAuth.test.js`).
- **Tenant comes from the verified token/JWT, never a bare header.** Actor is
  never taken from a caller-supplied arg without passing the gate.

## Secrets fail closed; compares are constant-time (BLOCKING)

- Never accept a dev-default secret in prod. Missing secret + fail-closed gate ⇒
  return 503, never "allow". All secret comparisons use `timingSafeEqual`.
- **Secrets live in the DB / env, never in code or committed files.** A secret,
  token, private key, or password literal in the diff is BLOCKING.

## Don't dodge a guard (BLOCKING)

- Editing an allowlist (`publicSurface.js`, `KNOWN_UNGATED`, security test
  fixtures) to make a red guard pass — instead of fixing the code — is BLOCKING.
- Do not add unrelated "legacy fixes" inside a security-sensitive change; keep
  the diff auditable.

## Non-blocking

- Log-message wording, adding defensive comments, hardening that is nice-to-have
  but not a real exposure. Report under `non_blocking_findings`.
