// CHECK A (Run 5, 2026-10-03), the ateam-mcp half: ateam_build_and_run relays
// the Builder's reason, and gives no advice of its own that contradicts it.
//
// M1. When pull-bundle refuses a deploy it names a `code`, an `error` and a
// `hint` of its own (MAIN_BEHIND_DEV: "walk-ui exists only on dev … deploy it
// from dev, or ship it"). build_and_run used to add its fixed guess "The repo
// may not exist yet — deploy with mcp_store first" (bc44a67, 2026-03-11, when
// "no repo" was the only failure) — advice that sends the agent to re-send
// connector code inline, against the Builder's own answer. pullRefused (#58,
// B58R-3) is the ONE place that decides; both of build_and_run's pull sites
// call it. These tests pin the Builder's 409 through both: the thrown answer
// and the ok:false answer.
//
// M2. When the pull SUCCEEDED but `main` (what this call deploys) holds no
// solution, the guard said "Pass solution inline". That text dates from
// 8c5a114 (2026-03-21), when a missing solution meant no repo. For an existing
// repo it is wrong advice: nothing has been promoted, and the roads are
// promote, or upload the connector from dev. The no-repo road is unchanged.
//
// Run: node --test test/build-and-run-relays-builder-reason.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/tools.js";

/** Run build_and_run(solution_id) against a Builder whose github/status answers `status` and pull-bundle answers `pull` ({ status, body }). */
async function deployFrom(pull, { repo = true } = {}) {
  const seen = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const [status, body] = u.includes("/github/status")
      ? (repo ? [200, { ok: true, repo_url: "https://github.com/x/y" }] : [404, { ok: false, error: "No GitHub repo" }])
      : u.includes("/github/pull-bundle")
        ? [pull.status ?? 200, pull.body]
        // Anything past Phase 0 answers a stop, so a deploy that went on is visible in `seen`.
        : [200, { ok: false, error: "past phase 0" }];
    return {
      ok: status < 400, status, headers: { get: () => "application/json" },
      json: async () => body, text: async () => JSON.stringify(body),
    };
  };
  try {
    const result = await handlers.ateam_build_and_run({ solution_id: "walkmate" }, "sid");
    return { result, wentOn: seen.filter((u) => !u.includes("/github/status") && !u.includes("/github/pull-bundle")) };
  } finally { global.fetch = origFetch; }
}

// The shape of the Builder's MAIN_BEHIND_DEV refusal (Builder deploy.js), with
// the connector named first, as CHECK A's B1 has the Builder write it.
const MAIN_BEHIND_DEV = {
  ok: false,
  code: "MAIN_BEHIND_DEV",
  error: "Refusing to deploy: connector walk-ui exists only on 'dev'; this deploy carries no source for it, so walk-ui would not be deployed.",
  hint: "Deploy it from dev now: ateam_upload_connector(solution_id, connector_id:'walk-ui', github:true). Or ship it: ateam_github_promote(solution_id), then retry.",
  recovery: "ateam_github_promote(solution_id)",
};

function assertBuilderReasonOnly(result) {
  assert.equal(result.ok, false);
  assert.equal(result.code, MAIN_BEHIND_DEV.code);
  assert.equal(result.error, MAIN_BEHIND_DEV.error);
  assert.equal(result.hint, MAIN_BEHIND_DEV.hint);
  assert.equal(result.recovery, MAIN_BEHIND_DEV.recovery);
  assert.doesNotMatch(JSON.stringify(result), /mcp_store first/, "the Builder's reason was overruled by a guess that sends the agent to re-send code inline");
  assert.doesNotMatch(JSON.stringify(result), /may not exist yet/);
}

test("M1: a Builder 409 from pull-bundle (thrown answer) comes back as the Builder said it, without the 'mcp_store first' line", async () => {
  const { result, wentOn } = await deployFrom({ status: 409, body: MAIN_BEHIND_DEV });
  assert.deepEqual(wentOn, [], "the deploy went on past a refusal");
  assertBuilderReasonOnly(result);
});

test("M1: the same refusal as an ok:false answer (the other pull branch) is relayed the same way", async () => {
  const { result, wentOn } = await deployFrom({ status: 200, body: MAIN_BEHIND_DEV });
  assert.deepEqual(wentOn, []);
  assertBuilderReasonOnly(result);
});

test("M1 control: an answer with no code (no repo) keeps the first-deploy advice", async () => {
  const { result } = await deployFrom({ status: 404, body: { ok: false, error: 'No GitHub repo found for solution "walkmate"' } });
  assert.match(result.message, /deploy with mcp_store first/);
});

test("M2: main holds no solution in an EXISTING repo: says so, says nothing was promoted, gives the roads — never 'pass solution inline'", async () => {
  // pull-bundle's answer on a main with no solution.json: ok, no solution.
  const { result, wentOn } = await deployFrom({ body: { ok: true, skills: [], mcp_store: {} } });
  assert.deepEqual(wentOn, [], "a deploy with nothing to deploy went on");
  assert.equal(result.ok, false);
  assert.equal(result.phase, "pre_check");
  const said = JSON.stringify(result);
  assert.doesNotMatch(said, /pass solution inline/i, `the stale first-deploy advice: ${said}`);
  assert.match(result.error, /`main`.*holds no solution/, result.error);
  assert.match(result.error, /nothing has been promoted/, result.error);
  // The two roads: ship it, or deploy the connector from dev.
  assert.match(result.message, /ateam_github_promote\(solution_id, dry_run:true\)/);
  assert.match(result.message, /ateam_github_promote\(solution_id\) ships it/);
  assert.match(result.message, /ateam_upload_connector\(solution_id, connector_id, github:true\)/);
  assert.match(result.message, /`dev`/);
});

test("M2 control: the first deploy (no repo, no solution) keeps the pass-it-inline road", async () => {
  const { result } = await deployFrom({ body: { ok: true } }, { repo: false });
  assert.equal(result.phase, "pre_check");
  assert.match(result.message, /Pass solution inline/);
});
