// WHO ateam_test_abort ACTS AS, and what its actor_id does.
//
// actor_id came in with 852b373 as a copy of the read tools' text — "WHO is
// asking … Pass it to inspect a job run by a DIFFERENT actor (e.g. a real
// user's)" — and the handler never read it. The abort is no read: the
// Builder's DELETE …/test/:jobId sends Core the API key's person
// (testIdentity(req).ranAs, Builder routes/solutions.js:3056-3059, 986b2b8d),
// whatever the caller names, and Core's POST /api/job/:id/abort
// (ai-dev-assistant server.js:3006) refuses an actor that may not access the
// job, which the Builder answers as 403 JOB_ACCESS_DENIED. What actor_id
// does is the dispatcher's: it becomes the session's actor, which the
// chain_id form's chain read carries.
//
// Run: node --test test/test-abort-acts-as-key.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

// Core cuts a tool description here for an agent run (ai-dev-assistant
// anthropicAgentBackend.js:618, openaiAgentBackend.js:242,
// sys.callAiWithTools.js:157); the in-app builder makes every ateam_* call
// inside one.
const CORE_DESCRIPTION_CUT = 1200;
const abort = () => tools.find((t) => t.name === "ateam_test_abort");

test("the description says who the abort acts as and what Core refuses — inside what Core passes on", () => {
  const d = abort().description;
  assert.ok(d.length <= CORE_DESCRIPTION_CUT, `${d.length} characters; an in-app agent sees ${CORE_DESCRIPTION_CUT}`);
  assert.ok(d.includes("The abort acts as your API key's person, as the test's start did (its ran_as), whatever actor_id says"), d);
  assert.ok(d.includes("refuses any other with 403 JOB_ACCESS_DENIED"), d);
  assert.ok(d.includes("A key no person minted acts as the platform's service identity, which may stop only anonymous runs."), d);
});

test("actor_id no longer offers to act as a DIFFERENT actor, and says it is not who aborts", () => {
  const p = abort().inputSchema.properties.actor_id.description;
  assert.doesNotMatch(p, /Pass it to inspect a job run by a DIFFERENT actor/);
  assert.doesNotMatch(p, /WHO is asking/);
  assert.ok(p.startsWith("Optional, and NOT who aborts: the abort acts as your API key's person"), p);
  assert.ok(p.includes("in a new session, pass the ran_as of the reply that started the run"), p);
});

// What the text says actor_id does, checked against what the handler sends: a
// stand-in Builder records the actor header on the chain read and on each abort.
const SID = "sess-abort-acts-as-key";
let server;
const seen = [];
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url.split("?")[0], actor: req.headers["x-adas-actor-id"] || null });
      const body = req.method === "GET"
        ? { ok: true, chain: { chainJobs: [{ jobId: "job_root", skill: "intake", relation: "root" }] } }
        : { ok: true, job_id: "job_root", status: "aborted" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_" + "0".repeat(32), apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

test("what actor_id is said to do is what happens: the chain is read as that actor before its jobs are aborted", async () => {
  const p = abort().inputSchema.properties.actor_id.description;
  assert.ok(p.includes("the chain_id form reads the chain's jobs as that actor before aborting them"), p);
  const r = await handleToolCall("ateam_test_abort", { solution_id: "sol", chain_id: "job_root", actor_id: "usr_reader" }, SID);
  assert.ok(!r.isError, r.content[0].text.slice(0, 300));
  const read = seen.find((s) => s.method === "GET");
  assert.equal(read?.path, "/deploy/jobs/job_root/chain");
  assert.equal(read?.actor, "usr_reader", "the chain read did not carry the actor_id");
  assert.equal(seen.find((s) => s.method === "DELETE")?.path, "/deploy/solutions/sol/skills/intake/test/job_root");
});
