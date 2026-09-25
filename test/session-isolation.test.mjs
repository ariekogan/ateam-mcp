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
//   Layer 2 — session ownership (`denySessionReuse` + `sessionOwnershipOk`,
//     c294d0f). A session is bound to the bearer that created it, and any other
//     bearer is refused with 401 -32001, on POST, GET and DELETE. Layer 1 cannot
//     do this: verifyAccessToken (src/oauth.js) checks only the key's SHAPE, so
//     any well-formed bearer passes layer 1, including a made-up key that names
//     the victim's own tenant. The binding lasts as long as the transport: the
//     idle sweep drops a session's credentials, never its owner (section 4).
//
// The one other way in is PLATFORM SIGN-IN (section 5): a request that presents
// `x-adas-token` equal to CORE_MCP_SECRET is the platform principal. That is how
// ai-dev-assistant's ateam-proxy-mcp opens its tenant-less session and then signs
// each tenant in with ateam_auth. Its sessions are owned like any other, by a
// principal no bearer can equal, and it is not a master key: a tenant tool on a
// platform session is refused until ateam_auth puts that tenant's key in.
//
// HISTORY — why the old "no-bearer" checks are gone and must not come back.
// Until 39ff024, "/mcp" was optional-auth (704206e), and this file asserted
// that an anonymous client could initialize a session and reuse it ("no-bearer
// ateam_auth flow"). A session made that way has no bound bearer, and
// sessionOwnershipOk(null, anything) is true, so anyone holding its id could use
// whatever tenant key ateam_auth had put into it. 39ff024 closed that by making
// both paths strict, and the three no-bearer checks then failed. They were
// asserting the hole, not the property. They are inverted below.
//
// Every bearer here is a plain adas_<tenant>_<hex> key, so seedCredentials
// never calls whoami. The only upstream is a fake validator on 127.0.0.1,
// started before src/api.js is imported so that it IS the process default
// (ADAS_API_URL). Section 5 reads it to see which key each call carried, and no
// check, even against a mutated server, can reach a real host.
//
// Run: node test/session-isolation.test.mjs   (npm test runs it too)

import net from "node:net";
import http from "node:http";
import { randomBytes } from "node:crypto";

// The fake validator. src/api.js reads ADAS_API_URL once, at import, so this
// runs first and the import below is dynamic.
const seen = [];
const fake = http.createServer((req, res) => {
  seen.push({ path: req.url, key: req.headers["x-api-key"] || null, tenant: req.headers["x-adas-tenant"] || null, platform: "x-adas-token" in req.headers });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, solutions: [] }));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
fake.unref();
process.env.ADAS_API_URL = `http://127.0.0.1:${fake.address().port}`;
const {
  sessionOwnershipOk, getSessionOwner, sweepStaleSessions,
  presentsPlatformSecret, PLATFORM_PRINCIPAL, getAuthOverride,
} = await import("../src/api.js");

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
// The platform secret. presentsPlatformSecret reads CORE_MCP_SECRET per call, so
// a check can switch it off and back on. Random per run; not a real value.
const PLATFORM_SECRET = `platform-${randomBytes(16).toString("hex")}`;
process.env.CORE_MCP_SECRET = PLATFORM_SECRET;

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); failures++; }
}

// ─── 1. Unit: sessionOwnershipOk ──────────────────────────────────────────────
// With OAuth on, every live session is bound: seedCredentials binds the bearer
// (section 2) and the idle sweep keeps the binding (section 4). So an unbound
// id either has no live session behind it or comes from ATEAM_OAUTH_DISABLED=1.
// An unbound session has no owner to compare against, so reuse is allowed. That
// is why ATEAM_OAUTH_DISABLED is an escape hatch and not a supported mode.
console.log("unit: sessionOwnershipOk");
check("unbound session + no token → allow", sessionOwnershipOk(null, undefined) === true);
check("unbound session + some token → allow", sessionOwnershipOk(null, BEARER_A) === true);
check("bound bearer + NO token → DENY", sessionOwnershipOk(BEARER_A, undefined) === false);
check("bound bearer + empty token → DENY", sessionOwnershipOk(BEARER_A, "") === false);
check("bound bearer + DIFFERENT token → DENY", sessionOwnershipOk(BEARER_A, BEARER_B) === false);
check("bound bearer + another key for the SAME tenant → DENY", sessionOwnershipOk(BEARER_A, BEARER_A_OTHER) === false);
check("bound sealed key + another sealed key → DENY", sessionOwnershipOk(SEALED_1, SEALED_2) === false);
check("bound bearer + SAME token → allow", sessionOwnershipOk(BEARER_A, BEARER_A) === true);
check("bound platform + platform → allow", sessionOwnershipOk(PLATFORM_PRINCIPAL, PLATFORM_PRINCIPAL) === true);
check("bound platform + a bearer → DENY", sessionOwnershipOk(PLATFORM_PRINCIPAL, BEARER_A) === false);
check("bound platform + NO token → DENY", sessionOwnershipOk(PLATFORM_PRINCIPAL, undefined) === false);
check("bound bearer + platform → DENY", sessionOwnershipOk(BEARER_A, PLATFORM_PRINCIPAL) === false);

console.log("unit: presentsPlatformSecret fails closed");
check("the secret → true", presentsPlatformSecret(PLATFORM_SECRET) === true);
check("another value of the same length → false",
  presentsPlatformSecret(PLATFORM_SECRET.slice(0, -1) + (PLATFORM_SECRET.endsWith("0") ? "1" : "0")) === false);
check("a prefix of the secret → false", presentsPlatformSecret(PLATFORM_SECRET.slice(0, 12)) === false);
check("the secret plus one character → false", presentsPlatformSecret(`${PLATFORM_SECRET}x`) === false);
check("empty → false", presentsPlatformSecret("") === false);
check("not a string (a repeated header) → false", presentsPlatformSecret([PLATFORM_SECRET]) === false);
{
  // Same number of CHARACTERS, more BYTES. Comparing string lengths and then
  // calling timingSafeEqual on the buffers throws RangeError on this input.
  let threw = false, got;
  try { got = presentsPlatformSecret(`é${PLATFORM_SECRET.slice(1)}`); } catch { threw = true; }
  check("same character length, different byte length → false, and no throw", !threw && got === false);
}
delete process.env.CORE_MCP_SECRET;
check("CORE_MCP_SECRET unset → even the right value is refused", presentsPlatformSecret(PLATFORM_SECRET) === false);
check("CORE_MCP_SECRET unset → empty is refused", presentsPlatformSecret("") === false);
process.env.CORE_MCP_SECRET = "";
check("CORE_MCP_SECRET empty → empty is refused", presentsPlatformSecret("") === false);
process.env.CORE_MCP_SECRET = PLATFORM_SECRET;

// ─── Boot two listeners over ONE session table ───────────────────────────────
// `transports` (src/http.js) and `sessionOwners` (src/api.js) are module-level,
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
const ownershipDenied = (r) => r.status === 401 && /"code":\s*-32001/.test(r.text) && /different credential/.test(r.text);
// The owner can still use its session.
const listedTools = (r) => {
  try { return r.status === 200 && Array.isArray(JSON.parse(r.text).result?.tools); } catch { return false; }
};

// ─── 2. Integration, OAuth ON (the deployed configuration) ───────────────────
console.log("integration (OAuth on): A opens a session with its bearer");
const initA = await mcp("POST", { headers: bearer(BEARER_A), body: INIT });
const SID_A = initA.sid;
check("A init (bearer A) → 200 + session id", initA.status === 200 && !!SID_A);
check("A's session is bound to A's bearer", getSessionOwner(SID_A) === BEARER_A);

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
check("B's attempts did not rebind A's session", getSessionOwner(SID_A) === BEARER_A);

console.log("integration (OAuth on): layer 2, a made-up key for A's OWN tenant");
check("same-tenant POST (A's sid, another tenanta key) → 401 -32001",
  ownershipDenied(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_A_OTHER) }, body: TOOLS_LIST })));
check("same-tenant GET (A's sid, another tenanta key) → 401 -32001",
  ownershipDenied(await mcp("GET", { headers: { ...sid(SID_A), ...bearer(BEARER_A_OTHER) } })));
check("same-tenant DELETE (A's sid, another tenanta key) → 401 -32001",
  ownershipDenied(await mcp("DELETE", { headers: { ...sid(SID_A), ...bearer(BEARER_A_OTHER) } })));
check("the same-tenant key did not rebind A's session", getSessionOwner(SID_A) === BEARER_A);
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
check("A's session is still bound to A", getSessionOwner(SID_A) === BEARER_A);
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
check("A's session is still bound to A after the sweep", getSessionOwner(SID_A) === BEARER_A);
check("B's bearer on A's swept session → 401 -32001",
  ownershipDenied(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_B) }, body: TOOLS_LIST })));
check("anonymous POST on A's swept session (OAuth off) → 401 -32001",
  ownershipDenied(await mcp("POST", { base: BASE_OPEN, headers: sid(SID_A), body: TOOLS_LIST })));
check("A reuses its swept session → 200 tools/list (credentials re-seeded from its bearer)",
  listedTools(await mcp("POST", { headers: { ...sid(SID_A), ...bearer(BEARER_A) }, body: TOOLS_LIST })));

// ─── 5. Platform sign-in (x-adas-token) ─────────────────────────────────────
// ateam-proxy-mcp's way in. It has no bearer for its tenant-less handshake, so
// it presents the platform secret. Checked: it opens a session on both mounts;
// a wrong token, or any token while CORE_MCP_SECRET is unset, is a 401 and does
// not fall through to the bearer gate; platform and bearer sessions cannot use
// each other's, in either direction, on every verb; and it is NOT a master key:
// each platform session gets exactly the tenant its own ateam_auth put in, no
// override is stored for the shared principal, and a fresh session has none.
const platform = (tok = PLATFORM_SECRET) => ({ "x-adas-token": tok });
// The platform gate answered: 401, named, no session handed out.
const platformRefused = (r) => r.status === 401 && /platform sign-in/.test(r.text) && !r.sid;

console.log("integration (OAuth on): platform sign-in opens an owned session");
for (const path of ["/", "/mcp"]) {
  const r = await mcp("POST", { path, headers: platform(), body: INIT });
  check(`${path} platform initialize → 200 + session id`, r.status === 200 && !!r.sid);
  check(`${path} the session is bound to the platform principal`, getSessionOwner(r.sid) === PLATFORM_PRINCIPAL);
  check(`${path} wrong x-adas-token → 401, no session minted`,
    platformRefused(await mcp("POST", { path, headers: platform("not-the-secret"), body: INIT })));
}
const SID_P = (await mcp("POST", { headers: platform(), body: INIT })).sid;
check("the platform reuses its own session → 200 tools/list",
  listedTools(await mcp("POST", { headers: { ...sid(SID_P), ...platform() }, body: TOOLS_LIST })));
check("wrong x-adas-token WITH a valid bearer → still 401: a failed credential does not fall through",
  platformRefused(await mcp("POST", { headers: { ...platform("not-the-secret"), ...bearer(BEARER_A) }, body: INIT })));
{
  const both = await mcp("POST", { headers: { ...platform(), ...bearer(BEARER_A) }, body: INIT });
  check("platform secret AND a bearer → the platform's session; the bearer is never bound",
    both.status === 200 && getSessionOwner(both.sid) === PLATFORM_PRINCIPAL);
}
delete process.env.CORE_MCP_SECRET;
try {
  check("CORE_MCP_SECRET unset: the right token opens nothing → 401",
    platformRefused(await mcp("POST", { headers: platform(PLATFORM_SECRET), body: INIT })));
  check("CORE_MCP_SECRET unset: the platform's own session is refused too",
    platformRefused(await mcp("POST", { headers: { ...sid(SID_P), ...platform(PLATFORM_SECRET) }, body: TOOLS_LIST })));
} finally { process.env.CORE_MCP_SECRET = PLATFORM_SECRET; }

console.log("integration: platform and bearer sessions are closed to each other");
for (const method of ["POST", "GET", "DELETE"]) {
  const body = method === "POST" ? TOOLS_LIST : undefined;
  check(`${method} bearer A on the platform session → 401 -32001`,
    ownershipDenied(await mcp(method, { headers: { ...sid(SID_P), ...bearer(BEARER_A) }, body })));
  check(`${method} platform secret on A's bearer session → 401 -32001`,
    ownershipDenied(await mcp(method, { headers: { ...sid(SID_A), ...platform() }, body })));
  check(`${method} anonymous on the platform session (OAuth off) → 401 -32001`,
    ownershipDenied(await mcp(method, { base: BASE_OPEN, headers: sid(SID_P), body })));
}
check("anonymous POST on the platform session (OAuth on) → 401 challenge",
  challenged(await mcp("POST", { headers: sid(SID_P), body: TOOLS_LIST })));
check("the platform session is still the platform's", getSessionOwner(SID_P) === PLATFORM_PRINCIPAL);
check("A's session is still A's", getSessionOwner(SID_A) === BEARER_A);
check("the platform still reuses its session → 200 tools/list",
  listedTools(await mcp("POST", { headers: { ...sid(SID_P), ...platform() }, body: TOOLS_LIST })));

// The fake validator (top of file) records which key each upstream call
// carries. The keys spell out their tenant, so ateam_auth never calls whoami.
console.log("integration: each platform session carries only the tenant its own ateam_auth put in");
const KEY_A = "adas_tenanta_33333333333333333333333333333333";
const KEY_B = "adas_tenantb_44444444444444444444444444444444";
let rpcId = 100;
const call = (s, name, args = {}) => mcp("POST", {
  headers: { ...sid(s), ...platform() },
  body: { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
});
const resultOf = (r) => { try { return JSON.parse(r.text).result || null; } catch { return null; } };
const succeeded = (r) => { const x = resultOf(r); return r.status === 200 && !!x && x.isError !== true; };
// The exact signal ateam-proxy-mcp re-authenticates on (upstreamAuthFailure.js),
// given by the dispatcher's auth gate BEFORE any upstream call. `seen` staying
// empty is what tells that apart from an upstream 401 relayed with the same code.
const unauthenticated = (r) => {
  const x = resultOf(r);
  return r.status === 200 && x?.isError === true && x?.structuredContent?.code === "UNAUTHENTICATED";
};
async function refusedAtTheGate(s) {
  seen.length = 0;
  const r = await call(s, "ateam_list_solutions");
  return unauthenticated(r) && seen.length === 0;
}
async function listAs(s) {
  seen.length = 0;
  const r = await call(s, "ateam_list_solutions");
  return { ok: succeeded(r), calls: [...seen] };
}
const onlyKey = (calls, key, tenant) =>
  calls.length > 0 && calls.every((c) => c.key === key && c.tenant === tenant && !c.platform);

const P1 = (await mcp("POST", { headers: platform(), body: INIT })).sid;
const P2 = (await mcp("POST", { headers: platform(), body: INIT })).sid;
check("before ateam_auth, a tenant tool on a platform session is refused at the gate (not a master key)",
  await refusedAtTheGate(P1));
check("P1 ateam_auth as tenant A → ok", succeeded(await call(P1, "ateam_auth", { api_key: KEY_A })));
check("P2 ateam_auth as tenant B → ok", succeeded(await call(P2, "ateam_auth", { api_key: KEY_B })));
{
  const a = await listAs(P1);
  check("P1 lists with tenant A's key, after B signed in on P2", a.ok && onlyKey(a.calls, KEY_A, "tenanta"));
  const b = await listAs(P2);
  check("P2 lists with tenant B's key", b.ok && onlyKey(b.calls, KEY_B, "tenantb"));
}
check("no override was stored for the platform principal", getAuthOverride(PLATFORM_PRINCIPAL) === null);
{
  const P3 = (await mcp("POST", { headers: platform(), body: INIT })).sid;
  check("a NEW platform session inherits no tenant: refused at the gate", await refusedAtTheGate(P3));
}

// After an idle hour the sweep drops P1's credentials. P1 stays the platform's,
// and nothing re-seeds it (no bearer, no override), so a tenant tool answers the
// structured UNAUTHENTICATED that ateam-proxy-mcp re-runs ateam_auth on.
console.log("idle sweep: a platform session keeps its owner and loses its tenant");
{
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 60 * 1000;
  try { sweepStaleSessions(); } finally { Date.now = realNow; }
}
check("P1 is still bound to the platform principal", getSessionOwner(P1) === PLATFORM_PRINCIPAL);
check("P1's tenant tool after the sweep → UNAUTHENTICATED, at the gate", await refusedAtTheGate(P1));
check("P1 ateam_auth again → ok", succeeded(await call(P1, "ateam_auth", { api_key: KEY_A })));
{
  const a = await listAs(P1);
  check("P1 lists as tenant A again", a.ok && onlyKey(a.calls, KEY_A, "tenanta"));
}

// ─── 6. Layer 1's one exception: token auto-injection ───────────────────────
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
{
  // Injection runs only when there is no platform token: a platform call from an
  // IP that just finished OAuth must never become that user's session.
  const p = await mcp("POST", { headers: { ...platform(), ...ipHeaders(IP_A) }, body: INIT });
  check(`platform initialize from A's ip, within TTL → the platform's session, not A's`,
    p.status === 200 && getSessionOwner(p.sid) === PLATFORM_PRINCIPAL);
}
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
