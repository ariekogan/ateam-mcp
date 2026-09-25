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
//     reused. Its one deliberate exception is token auto-injection: a request
//     with no Authorization, from the client IP that just completed /token, is
//     given THAT IP's token for TOKEN_TTL. Section 5 checks it stays scoped to
//     that IP and that window.
//   Layer 2 — session ownership (`denySessionReuse` + `bearerOwnershipOk`,
//     c294d0f). A session is bound to the bearer that created it, and any other
//     bearer is refused with 401 -32001, on POST, GET and DELETE. Layer 1 cannot
//     do this: verifyAccessToken (src/oauth.js) checks only the key's SHAPE, so
//     any well-formed bearer passes layer 1, including a made-up key that names
//     the victim's own tenant. The binding lasts as long as the transport: the
//     idle sweep drops a session's credentials, never its owner (section 4).
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
import { bearerOwnershipOk, getSessionBearer, sweepStaleSessions } from "../src/api.js";

const BEARER_A = "adas_tenanta_00000000000000000000000000000000";
const BEARER_B = "adas_tenantb_11111111111111111111111111111111";
// Same tenant as A, different secret. verifyAccessToken checks only the shape,
// so anyone can write this key. Ownership must compare the WHOLE key: a check
// on the tenant or on a prefix would let it through.
const BEARER_A_OTHER = "adas_tenanta_22222222222222222222222222222222";
// Two sealed keys. A sealed key does not spell out its tenant (parseApiKey
// gives tenant null), so a tenant-only comparison would call these equal.
const SEALED_1 = `adas_prod_${"S".repeat(46)}`;
const SEALED_2 = `adas_prod_${"T".repeat(46)}`;

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); failures++; }
}

// ─── 1. Unit: bearerOwnershipOk ──────────────────────────────────────────────
// With OAuth on, every live session is bound: seedCredentials binds the bearer
// (section 2) and the idle sweep keeps the binding (section 4). So an unbound
// id either has no live session behind it or comes from ATEAM_OAUTH_DISABLED=1.
// An unbound session has no owner to compare against, so reuse is allowed. That
// is why ATEAM_OAUTH_DISABLED is an escape hatch and not a supported mode.
console.log("unit: bearerOwnershipOk");
check("unbound session + no token → allow", bearerOwnershipOk(null, undefined) === true);
check("unbound session + some token → allow", bearerOwnershipOk(null, BEARER_A) === true);
check("bound bearer + NO token → DENY", bearerOwnershipOk(BEARER_A, undefined) === false);
check("bound bearer + empty token → DENY", bearerOwnershipOk(BEARER_A, "") === false);
check("bound bearer + DIFFERENT token → DENY", bearerOwnershipOk(BEARER_A, BEARER_B) === false);
check("bound bearer + another key for the SAME tenant → DENY", bearerOwnershipOk(BEARER_A, BEARER_A_OTHER) === false);
check("bound sealed key + another sealed key → DENY", bearerOwnershipOk(SEALED_1, SEALED_2) === false);
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

console.log("integration (OAuth on): layer 2, a made-up key for A's OWN tenant");
check("same-tenant POST (A's sid, another tenanta key) → 401 -32001",
  ownershipDenied(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_A_OTHER) }, body: TOOLS_LIST })));
check("same-tenant GET (A's sid, another tenanta key) → 401 -32001",
  ownershipDenied(await mcp("GET", { headers: { ...sid(SID_A), ...bearer(BEARER_A_OTHER) } })));
check("same-tenant DELETE (A's sid, another tenanta key) → 401 -32001",
  ownershipDenied(await mcp("DELETE", { headers: { ...sid(SID_A), ...bearer(BEARER_A_OTHER) } })));
check("the same-tenant key did not rebind A's session", getSessionBearer(SID_A) === BEARER_A);
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

// ─── 4. The idle sweep drops credentials, never the owner ───────────────────
// sweepStaleSessions (src/api.js) drops a session idle past SESSION_TTL (60 min)
// but does not close its transport, so the session is still live. It used to
// drop the bearer binding too. Then the next well-formed bearer took over A's
// live session, and A was refused on its own session as "a different
// credential". The clock is moved forward only for the sweep call itself.
console.log("idle sweep: A's session after 61 idle minutes");
let swept;
{
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 60 * 1000;
  try { swept = sweepStaleSessions(); } finally { Date.now = realNow; }
}
check("the sweep swept A's idle session (so the checks below are not vacuous)", swept >= 1);
check("A's session is still bound to A after the sweep", getSessionBearer(SID_A) === BEARER_A);
check("B's bearer on A's swept session → 401 -32001",
  ownershipDenied(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_B) }, body: TOOLS_LIST })));
check("anonymous POST on A's swept session (OAuth off) → 401 -32001",
  ownershipDenied(await mcp("POST", { base: BASE_OPEN, headers: sid(SID_A), body: TOOLS_LIST })));
check("A reuses its swept session → 200 tools/list (credentials re-seeded from its bearer)",
  listedTools(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_A) }, body: TOOLS_LIST })));

// ─── 5. Layer 1's one exception: token auto-injection ───────────────────────
// Claude.ai's OAuth client and its MCP client do not share tokens. So after a
// /token exchange, the server puts that token into no-Authorization requests
// from the SAME client IP, for TOKEN_TTL (5 min). It must stay scoped to that
// IP and that window. A process-global "newest token" gave every anonymous
// caller the last user's key (finding #28). trust proxy is 1, so req.ip is the
// X-Forwarded-For address; that is how this test plays several clients. This
// section runs last because it leaves tokens in the cache.
console.log("auto-injection: a /token exchange serves only its own IP, and only briefly");
const ipHeaders = (ip) => ({ "x-forwarded-for": ip });
async function exchange(key, ip) {
  const r = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...ipHeaders(ip) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: `rt_${key}`, client_id: "ateam-public" }),
    signal: AbortSignal.timeout(5000),
  });
  const json = await r.json().catch(() => ({}));
  return r.status === 200 && json.access_token === key;
}
const IP_A = "10.9.9.1", IP_OTHER = "10.9.9.2", IP_B = "10.9.9.3";
check(`A's /token exchange from ${IP_A} → 200 with A's token`, await exchange(BEARER_A, IP_A));
check(`anonymous POST on A's sid from ANOTHER ip → 401 challenge`,
  challenged(await mcp("POST", { headers: { ...sid(SID_A), ...ipHeaders(IP_OTHER) }, body: TOOLS_LIST })));
check(`anonymous initialize from ANOTHER ip → 401 challenge, no session minted`,
  challenged(await mcp("POST", { headers: ipHeaders(IP_OTHER), body: INIT })));
// Positive control: the cache IS live, so the two refusals above are not vacuous.
check(`anonymous POST on A's sid from A's own ip, within TTL → injected, 200 tools/list (by design)`,
  listedTools(await mcp("POST", { headers: { ...sid(SID_A), ...ipHeaders(IP_A) }, body: TOOLS_LIST })));
check(`B's /token exchange from ${IP_B} → 200 with B's token`, await exchange(BEARER_B, IP_B));
check(`anonymous POST on A's sid from B's ip → B's token injected, still 401 -32001`,
  ownershipDenied(await mcp("POST", { headers: { ...sid(SID_A), ...ipHeaders(IP_B) }, body: TOOLS_LIST })));
{
  const realNow = Date.now;
  // Just past TOKEN_TTL (5 min in src/http.js). Lengthening the TTL fails this
  // check on purpose: the window is part of the security property.
  Date.now = () => realNow() + 5 * 60 * 1000 + 5000;
  try {
    check(`anonymous POST on A's sid from A's own ip, AFTER TTL → 401 challenge`,
      challenged(await mcp("POST", { headers: { ...sid(SID_A), ...ipHeaders(IP_A) }, body: TOOLS_LIST })));
  } finally { Date.now = realNow; }
}

// ─── done ────────────────────────────────────────────────────────────────────
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);
