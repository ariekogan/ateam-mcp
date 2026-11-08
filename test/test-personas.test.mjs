// Test personas — simulated people, marked TEST, that a test runs as (Builder
// routes/testPersonas.js, Core utils/testPersonas.js). The agent creates them,
// tests as each with as_persona, and deletes them after.
// Behavioural: the real dispatcher against a local server playing the Builder.
// Run: node --test test/test-personas.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials, getSessionContext } from "../src/api.js";
import { handleToolCall, tools, TOOL_SAFETY, AGENT_EXPOSURE } from "../src/tools.js";

const SID = "sess-test-personas";
const PERSONA_TOOLS = ["ateam_create_test_persona", "ateam_list_test_personas", "ateam_update_test_persona", "ateam_delete_test_persona"];
let seen = [];
let replies = {};
let server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      const r = replies[`${req.method} ${req.url.split("?")[0]}`] || { status: 404, body: { ok: false, error: "unstubbed" } };
      res.writeHead(r.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    explicit: true,
  });
});
after(() => server.close());

const call = async (name, args) => {
  seen = [];
  const res = await handleToolCall(name, args, SID);
  return { res, out: JSON.parse(res.content[0].text) };
};
const BASE = "/deploy/solutions/sol1/test-personas";

test("the four tools are advertised, classed, and visible to every agent", () => {
  for (const name of PERSONA_TOOLS) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} is registered`);
    assert.notEqual(t.core, false, `${name} is a core tool`);
    assert.ok(AGENT_EXPOSURE.all.includes(name), `${name} is visible to every agent`);
  }
  assert.ok(TOOL_SAFETY.read.includes("ateam_list_test_personas"));
  assert.ok(TOOL_SAFETY.additive.includes("ateam_create_test_persona"));
  assert.ok(TOOL_SAFETY.destructive.includes("ateam_update_test_persona"));
  assert.ok(TOOL_SAFETY.destructive.includes("ateam_delete_test_persona"));
  assert.match(tools.find((x) => x.name === "ateam_create_test_persona").description, /DELETE them when the tests are done/);
});

test("create, list, update and delete each make one call to the Builder's test-personas door", async () => {
  replies = {
    [`POST ${BASE}`]: { status: 201, body: { ok: true, persona: { personaId: "persona-7", name: "Dana", roles: ["supervisor"] } } },
    [`GET ${BASE}`]: { body: { ok: true, personas: [], settings: { enabled: true, source: "default", env: "dev" } } },
    [`PATCH ${BASE}/persona-7`]: { body: { ok: true, persona: { personaId: "persona-7", roles: [] } } },
    [`DELETE ${BASE}/persona-7`]: { body: { ok: true, deleted: true, personaId: "persona-7" } },
  };
  const made = await call("ateam_create_test_persona", { solution_id: "sol1", name: "Dana", roles: ["supervisor"] });
  assert.equal(made.out.persona.personaId, "persona-7");
  assert.deepEqual(seen.map((r) => [r.method, r.url, r.body]), [["POST", BASE, { name: "Dana", roles: ["supervisor"] }]]);

  const listed = await call("ateam_list_test_personas", { solution_id: "sol1" });
  assert.equal(listed.out.settings.enabled, true);
  assert.deepEqual(seen.map((r) => [r.method, r.url.split("?")[0]]), [["GET", BASE]]);

  await call("ateam_update_test_persona", { solution_id: "sol1", persona_id: "persona-7", roles: [] });
  assert.deepEqual(seen.map((r) => [r.method, r.url, r.body]), [["PATCH", `${BASE}/persona-7`, { roles: [] }]]);

  const gone = await call("ateam_delete_test_persona", { solution_id: "sol1", persona_id: "persona-7" });
  assert.equal(gone.out.deleted, true);
  assert.deepEqual(seen.map((r) => [r.method, r.url]), [["DELETE", `${BASE}/persona-7`]]);
});

test("missing arguments send nothing", async () => {
  for (const [name, args] of [
    ["ateam_create_test_persona", { solution_id: "sol1" }],
    ["ateam_update_test_persona", { solution_id: "sol1", persona_id: "persona-7" }],
    ["ateam_delete_test_persona", { solution_id: "sol1" }],
  ]) {
    const { out } = await call(name, args);
    assert.equal(out.ok, false, name);
    assert.equal(seen.length, 0, name);
  }
});

test("a refusal reaches the caller with its code and Core's words", async () => {
  replies = { [`POST ${BASE}`]: { status: 409, body: { ok: false, code: "TEST_PERSONAS_OFF", error: "Test personas are switched off for this workspace." } } };
  const { res, out } = await call("ateam_create_test_persona", { solution_id: "sol1", name: "X" });
  assert.equal(res.isError, true);
  assert.equal(out.code, "TEST_PERSONAS_OFF");
  assert.match(out.error, /switched off/);
  assert.equal(out.http_status, 409);
});

test("as_persona travels with a conversation and a skill test, and only when given", async () => {
  for (const name of ["ateam_conversation", "ateam_test_skill"]) {
    assert.ok(tools.find((x) => x.name === name).inputSchema.properties.as_persona, `${name} takes as_persona`);
  }
  replies = { "POST /deploy/solutions/sol1/test": { body: { ok: true, job_id: "job_1", chain_id: "job_1", actor_id: "person_admin", ran_as: "person_admin" } } };
  await call("ateam_conversation", { solution_id: "sol1", message: "hi", as_persona: "Dana" });
  assert.equal(seen[0].body.as_persona, "Dana");
  await call("ateam_conversation", { solution_id: "sol1", message: "hi" });
  assert.equal("as_persona" in seen[0].body, false);
});

test("deleting the persona a session last tested as unbinds it, so Core is never named a gone actor", async () => {
  replies = {
    "POST /deploy/solutions/sol1/test": { body: { ok: true, job_id: "job_2", chain_id: "job_2", actor_id: "persona-9", ran_as: "persona-9", as_persona: { personaId: "persona-9" } } },
    [`DELETE ${BASE}/persona-9`]: { body: { ok: true, deleted: true, personaId: "persona-9" } },
    [`DELETE ${BASE}/persona-8`]: { body: { ok: true, deleted: true, personaId: "persona-8" } },
  };
  await call("ateam_conversation", { solution_id: "sol1", message: "hi", as_persona: "persona-9" });
  assert.equal(getSessionContext(SID).actorId, "persona-9");
  await call("ateam_delete_test_persona", { solution_id: "sol1", persona_id: "persona-8" });
  assert.equal(getSessionContext(SID).actorId, "persona-9", "another persona's delete leaves it");
  await call("ateam_delete_test_persona", { solution_id: "sol1", persona_id: "persona-9" });
  assert.equal(getSessionContext(SID).actorId, undefined);
});
