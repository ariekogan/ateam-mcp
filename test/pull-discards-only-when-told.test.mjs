/**
 * ateam_github_pull DROPS A BUILDER CHANGE NO BRANCH HAS ONLY WHEN TOLD TO.
 *
 * A pull replaces the Builder's copy of every file with the repo's. The Builder
 * (#50) used to be told to do that unconditionally, so a routine pull — the
 * tool leads with "restore a previous version or deploy from GitHub as the
 * source of truth" — erased a Builder save that had never reached a branch and
 * answered ok. Now the Builder refuses such a pull (409
 * UNPUSHED_BUILDER_CHANGE) unless the caller passes discard_builder_changes:
 * true. This client must carry that flag on every door, name it in the tool,
 * and point the refusals' way out at it. And the other way out,
 * ateam_redeploy(solution_id), must say what it could NOT place.
 *
 * Drives the real handlers with fetch stubbed.
 *
 * Run: node --test test/pull-discards-only-when-told.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers, tools } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";

function stubFetch(answer) {
  const origFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url: u, body });
    const out = answer(u, body);
    return {
      ok: out.status ? out.status < 400 : true,
      status: out.status || 200,
      headers: { get: () => "application/json" },
      json: async () => out.body,
      text: async () => JSON.stringify(out.body),
    };
  };
  return { calls, restore: () => { global.fetch = origFetch; } };
}

const pullCalls = (calls) => calls.filter((c) => c.url.includes("/github/pull"));

test("the pull forwards discard_builder_changes:true to the Builder — on the async door", async () => {
  const f = stubFetch((u) => (u.includes("/deploy/jobs/")
    ? { body: { status: "done", ok: true } }
    : { body: { ok: true, async: true, job_id: "github-pull-walkmate-1" } }));
  try {
    await handlers.ateam_github_pull({ solution_id: "walkmate", discard_builder_changes: true }, "sid");
  } finally { f.restore(); }
  const [kick] = pullCalls(f.calls);
  assert.equal(kick.body.async, true);
  assert.equal(kick.body.discard_builder_changes, true, "the caller's decision to drop Builder changes never reached the Builder");
});

test("…and on the sync fallback", async () => {
  let first = true;
  const f = stubFetch(() => {
    if (first) { first = false; return { status: 404, body: { error: "no async here" } }; }
    return { body: { ok: true } };
  });
  try {
    await handlers.ateam_github_pull({ solution_id: "walkmate", discard_builder_changes: true }, "sid");
  } finally { f.restore(); }
  const calls = pullCalls(f.calls);
  assert.ok(calls.length >= 2, JSON.stringify(calls));
  assert.equal(calls.at(-1).body.discard_builder_changes, true);
});

test("a routine pull does not send it — the Builder then refuses to drop a change no branch has", async () => {
  const f = stubFetch((u) => (u.includes("/deploy/jobs/")
    ? { body: { status: "failed", ok: false, code: "UNPUSHED_BUILDER_CHANGE", files: ["solution.json"], hint: "…ateam_github_pull(solution_id, discard_builder_changes:true)…" } }
    : { body: { ok: true, async: true, job_id: "github-pull-walkmate-2" } }));
  let r;
  try {
    r = await handlers.ateam_github_pull({ solution_id: "walkmate" }, "sid");
  } finally { f.restore(); }
  assert.equal("discard_builder_changes" in pullCalls(f.calls)[0].body, false);
  assert.equal(r.code, "UNPUSHED_BUILDER_CHANGE", "the refusal did not reach the caller");
  assert.deepEqual(r.files, ["solution.json"]);
});

test("the tool declares the flag, and says a pull that would drop a change is refused without it", () => {
  const pull = tools.find((t) => t.name === "ateam_github_pull");
  assert.equal(pull.inputSchema.properties.discard_builder_changes?.type, "boolean",
    "undeclared, the MCP host strips the argument and the caller cannot drop a change even when they mean to");
  assert.match(pull.description, /REFUSED[\s\S]*discard_builder_changes:true/);
});

test("every way out names the discard, and ateam_redeploy(solution_id) as the way to keep the change", () => {
  const bar = tools.find((t) => t.name === "ateam_build_and_run").description;
  assert.match(bar, /ateam_redeploy\(solution_id\)[\s\S]*solution\.json[\s\S]*ateam_github_pull\(solution_id, discard_builder_changes:true\)/);
  const patch = tools.find((t) => t.name === "ateam_github_patch").description;
  assert.match(patch, /ateam_github_pull too, unless told discard_builder_changes:true/);
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [] });
  assert.match(doc, /ateam_github_pull\(solution_id, discard_builder_changes: true\)/);
  assert.doesNotMatch(doc, /`ateam_github_pull` drops it/, "the doc still says a plain pull drops the change");
});

test("ateam_redeploy says what it could NOT write to dev (the way out that did not work)", async () => {
  const notWritten = [{ code: "NOT_WRITTEN_TO_GITHUB", path: "solution.json", message: "Saved in the Builder only — NOT written to GitHub: …" }];
  const f = stubFetch((u) => (u.includes("/deploy/jobs/")
    ? { body: { status: "done", ok: true, deployed: 1, failed: 0, total: 1, skills: [{ skill_id: "walk-guide", ok: true }], not_written_to_github: notWritten } }
    : { body: { ok: true, async: true, job_id: "redeploy-bulk-walkmate-1" } }));
  let r;
  try {
    r = await handlers.ateam_redeploy({ solution_id: "walkmate" }, "sid");
  } finally { f.restore(); }
  assert.deepEqual(r.not_written_to_github, notWritten, "the redeploy's own report of what it could not place was dropped");
});
