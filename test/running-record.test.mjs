/**
 * WHAT IS RUNNING? — git plan A3, as this client carries it.
 *
 * The Builder records every deploy (repository, requested ref, resolved commit, who,
 * result) in Core, answers it as `running_record` on the deploy, and puts `running` on
 * the solution's status and health. This client relays both as it was told and never
 * makes one up: a deploy whose Builder sent no record shows none.
 *
 * Run: node --test test/running-record.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers, tools as TOOLS } from "../src/tools.js";

const SHA = "c1".repeat(20);
const SOLUTION = { id: "walkmate", name: "WalkMate", skills: [{ id: "walk-guide" }] };
const pulled = {
  ok: true, solution: SOLUTION, skills: [{ id: "walk-guide", name: "Walking Guide" }],
  mcp_store: { "walk-trail": [{ path: "server.js", content: "// at the commit" }] },
  skills_found: 1, connectors_found: 1, files_loaded: 1,
};

async function withBuilder(answer, fn) {
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    const reqBody = opts.body ? JSON.parse(opts.body) : undefined;
    let status = 200;
    let body = { ok: true };
    if (u.includes("/github/status")) body = { ok: true, repo_url: "https://github.com/x/y" };
    else if (u.includes("/github/pull-bundle")) body = pulled;
    else if (u.includes("/validate/solution")) body = { ok: true, errors: [], warnings: [] };
    else if (u.endsWith("/deploy/solution") && method === "POST") body = answer.deploy(reqBody);
    else if (/\/deploy\/status\//.test(u)) body = answer.status;
    else if (/\/deploy\/solutions\/[^/]+\/health$/.test(u)) body = answer.health;
    else if (u.includes("/upload")) body = { ok: true, tools: 3 };
    return { ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try { return await fn(); } finally { global.fetch = orig; }
}

const deploy = (extra = {}) => () => ({ ok: true, import: { skills: [], connectors: 1 }, ...extra });

test("the deploy's answer carries the Builder's running_record, as it said it", async () => {
  const record = { recorded: true, result: "deployed", commit: SHA, at: "2026-10-11T10:00:00.000Z", deployed_by: "alice" };
  const result = await withBuilder({ deploy: deploy({ running_record: record }) }, () => handlers.ateam_build_and_run({ solution_id: "walkmate" }, "sid"));
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.deepEqual(result.running_record, record);
});

test("a deploy that could not be recorded says so; the deploy is still a deploy", async () => {
  const record = { recorded: false, reason: "this key belongs to no person, and Core records and reads the deploy record only for a person" };
  const result = await withBuilder({ deploy: deploy({ running_record: record }) }, () => handlers.ateam_build_and_run({ solution_id: "walkmate" }, "sid"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.running_record, record);
});

test("a Builder that sends no record (an older one) shows none: nothing is invented", async () => {
  const result = await withBuilder({ deploy: deploy() }, () => handlers.ateam_build_and_run({ solution_id: "walkmate" }, "sid"));
  assert.equal(result.ok, true);
  assert.equal("running_record" in result, false);
});

test("ateam_get_solution status and health pass the Builder's `running` through untouched", async () => {
  const running = { known: true, commit: SHA, repo: "o/r", result: "deployed", deployed_by: "alice", deployed_at: "2026-10-11T10:00:00.000Z", changed_since_record: false };
  await withBuilder({ status: { ok: true, running }, health: { ok: true, running: { known: false, reason: "No deploy has been recorded" } } }, async () => {
    const status = await handlers.ateam_get_solution({ solution_id: "walkmate", view: "status" }, "sid");
    assert.deepEqual(status.running, running);
    const health = await handlers.ateam_get_solution({ solution_id: "walkmate", view: "health" }, "sid");
    assert.deepEqual(health.running, { known: false, reason: "No deploy has been recorded" });
  });
});

test("the tool texts tell an agent where to look", () => {
  const get = TOOLS.find((t) => t.name === "ateam_get_solution");
  assert.match(get.description, /status and health also answer `running`/);
  assert.match(get.description, /known:false/);
  const run = TOOLS.find((t) => t.name === "ateam_build_and_run");
  assert.match(run.description, /running_record/);
});
