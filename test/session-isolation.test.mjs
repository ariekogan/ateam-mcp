// Session isolation on the HTTP transport.
//
// THE PROPERTY: a session cannot be reused by another bearer, or by a caller
// with no bearer at all. A session id is client-supplied and NOT a secret — it
// is logged and echoed in the mcp-session-id header — so holding one must never
// be enough to act as the tenant whose key sits in that session.
//
// Two layers enforce it, and this file tests each on its own:
//
//   Layer 1 — the bearer gate (`mcpAuth` in src/http.js, on BOTH "/" and
//     "/mcp" since 39ff024). A request with no valid bearer gets a 401 OAuth
//     challenge before any MCP handler runs: no session is minted, and none is
//     reused.
//   Layer 2 — session ownership (`denySessionReuse` + `bearerOwnershipOk`,
//     c294d0f). A session is bound to the bearer that created it, and any other
//     bearer is refused with 401 -32001, on POST, GET and DELETE. Layer 1 cannot
//     do this: verifyAccessToken (src/oauth.js) checks only the key's SHAPE, so
//     any well-formed bearer passes layer 1.
//
// HISTORY — why the old "no-bearer" checks are gone and must not come back.
// Until 39ff024, "/mcp" was optional-auth (704206e), and this file asserted
// that an anonymous client could initialize a session and reuse it ("no-bearer
// ateam_auth flow"). A session made that way has no bound bearer, and
// bearerOwnershipOk(null, anything) is true, so anyone holding its id could use
// whatever tenant key ateam_auth had put into it. 39ff024 closed that by making
// both paths strict, and the three no-bearer checks then failed. They were
// asserting the hole, not the property. They are inverted below.
//
// Every bearer here is a plain adas_<tenant>_<hex> key, so seedCredentials
// never calls whoami: this test makes no network calls.
//
// Run: node test/session-isolation.test.mjs   (npm test runs it too)

import net from "node:net";
import { bearerOwnershipOk, getSessionBearer } from "../src/api.js";

const BEARER_A = "adas_tenanta_00000000000000000000000000000000";
const BEARER_B = "adas_tenantb_11111111111111111111111111111111";

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); failures++; }
}

// ─── 1. Unit: bearerOwnershipOk ──────────────────────────────────────────────
// A session has no bound bearer only when OAuth is disabled. With OAuth on,
// layer 1 guarantees that every request carries a bearer, and seedCredentials
// binds it (checked in section 2). An unbound session has no owner to compare
// against, so reuse is allowed. That is why ATEAM_OAUTH_DISABLED is an escape
// hatch and not a supported mode.
console.log("unit: bearerOwnershipOk");
check("unbound session + no token → allow", bearerOwnershipOk(null, undefined) === true);
check("unbound session + some token → allow", bearerOwnershipOk(null, BEARER_A) === true);
check("bound bearer + NO token → DENY", bearerOwnershipOk(BEARER_A, undefined) === false);
check("bound bearer + empty token → DENY", bearerOwnershipOk(BEARER_A, "") === false);
check("bound bearer + DIFFERENT token → DENY", bearerOwnershipOk(BEARER_A, BEARER_B) === false);
check("bound bearer + SAME token → allow", bearerOwnershipOk(BEARER_A, BEARER_A) === true);

// ─── Boot two listeners over ONE session table ───────────────────────────────
// `transports` (src/http.js) and `sessionBearers` (src/api.js) are module-level,
// so two startHttpServer() calls in one process share them. The second listener
// runs with OAuth DISABLED, which is the only way to put a request with no
// validated bearer in front of a bearer-bound session, and so the only way to
// test layer 2 without layer 1 in the way. That is the exact situation if
// someone reopens the gate (reverts 39ff024) to let an anonymous client back in.
// Production never shares a table like this: this setup exists only in the test.
// If the state ever becomes per-server, section 3 fails loudly rather than
// passing silently.
//
// Ports are asked from the OS, so two runs on one machine do not collide.
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const PORT = await freePort();
const PORT_OPEN = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_OPEN = `http://127.0.0.1:${PORT_OPEN}`;

process.env.ATEAM_BASE_URL = BASE;               // OAuth issuer = self (no network)
const { startHttpServer } = await import("../src/http.js");
delete process.env.ATEAM_OAUTH_DISABLED;
startHttpServer(PORT);                           // OAuth ON: what mac1 and prod run
process.env.ATEAM_OAUTH_DISABLED = "1";
startHttpServer(PORT_OPEN);                      // OAuth OFF: layer 2 alone
delete process.env.ATEAM_OAUTH_DISABLED;
await new Promise((r) => setTimeout(r, 400));

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

async function mcp(method, { path = "/mcp", base = BASE, headers = {}, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  // A GET that is let through opens an SSE stream: read only status + headers.
  const stream = method === "GET" && res.status === 200;
  const text = stream ? "" : await res.text();
  if (stream) res.body?.cancel().catch(() => {});
  return { status: res.status, sid: res.headers.get("mcp-session-id"), www: res.headers.get("www-authenticate") || "", text };
}
const sid = (s) => ({ "mcp-session-id": s });
const bearer = (b) => ({ authorization: `Bearer ${b}` });

// Layer 1 answered: 401, a WWW-Authenticate that sends the client to OAuth
// discovery (RFC 9728), and no session id handed out.
const challenged = (r) =>
  r.status === 401 &&
  /^Bearer /.test(r.www) &&
  r.www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`) &&
  !r.sid;
// Layer 2 answered: the session belongs to a different credential.
const ownershipDenied = (r) => r.status === 401 && /"code":\s*-32001/.test(r.text);
// The owner can still use its session.
const listedTools = (r) => {
  try { return r.status === 200 && Array.isArray(JSON.parse(r.text).result?.tools); } catch { return false; }
};

// ─── 2. Integration, OAuth ON (the deployed configuration) ───────────────────
console.log("integration (OAuth on): A opens a session with its bearer");
const initA = await mcp("POST", { headers: bearer(BEARER_A), body: INIT });
const SID_A = initA.sid;
check("A init (bearer A) → 200 + session id", initA.status === 200 && !!SID_A);
check("A's session is bound to A's bearer", getSessionBearer(SID_A) === BEARER_A);

for (const path of ["/", "/mcp"]) {
  console.log(`integration (OAuth on): layer 1 on "${path}", no bearer = OAuth challenge`);
  check(`${path} anonymous initialize → 401 challenge, no session minted`,
    challenged(await mcp("POST", { path, body: INIT })));
  check(`${path} initialize with a malformed bearer → 401 challenge, no session minted`,
    challenged(await mcp("POST", { path, headers: bearer("not-an-adas-key"), body: INIT })));
  check(`${path} anonymous call on an unknown session id (stale-recovery path) → 401 challenge`,
    challenged(await mcp("POST", { path, headers: sid(`stale-${Date.now()}`), body: TOOLS_LIST })));
  check(`${path} anonymous POST with A's session id → 401 challenge`,
    challenged(await mcp("POST", { path, headers: sid(SID_A), body: TOOLS_LIST })));
  check(`${path} anonymous GET with A's session id → 401 challenge`,
    challenged(await mcp("GET", { path, headers: sid(SID_A) })));
  check(`${path} anonymous DELETE with A's session id → 401 challenge`,
    challenged(await mcp("DELETE", { path, headers: sid(SID_A) })));
}

console.log("integration (OAuth on): layer 2, another bearer on A's session");
check("cross-bearer POST (A's sid, B's bearer) → 401 -32001",
  ownershipDenied(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_B) }, body: TOOLS_LIST })));
check("cross-bearer GET (A's sid, B's bearer) → 401 -32001",
  ownershipDenied(await mcp("GET", { headers: { ...sid(SID_A), ...bearer(BEARER_B) } })));
check("cross-bearer DELETE (A's sid, B's bearer) → 401 -32001",
  ownershipDenied(await mcp("DELETE", { headers: { ...sid(SID_A), ...bearer(BEARER_B) } })));
check("B's attempts did not rebind A's session", getSessionBearer(SID_A) === BEARER_A);
check("A reuses its own session → 200 tools/list",
  listedTools(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_A) }, body: TOOLS_LIST })));

// ─── 3. Integration, OAuth OFF, same session table: layer 2 alone ───────────
// Do NOT add "anonymous init/reuse works here" checks. That is the hole
// described in the header, written back in.
console.log("integration (OAuth off, shared session table): layer 2 without layer 1");
check("anonymous POST with A's sid → 401 -32001",
  ownershipDenied(await mcp("POST", { base: BASE_OPEN, headers: sid(SID_A), body: TOOLS_LIST })));
check("anonymous GET with A's sid → 401 -32001",
  ownershipDenied(await mcp("GET", { base: BASE_OPEN, headers: sid(SID_A) })));
check("anonymous DELETE with A's sid → 401 -32001",
  ownershipDenied(await mcp("DELETE", { base: BASE_OPEN, headers: sid(SID_A) })));
check("A's session is still bound to A", getSessionBearer(SID_A) === BEARER_A);
check("A still reuses its own session → 200 tools/list",
  listedTools(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_A) }, body: TOOLS_LIST })));

// ─── done ────────────────────────────────────────────────────────────────────
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);
