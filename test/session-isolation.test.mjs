// Multi-client session-isolation tests for the HTTP transport.
//
// Verifies the fix: a Bearer-bound session may only be reused by a request
// presenting the SAME validated Bearer — so a client cannot hijack another
// client's session (and its tenant + api key) by sending the (non-secret,
// logged/echoed) session-id with no/other Authorization.
//
// Run: node test/session-isolation.test.mjs

import assert from "node:assert";
import { bearerOwnershipOk } from "../src/api.js";

const BEARER_A = "adas_tenanta_00000000000000000000000000000000";
const BEARER_B = "adas_tenantb_11111111111111111111111111111111";

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); failures++; }
}

// ─── 1. Unit: bearerOwnershipOk ──────────────────────────────────────────────
console.log("unit: bearerOwnershipOk");
check("no bound bearer + no token → allow (no-bearer ateam_auth flow)", bearerOwnershipOk(null, undefined) === true);
check("no bound bearer + some token → allow", bearerOwnershipOk(null, BEARER_A) === true);
check("bound bearer + NO token → DENY (the attack)", bearerOwnershipOk(BEARER_A, undefined) === false);
check("bound bearer + empty token → DENY", bearerOwnershipOk(BEARER_A, "") === false);
check("bound bearer + DIFFERENT token → DENY", bearerOwnershipOk(BEARER_A, BEARER_B) === false);
check("bound bearer + SAME token → allow (legit reuse)", bearerOwnershipOk(BEARER_A, BEARER_A) === true);

// ─── 2. Integration: boot the HTTP server, run the real flows ────────────────
const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.ATEAM_BASE_URL = BASE;               // OAuth issuer = self (no network)
delete process.env.ATEAM_OAUTH_DISABLED;         // OAuth ENABLED (bearer path active)

const { startHttpServer } = await import("../src/http.js");
startHttpServer(PORT);
await new Promise((r) => setTimeout(r, 400));

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

async function mcp(headers, body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, sid: res.headers.get("mcp-session-id"), text };
}

// A initializes WITH a Bearer → session bound to BEARER_A
console.log("integration: bearer-bound session");
const initA = await mcp({ authorization: `Bearer ${BEARER_A}` }, INIT);
const SID_A = initA.sid;
check("A init returns a session id", !!SID_A);

// ATTACK: B sends A's session-id with NO Authorization → must be DENIED
const attack = await mcp({ "mcp-session-id": SID_A }, TOOLS_LIST);
check("attacker (A's sid, no auth) → 401", attack.status === 401);
check("attacker → -32001 ownership error", attack.text.includes("-32001") || /different credential/.test(attack.text));

// CROSS-BEARER: B sends A's session-id with B's OWN bearer → must be DENIED
const cross = await mcp({ "mcp-session-id": SID_A, authorization: `Bearer ${BEARER_B}` }, TOOLS_LIST);
check("cross-bearer (A's sid, B's bearer) → 401", cross.status === 401);

// LEGIT: A reuses its own session with its own bearer → allowed (not 401)
const legit = await mcp({ "mcp-session-id": SID_A, authorization: `Bearer ${BEARER_A}` }, TOOLS_LIST);
check("legit reuse (A's sid + A's bearer) → not 401", legit.status !== 401);

// REGRESSION: a no-bearer session (ateam_auth flow) is NOT bearer-bound → reuse allowed
console.log("integration: no-bearer session (regression)");
const initC = await mcp({}, INIT);
const SID_C = initC.sid;
check("no-bearer init returns a session id", !!SID_C);
const reuseC = await mcp({ "mcp-session-id": SID_C }, TOOLS_LIST);
check("no-bearer session reuse (no bound bearer) → not 401", reuseC.status !== 401);

// ─── done ────────────────────────────────────────────────────────────────────
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);
