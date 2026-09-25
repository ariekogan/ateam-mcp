/**
 * ateam_build_and_run DEPLOYS `main` — and says so on the wire.
 *
 * The whole branch story (BRANCH_WORKFLOW) is: edit on dev → promote → main →
 * build_and_run deploys main. The Builder's MAIN_BEHIND_DEV guard refuses a
 * deploy until you promote, on exactly that premise.
 *
 * Phase 0 used to POST {} to pull-bundle and rely on the Builder's default.
 * That default was `main` until Builder 873558e made it `dev`; from then on
 * build_and_run deployed UNSHIPPED dev while the guard, this repo's docs and
 * deployed_from_branch all still said main. The Builder now refuses a
 * branch-less pull-bundle (BRANCH_REQUIRED), so this call must name the branch
 * — and the name must come from the one owner, not a second literal.
 *
 * Run: node --test test/build-and-run-deploys-main.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/tools.js";
import { BRANCH_WORKFLOW } from "../src/branchWorkflow.js";

async function runPhase0() {
  const seen = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    seen.push({ url: u, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
    const body = u.includes("/github/status")
      ? { ok: true, repo_url: "https://github.com/x/y" }
      // Stop build_and_run right after Phase 0: the pull "fails", so nothing
      // past the read under test runs.
      : { ok: false, error: "stop after phase 0" };
    return {
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => body, text: async () => JSON.stringify(body),
    };
  };
  try {
    const result = await handlers.ateam_build_and_run({ solution_id: "walkmate" }, "sid");
    return { result, seen };
  } finally { global.fetch = origFetch; }
}

test("Phase 0 names the branch it deploys", async () => {
  const { seen } = await runPhase0();
  const pull = seen.find((r) => r.url.includes("/github/pull-bundle"));
  assert.ok(pull, "build_and_run never asked for the bundle — Phase 0 did not run");
  assert.equal(pull.method, "POST");
  assert.ok(pull.body && "branch" in pull.body,
    "pull-bundle was called with no branch — the Builder refuses that, and used to guess dev");
});

test("and that branch is main — the shipped state", async () => {
  const { seen } = await runPhase0();
  const pull = seen.find((r) => r.url.includes("/github/pull-bundle"));
  assert.equal(pull.body.branch, "main");
});

test("taken from the owner, not a second literal", async () => {
  const { seen } = await runPhase0();
  const pull = seen.find((r) => r.url.includes("/github/pull-bundle"));
  assert.equal(pull.body.branch, BRANCH_WORKFLOW.deploy_branch);
  // A source check, bounded and anchored: the pull-bundle POST must pass the
  // owner's field, so renaming deploy_branch cannot leave a stale 'main' here.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  const at = src.indexOf("/github/pull-bundle`,");
  assert.ok(at > -1, "anchor moved — this check guards nothing");
  assert.match(src.slice(at, at + 120), /\{ branch: BRANCH_WORKFLOW\.deploy_branch \}/);
});

// ─── WHERE THE PAYLOAD CAME FROM, AS THE BUILDER HEARS IT ────────────────────
//
// The Builder mirrors a `github: true` deploy into its store WITHOUT writing it
// back to the repo. That is only safe when the payload IS the repo's content.
// skip_github_push cannot say so: it follows the `github` argument, and this
// tool's own advice ("ateam_build_and_run(solution, skills)") sends an inline
// solution and skills with it. Mirroring those would keep the edit out of
// GitHub, and the next build_and_run(solution_id) would pull main and revert it.
//
// These run the whole handler past Phase 2 and read the bodies it sends.

const PULLED = {
  ok: true,
  solution: { id: "walkmate", name: "WalkMate", skills: [{ id: "walk-guide" }] },
  skills: [{ id: "walk-guide", name: "Walking Guide" }],
  mcp_store: { "walk-trail": [{ path: "server.js", content: "// main" }] },
  skills_found: 1, connectors_found: 1, files_loaded: 1,
};

async function runDeploy(args, { syncDeploy } = {}) {
  const seen = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    seen.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    let status = 200;
    let body = { ok: true };
    if (u.includes("/github/status")) body = { ok: true, repo_url: "https://github.com/x/y" };
    else if (u.includes("/github/pull-bundle")) body = PULLED;
    else if (u.includes("/validate/solution")) body = { ok: true, errors: [], warnings: [] };
    else if (u.endsWith("/deploy/solution") && method === "POST") {
      const b = JSON.parse(opts.body);
      if (b.async) body = { ok: true, async: true, job_id: "job-1" };
      else if (syncDeploy === "gateway-timeout") { status = 524; body = { error: "timeout" }; }
      else body = { ok: true, import: { skills: [], connectors: 1 } };
    } else if (u.includes("/deploy/jobs/job-1")) body = { status: "done", ok: true, import: { skills: [], connectors: 1 } };
    else if (u.includes("/upload")) body = { ok: true, tools: 3 };
    return {
      ok: status < 400, status, headers: { get: () => "application/json" },
      json: async () => body, text: async () => JSON.stringify(body),
    };
  };
  try {
    const result = await handlers.ateam_build_and_run({ solution_id: "walkmate", ...args }, "sid");
    return { result, seen };
  } finally { global.fetch = origFetch; }
}

const deployPosts = (seen) => seen.filter((r) => r.url.endsWith("/deploy/solution") && r.method === "POST");

test("THE PROVENANCE FLAG: solution, skills and code ALL pulled → github:true", async () => {
  const { result, seen } = await runDeploy({});
  const [sync] = deployPosts(seen);
  assert.ok(sync, `no deploy was posted: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(sync.body.github, true,
    "the Builder was not told this payload is the repo's own content — it will write it back to dev");
  assert.equal(sync.body.skip_github_push, true, "skip_github_push must still be sent, exactly as before");
});

for (const [what, args] of [
  ["an inline solution", { solution: { id: "walkmate", name: "WalkMate (edited)", skills: [{ id: "walk-guide" }] } }],
  ["inline skills", { skills: [{ id: "walk-guide", name: "Walking Guide (edited)" }] }],
  ["inline connectors[]", { connectors: [{ id: "walk-trail", name: "Walk Trail", transport: "stdio" }] }],
]) {
  test(`THE DATA LOSS: ${what} + pulled code → NO github flag (the edit must reach dev)`, async () => {
    const { seen } = await runDeploy(args);
    const [sync] = deployPosts(seen);
    assert.ok(sync, "no deploy was posted");
    assert.equal("github" in sync.body, false,
      `${what} was sent as if it were the repo's content — the Builder would mirror it and never write it to GitHub`);
    assert.equal(sync.body.skip_github_push, true, "skip_github_push must still follow `github`, as before");
  });
}

test("inline mcp_store: nothing is pulled, so neither flag describes a pull", async () => {
  const { seen } = await runDeploy({
    solution: PULLED.solution, skills: PULLED.skills, mcp_store: PULLED.mcp_store,
  });
  assert.equal(seen.some((r) => r.url.includes("/github/pull-bundle")), false);
  const [sync] = deployPosts(seen);
  assert.equal("github" in sync.body, false);
  assert.equal("skip_github_push" in sync.body, false);
});

test("the async fallback carries the SAME provenance as the sync attempt", async () => {
  const { seen } = await runDeploy({}, { syncDeploy: "gateway-timeout" });
  const posts = deployPosts(seen);
  const asyncPost = posts.find((r) => r.body.async === true);
  assert.ok(asyncPost, `the timeout did not fall back to async: ${JSON.stringify(posts.map((p) => p.body.async))}`);
  assert.equal(asyncPost.body.github, true, "the async door was told less than the sync one");
  assert.equal(asyncPost.body.skip_github_push, true);
});

// ─── R4: the connector upload merges over the branch its files came from ─────

test("Phase 2.5: files pulled from main are uploaded against ref main, not the dev default", async () => {
  const { seen } = await runDeploy({});
  const up = seen.find((r) => r.url.includes("/connectors/walk-trail/upload"));
  assert.ok(up, "the connector was never uploaded");
  assert.equal(up.body.ref, BRANCH_WORKFLOW.deploy_branch,
    "the upload merged main's files over dev — dev-only files reach Core in a run that says it deploys main");
  assert.deepEqual(up.body.files, PULLED.mcp_store["walk-trail"]);
});

test("Phase 2.5: an inline mcp_store keeps the upload's default ref", async () => {
  const { seen } = await runDeploy({
    solution: PULLED.solution, skills: PULLED.skills, mcp_store: PULLED.mcp_store,
  });
  const up = seen.find((r) => r.url.includes("/connectors/walk-trail/upload"));
  assert.ok(up, "the connector was never uploaded");
  assert.equal("ref" in up.body, false, "an inline upload was pinned to a branch it never came from");
});
