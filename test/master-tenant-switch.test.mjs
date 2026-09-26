// A TENANT CHANGE BY ONE CALL NEVER REACHES ANOTHER CALL ALREADY IN FLIGHT,
// on the stdio transport.
//
// session-isolation.test.mjs 5d holds a call in flight while another tenant
// signs in, over HTTP. This file is its stdio twin, for the tenant changes that
// file does not reach:
//   - a master-key session's per-call `tenant` override (the dispatcher's
//     switchTenant), and the bulk sweeps that visit every tenant
//     (ateam_status_all, ateam_sync_all). switchTenant EDITED the record
//     (`session.tenant = newTenant`, 94b9bc0) that every call in flight on the
//     session holds (runToolCall), so one call's `tenant` moved the rest of the
//     others' requests: a deploy's polls, a GitHub write.
//   - an api-key session signing in to another tenant: the new record SHARED
//     the old one's context object (4dc8f17), and touchSession edits it in
//     place, so an actor bound after the switch rode on the old tenant's call.
//
// Why stdio: it is what Claude Code, Cursor and the other desktop clients run,
// and they issue tool calls in parallel on it. There is ONE session ("stdio")
// and nothing rebuilds its record per request the way seedCredentials does on
// HTTP, so the record a call holds is the one the next call changes.
//
// The real entry point: `node src/index.js` as a child process, driven by the
// SDK's own stdio client. Its only upstream is a fake Core on 127.0.0.1 that
// records the tenant, key and actor every request carries, and can HOLD a
// request so a call stays in flight while another runs. The child gets
// ADAS_API_URL and nothing else of ours: no key, no tenant from this shell.
//
// Run: node --test test/master-tenant-switch.test.mjs   (npm test runs it too)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TENANTS = ["tenanta", "tenantb", "tenantc"];
const MASTER = "made-up-master-key"; // not a real value; the fake accepts anything
const KEY_A = "adas_tenanta_55555555555555555555555555555555";
const KEY_B = "adas_tenantb_66666666666666666666666666666666";

// ─── The fake Core ───────────────────────────────────────────────────────────
const seen = [];
const holds = []; // { match(req), promise }
function hold(match) {
  let release;
  const h = { match, promise: new Promise((r) => { release = r; }) };
  holds.push(h);
  return () => { holds.splice(holds.indexOf(h), 1); release(); };
}
const upstream = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  const c = {
    method: req.method,
    path,
    tenant: req.headers["x-adas-tenant"] || null,
    key: req.headers["x-api-key"] || null,
    master: "x-adas-token" in req.headers,
    actor: req.headers["x-adas-actor-id"] || null,
  };
  seen.push(c);
  const held = holds.find((h) => h.match(c));
  if (held) await held.promise;
  let body = { ok: true };
  if (path === "/deploy/tenants") body = { tenants: TENANTS.map((id) => ({ id })) };
  // Each tenant owns one solution, named after it, so a sweep's push and pull
  // say which tenant they were for.
  else if (path === "/deploy/solutions") body = { ok: true, solutions: c.tenant ? [{ id: `sol-of-${c.tenant}` }] : [] };
  else if (path.endsWith("/redeploy")) body = { ok: true, async: true, job_id: "job-r" };
  else if (path === "/deploy/jobs/job-r") body = { ok: true, status: "done", deploy_status: "deployed" };
  else if (path.endsWith("/skills/skill-mints/test")) body = { ok: true, job_id: "job-of-a", actor_id: "actor-minted-for-a" };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

// ─── The real stdio server ───────────────────────────────────────────────────
// One child per section: each section starts from a session nobody has signed
// in to. (A session that ever held a master key keeps it across a later api-key
// sign-in, and one tenant's bound actor carries into the next sign-in; both are
// setSessionCredentials merging, and neither is what this file tests.)
let client;
async function freshServer() {
  await client?.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: { ADAS_API_URL: `http://127.0.0.1:${upstream.address().port}` },
    stderr: "ignore",
  });
  client = new Client({ name: "master-tenant-switch-test", version: "1" });
  // The server's own console.log lines share stdout with the protocol; the
  // client drops each as a parse error and reads on. Not what this file tests.
  client.onerror = () => {};
  await client.connect(transport);
}
before(() => new Promise((r) => upstream.listen(0, "127.0.0.1", r)));
after(async () => {
  await client?.close();
  upstream.close();
});

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  let out = null;
  try { out = JSON.parse(r.content?.[0]?.text || "null"); } catch { /* not JSON */ }
  return { isError: r.isError === true, out };
}
const until = async (cond, what) => {
  for (let i = 0; i < 500; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};
const tenantsOf = (calls) => [...new Set(calls.map((c) => c.tenant))];
const actorsOf = (calls) => [...new Set(calls.map((c) => c.actor))];
async function listAs(args = {}) {
  seen.length = 0;
  const r = await call("ateam_list_solutions", args);
  return { ...r, calls: seen.filter((c) => c.path === "/deploy/solutions") };
}
async function masterSignIn(tenant) {
  const r = await call("ateam_auth", { master_key: MASTER, tenant });
  assert.equal(r.out?.ok, true, `master sign-in as ${tenant}: ${JSON.stringify(r.out)}`);
}

// ─── 1. An api-key session signing in to another tenant ─────────────────────
test("api key: an actor bound after a sign-in to another tenant never rides on the old tenant's call", async () => {
  await freshServer();
  assert.equal((await call("ateam_auth", { api_key: KEY_A })).out?.ok, true, "(control) signed in as A");
  seen.length = 0;
  const letGo = hold((c) => c.method === "POST" && c.path === "/deploy/solutions/sol-of-a/redeploy");
  const x = call("ateam_redeploy", { solution_id: "sol-of-a" });
  await until(() => seen.some((c) => c.path.endsWith("/redeploy")), "X's kickoff");
  assert.equal((await call("ateam_auth", { api_key: KEY_B })).out?.ok, true, "(control) signed in as B while X was held");
  const z = await listAs({ actor_id: "actor-of-b" });
  letGo();
  await x;

  const polls = seen.filter((c) => c.path === "/deploy/jobs/job-r");
  assert.deepEqual([z.calls.length, z.calls[0]?.key, z.calls[0]?.actor], [1, KEY_B, "actor-of-b"], "(control) B's call carried B's key and actor");
  assert.ok(polls.length >= 1, "(control) X polled after B's actor was bound");
  assert.ok(polls.every((c) => c.key === KEY_A && c.tenant === "tenanta"), "(control) X's polls carried A's key and tenant (6580e66)");
  assert.deepEqual(actorsOf(polls), [null], "X's polls carry no actor of B's");
});

test("api key: an actor minted by the old tenant's call never reaches the new tenant", async () => {
  assert.equal((await call("ateam_auth", { api_key: KEY_A })).out?.ok, true, "(control) signed in as A");
  seen.length = 0;
  const letGo = hold((c) => c.path === "/deploy/solutions/sol-of-a/skills/skill-mints/test");
  const x = call("ateam_test_skill", { solution_id: "sol-of-a", skill_id: "skill-mints", message: "hi", wait: false });
  await until(() => seen.some((c) => c.path.endsWith("/skill-mints/test")), "X's test kickoff");
  assert.equal((await call("ateam_auth", { api_key: KEY_B })).out?.ok, true, "(control) signed in as B while X was held");
  letGo();
  const xr = await x;
  assert.equal(xr.out?.actor_id, "actor-minted-for-a", "(control) X's call minted A's actor");
  const b = await listAs();
  assert.ok(b.calls.length === 1 && b.calls[0].key === KEY_B, "(control) B's next call carried B's key");
  assert.notEqual(b.calls[0].actor, "actor-minted-for-a", "B's next call carries no actor A's call minted");
});

// ─── 2. The dispatcher's per-call `tenant` override ─────────────────────────
test("master mode: another call's `tenant` arg never reaches a deploy already in flight", async () => {
  await freshServer();
  await masterSignIn("tenanta");
  seen.length = 0;
  // X acts on the session's tenant, A: a redeploy, held at its kickoff, then polled.
  const letGo = hold((c) => c.method === "POST" && c.path === "/deploy/solutions/sol-of-a/redeploy");
  const x = call("ateam_redeploy", { solution_id: "sol-of-a" });
  await until(() => seen.some((c) => c.path.endsWith("/redeploy")), "X's kickoff");
  // Y, in parallel on the same session, names tenant B and an actor of B's.
  const y = await call("ateam_list_solutions", { tenant: "tenantb", actor_id: "actor-of-b" });
  letGo();
  const xr = await x;

  const yCalls = seen.filter((c) => c.path === "/deploy/solutions");
  const kick = seen.filter((c) => c.path.endsWith("/redeploy"));
  const polls = seen.filter((c) => c.path === "/deploy/jobs/job-r");
  assert.ok(!y.isError && yCalls.length === 1, "(control) Y ran");
  assert.deepEqual([yCalls[0].tenant, yCalls[0].master, yCalls[0].actor], ["tenantb", true, "actor-of-b"],
    "(control) Y went out as tenant B, with B's actor");
  assert.deepEqual(tenantsOf(kick), ["tenanta"], "(control) X's kickoff went out as tenant A");
  assert.ok(polls.length >= 1, "(control) X polled its job after Y had switched");
  assert.deepEqual(tenantsOf(polls), ["tenanta"], "X's polls went out as tenant A, not the tenant Y named");
  assert.deepEqual(actorsOf(polls), [null], "X's polls carry no actor of B's");
  assert.equal(xr.out?._where?.tenant, "tenanta", "X's result says it landed on tenant A");

  // Unchanged since 94b9bc0: the switch stays for the session's LATER calls.
  const next = await listAs();
  assert.deepEqual(tenantsOf(next.calls), ["tenantb"], "(as before) a later call with no `tenant` acts as B");
});

// ─── 3. The bulk sweeps change only their own call ──────────────────────────
test("master mode: ateam_sync_all never moves a parallel write, nor leaves the session on the last tenant", async () => {
  await masterSignIn("tenanta");
  seen.length = 0;
  // Hold the sweep once it has reached tenant C.
  const letGo = hold((c) => c.path === "/deploy/solutions" && c.tenant === "tenantc");
  const sweep = call("ateam_sync_all", {});
  await until(() => seen.some((c) => c.path === "/deploy/solutions" && c.tenant === "tenantc"), "the sweep reaching tenant C");
  // A write meant for the session's own tenant, with no `tenant` arg.
  const w = await call("ateam_github_patch", { solution_id: "sol-of-a", path: "skills/x/skill.json", content: "{}" });
  letGo();
  const s = await sweep;

  const write = seen.filter((c) => c.path === "/deploy/solutions/sol-of-a/github/patch");
  assert.ok(!w.isError && write.length === 1, "(control) the write ran");
  assert.deepEqual(tenantsOf(write), ["tenanta"], "the write went out as the session's tenant A, not the tenant the sweep had reached");
  assert.match(s.out?.summary || "", /Synced 3 tenant\(s\), 3 solution\(s\)/, "(control) the sweep covered every tenant");
  for (const t of TENANTS) {
    const own = seen.filter((c) => c.path.startsWith(`/deploy/solutions/sol-of-${t}/github/`));
    assert.equal(own.length, 2, `(control) ${t}'s push and pull ran`);
    assert.deepEqual(tenantsOf(own), [t], `${t}'s push and pull went out as ${t}`);
  }
  const after = await listAs();
  assert.deepEqual(tenantsOf(after.calls), ["tenanta"], "the session is still on tenant A after the sweep");
});

test("master mode: ateam_status_all sends no tenant's actor to another tenant", async () => {
  await masterSignIn("tenanta");
  const bound = await listAs({ actor_id: "actor-of-a" });
  assert.deepEqual(actorsOf(bound.calls), ["actor-of-a"], "(control) the session is bound to A's actor");
  seen.length = 0;
  const r = await call("ateam_status_all", {});
  assert.equal(r.out?.tenants, 3, "(control) the sweep covered every tenant");
  const onA = seen.filter((c) => c.tenant === "tenanta");
  const elsewhere = seen.filter((c) => c.tenant === "tenantb" || c.tenant === "tenantc");
  assert.ok(onA.length > 0 && onA.every((c) => c.actor === "actor-of-a"), "(control) A's requests carry A's actor");
  assert.ok(elsewhere.length > 0, "(control) the sweep sent requests to B and C");
  assert.deepEqual(actorsOf(elsewhere), [null], "B's and C's requests carry no actor of A's");
  const after = await listAs();
  assert.deepEqual([tenantsOf(after.calls), actorsOf(after.calls)], [["tenanta"], ["actor-of-a"]],
    "the session keeps its tenant and its actor after the sweep");
});
