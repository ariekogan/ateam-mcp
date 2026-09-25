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
