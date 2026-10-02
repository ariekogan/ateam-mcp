// A BUNDLE THE BUILDER COULD NOT READ IN FULL IS REFUSED, NEVER DEPLOYED IN
// PART — and a refusal from pull-bundle reaches the caller as the Builder said
// it (Builder #144, B144R-6; CORE on #58, B58R-3).
//
// pull-bundle answers ok with the files it read, and names what it could not:
// `solution_unreadable` (the first of solution.json and the skills that could
// not be read or parsed) and `connectors_unreadable` (connectors with a file
// that could not be read). build_and_run noted connectors_unreadable in its
// phases (d841dd7) and deployed the rest; a skill the Builder could not read
// was simply missing from the deploy.
//
// When pull-bundle refused (a cut listing, a branch it could not read), the
// catch added "The repo may not exist yet — deploy with mcp_store first"
// (bc44a67, written when "no repo" was the only failure). That contradicted
// the refusal's own hint and sent the agent to re-send connector code inline.
//
// Run: node --test test/build-and-run-unread-bundle.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/tools.js";

const SOLUTION = { id: "walkmate", name: "Walkmate", skills: [{ id: "guide" }] };
const SKILL = { id: "guide", name: "Guide" };

/** Run build_and_run(solution_id) against a Builder whose pull-bundle answers `pull` ({ status, body }). */
async function deployFrom(pull) {
  const seen = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    seen.push(u);
    const [status, body] = u.includes("/github/status")
      ? [200, { ok: true, repo_url: "https://github.com/x/y" }]
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

const bundle = (extra) => ({ ok: true, solution: SOLUTION, skills: [SKILL], mcp_store: { "walk-api": [{ path: "server.js", content: "x" }] }, ...extra });

test("a skill pull-bundle could not read: refused, BRANCH_NOT_READ naming it — nothing deployed", async () => {
  const { result, wentOn } = await deployFrom({ body: bundle({ skills: [], solution_unreadable: { path: "skills/guide/skill.json", stage: "read", error: "GitHub API 502", code: "FILE_NOT_READ" } }) });
  assert.deepEqual(wentOn, [], `the deploy went on without the skill: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(result.ok, false);
  assert.equal(result.code, "BRANCH_NOT_READ");
  assert.equal(result.path, "skills/guide/skill.json");
  assert.equal(result.cause_code, "FILE_NOT_READ");
});

test("a solution.json that does not parse: refused, SOLUTION_JSON_INVALID — a file to fix, not a retry", async () => {
  const { result, wentOn } = await deployFrom({ body: bundle({ solution: undefined, solution_unreadable: { path: "solution.json", stage: "parse", error: "Unexpected token }" } }) });
  assert.deepEqual(wentOn, []);
  assert.equal(result.code, "SOLUTION_JSON_INVALID");
  assert.match(result.hint, /ateam_github_patch\(solution_id, path:'solution\.json'\)/);
});

test("a connector with a file pull-bundle could not read: refused, not deployed without it", async () => {
  const { result, wentOn } = await deployFrom({ body: bundle({ connectors_unreadable: ["walk-api"] }) });
  assert.deepEqual(wentOn, [], `the deploy went on with a connector short of a file: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(result.code, "BRANCH_NOT_READ");
  assert.deepEqual(result.connectors_unreadable, ["walk-api"]);
});

// pull-bundle's REAL answer to a listing that failed (a 403 rate limit on
// main), as Builder #144 (b560e75a) serves it — recovery included. Its
// recovery is build_and_run's own: a fixture that carried ateam_github_pull,
// which deploys dev, would have shown the agent sent to unpromoted work
// (CORE on #144, B144R-11).
const PULL_BUNDLE_NOT_READ = {
  "ok": false,
  "code": "BRANCH_NOT_READ",
  "error": "Refusing to deploy: main could not be read (its listing failed: GitHub API GET /repos/ateam-tenants-test/trail-repo/git/trees/main?recursive=1 → 403: API rate limit exceeded). Deploying now would ship a solution without what the branch holds there. Nothing was deployed.",
  "why": "its listing failed: GitHub API GET /repos/ateam-tenants-test/trail-repo/git/trees/main?recursive=1 → 403: API rate limit exceeded",
  "hint": "Retry the deploy; GitHub reads are usually back within a minute.",
  "recovery": "ateam_build_and_run(solution_id)"
};

test("pull-bundle's own refusal reaches the caller as the Builder said it, recovery included — no 'deploy with mcp_store first'", async () => {
  const said = PULL_BUNDLE_NOT_READ;
  const { result } = await deployFrom({ status: 502, body: said });
  assert.deepEqual(
    { code: result.code, error: result.error, hint: result.hint, recovery: result.recovery },
    { code: said.code, error: said.error, hint: said.hint, recovery: said.recovery },
  );
  assert.equal(result.recovery, "ateam_build_and_run(solution_id)");
  assert.doesNotMatch(JSON.stringify(result), /ateam_github_pull/, "the agent is sent to a pull that deploys dev");
  assert.doesNotMatch(JSON.stringify(result), /mcp_store first/, "the refusal was overruled by a guess that sends the agent to re-send code inline");
});

test("an ok:false answer with a code is passed through too, hint and recovery included", async () => {
  // The same refusal, answered as a 2xx ok:false: the other path a refusal takes here.
  const said = PULL_BUNDLE_NOT_READ;
  const { result } = await deployFrom({ body: said });
  assert.deepEqual({ code: result.code, hint: result.hint, recovery: result.recovery }, { code: said.code, hint: said.hint, recovery: said.recovery });
  assert.doesNotMatch(JSON.stringify(result), /mcp_store first/);
});

test("guard: an answer with no code (no repo) keeps the first-deploy advice", async () => {
  const { result } = await deployFrom({ status: 404, body: { ok: false, error: 'No GitHub repo found for solution "walkmate"' } });
  assert.equal(result.ok, false);
  assert.match(result.message, /deploy with mcp_store first/);
});

test("guard: a bundle read in full still deploys (Phase 0 goes on)", async () => {
  const { wentOn } = await deployFrom({ body: bundle({}) });
  assert.ok(wentOn.length > 0, "a whole bundle was refused");
});
