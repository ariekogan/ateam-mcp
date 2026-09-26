// The OAuth edges of the HTTP transport (ateam-mcp #12, Codex 0efbd57db5,
// bdce981cd4, 371d532bd7).
//
// Since 39ff024 BOTH mounts answer an anonymous request with a 401 whose
// WWW-Authenticate header is the client's only pointer to OAuth discovery.
// Three things kept that pointer from working, or kept a bearer from working:
//
//   1. WWW-Authenticate was not CORS-exposed, so a browser client got the 401
//      and could not read the challenge.
//   2. There was ONE bearer gate, and it named the ROOT protected-resource
//      metadata on both mounts. A client that called /mcp was sent to a
//      document whose `resource` is the root, which RFC 9728 §3.3 has it check
//      against the URL it called. The /mcp document existed all along
//      (77afcc5); no challenge pointed at it.
//   3. A legacy bearer (adas_<32hex>) names no tenant and no environment.
//      seedCredentials asked whoami at the key's environment — which it does
//      not have — so whoami threw "no base url", and the fallback then recorded
//      tenant:null for a key that is not sealed, which setSessionCredentials
//      refuses by throwing. That throw escaped into the request handler: every
//      request with such a bearer was a 500.
//
// Boot mirrors session-isolation.test.mjs: a fake validator on 127.0.0.1 is the
// process default (ADAS_API_URL), and the server is its own OAuth issuer, so no
// check can reach a real host.
//
// Plain script with a checklist, like session-isolation.test.mjs: the HTTP
// server it boots keeps the process alive, so it ends with process.exit.
//
// Run: node test/oauth-edges.test.mjs   (npm test runs it too)

import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

// ─── The fake validator ──────────────────────────────────────────────────────
const LEGACY_KNOWN = `adas_${"a1".repeat(16)}`;    // whoami knows this one
const LEGACY_UNKNOWN = `adas_${"b2".repeat(16)}`;  // whoami refuses this one
const seen = [];
const fake = http.createServer((req, res) => {
  const key = req.headers["x-api-key"] || null;
  seen.push({ path: req.url, key, tenant: req.headers["x-adas-tenant"] || null });
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/auth/whoami")) {
    if (key === LEGACY_KNOWN) { res.end(JSON.stringify({ ok: true, tenant: "legacyco" })); return; }
    res.writeHead(401); res.end(JSON.stringify({ ok: false, error: "Invalid or unconfigured API key" })); return;
  }
  res.end(JSON.stringify({ ok: true, solutions: [] }));
});
fake.unref();

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

await new Promise((r) => fake.listen(0, "127.0.0.1", r));
// src/api.js reads ADAS_API_URL once, at import — so this runs first.
process.env.ADAS_API_URL = `http://127.0.0.1:${fake.address().port}`;
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
process.env.ATEAM_BASE_URL = BASE; // OAuth issuer = self
delete process.env.ATEAM_OAUTH_DISABLED;
const { startHttpServer } = await import("../src/http.js");
startHttpServer(PORT);
await new Promise((r) => setTimeout(r, 400));

// Each check is an async function whose assertions throw; a throw is a failure
// with its message, and the next check still runs.
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n      ${String(e.message).split("\n")[0]}`); }
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
let rpcId = 10;

async function post(path, { headers = {}, body }) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const bearer = (b) => ({ authorization: `Bearer ${b}` });
const toolCall = (s, b, name, args = {}) => post("/mcp", {
  headers: { ...bearer(b), "mcp-session-id": s },
  body: { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
});
const resultOf = (r) => { try { return JSON.parse(r.text).result || null; } catch { return null; } };

// ─── 1 + 2: the challenge on each mount ──────────────────────────────────────
for (const [mount, prmPath] of [["/", "/.well-known/oauth-protected-resource"], ["/mcp", "/.well-known/oauth-protected-resource/mcp"]]) {
  await test(`"${mount}": the anonymous 401 names THIS mount's resource metadata`, async () => {
    const r = await post(mount, { headers: { origin: "https://chat.example" }, body: INIT });
    assert.equal(r.status, 401);
    const www = r.headers.get("www-authenticate") || "";
    const named = /resource_metadata="([^"]+)"/.exec(www)?.[1];
    assert.equal(named, `${BASE}${prmPath}`, `the ${mount} challenge points at ${named}`);

    // Follow it, as a client does, and check the correspondence it checks.
    const prm = await (await fetch(named)).json();
    assert.equal(prm.resource, new URL(mount, BASE).href,
      `a client that called ${mount} was sent to metadata for ${prm.resource}`);
  });

  await test(`"${mount}": a browser client can READ the challenge (CORS)`, async () => {
    const r = await post(mount, { headers: { origin: "https://chat.example" }, body: INIT });
    assert.equal(r.status, 401);
    const exposed = (r.headers.get("access-control-expose-headers") || "").split(",").map((h) => h.trim().toLowerCase());
    assert.ok(exposed.includes("www-authenticate"), `Access-Control-Expose-Headers is [${exposed}]`);
    assert.ok(exposed.includes("mcp-session-id"), "the session id is no longer exposed");
  });
}

// ─── 3: a legacy bearer ──────────────────────────────────────────────────────
await test("a legacy bearer is resolved by whoami at this server's API, once per session", async () => {
  seen.length = 0;
  const init = await post("/mcp", { headers: bearer(LEGACY_KNOWN), body: INIT });
  assert.equal(init.status, 200, `initialize answered ${init.status}: ${init.text.slice(0, 200)}`);
  const s = init.headers.get("mcp-session-id");
  assert.ok(s);

  const r = await toolCall(s, LEGACY_KNOWN, "ateam_list_solutions");
  assert.equal(r.status, 200, `the tool call answered ${r.status}`);
  assert.notEqual(resultOf(r)?.isError, true, `the call was refused: ${JSON.stringify(resultOf(r))?.slice(0, 300)}`);
  const listed = seen.filter((c) => c.path.startsWith("/deploy/solutions"));
  assert.ok(listed.length > 0 && listed.every((c) => c.key === LEGACY_KNOWN && c.tenant === "legacyco"),
    `the call did not go out as the tenant whoami named: ${JSON.stringify(listed)}`);

  await toolCall(s, LEGACY_KNOWN, "ateam_list_solutions");
  const asked = seen.filter((c) => c.path.startsWith("/auth/whoami") && c.key === LEGACY_KNOWN).length;
  assert.equal(asked, 1, `whoami was asked ${asked} times for one session`);
});

await test("a legacy bearer whoami cannot place is signed OUT, not a 500 — and gets no guessed tenant", async () => {
  seen.length = 0;
  const init = await post("/mcp", { headers: bearer(LEGACY_UNKNOWN), body: INIT });
  assert.equal(init.status, 200, `initialize answered ${init.status}: ${init.text.slice(0, 200)}`);
  const s = init.headers.get("mcp-session-id");

  const r = await toolCall(s, LEGACY_UNKNOWN, "ateam_list_solutions");
  assert.equal(r.status, 200, `the tool call answered ${r.status}: ${r.text.slice(0, 200)}`);
  const x = resultOf(r);
  assert.equal(x?.isError, true, "a session with no tenant ran a tenant tool");
  assert.equal(x?.structuredContent?.code, "UNAUTHENTICATED");
  assert.match(x?.content?.[0]?.text || "", /ateam_auth/, "the refusal does not say how to sign in");
  assert.equal(seen.filter((c) => c.path.startsWith("/deploy/")).length, 0, "a tenant call went out for a key with no tenant");
});

fake.close();
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);
