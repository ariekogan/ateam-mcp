// A5 "TEACH IT" (git plan): an agent that can run Git is told to use it, and an
// agent that cannot is told which tools to use instead — in every place a
// first-turn or returning agent reads.
//
//   If you can run Git, clone the repo and use it (ateam_get_repository_binding
//   says which), deploy the exact commit with ateam_build_and_run ref=<sha>;
//   ateam_get_solution status/health shows the running commit; ateam_inspect_data
//   reads what is stored; if you cannot run Git, use the ateam_github_* tools.
//
// The sentence has ONE owner (BRANCH_WORKFLOW.git_or_tools / ref_deploy_note) and
// is rendered into: ateam_bootstrap (developer_loop, branching, github_tools),
// the CLAUDE.md written into tenant repos, and ateam_build_and_run's `ref` text.
// A4 is unchanged and pinned here too: dev for work, main only by promote, no
// ref deploys main.
//
// Run: node --test test/teach-git-or-tools.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRANCH_WORKFLOW as W } from "../src/branchWorkflow.js";
import { handlers, tools } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";

const boot = await handlers.ateam_bootstrap({}, "teach-git");
const DOC = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [], connectors: [] });
const tool = (n) => tools.find((t) => t.name === n);
const toolNames = new Set(tools.map((t) => t.name));

test("the owner states the whole instruction, naming only tools that exist", () => {
  for (const must of [
    /If you can run Git, clone the repository/,
    /ateam_get_repository_binding/,
    /ateam_build_and_run\(solution_id, ref: "<sha>"\)/,
    /view: "status" or "health"/,
    /ateam_inspect_data reads what is stored \(read-only/,
    /may be switched off/,
    /If you cannot run Git/,
    /ateam_github_\* tools/,
  ]) assert.match(W.git_or_tools, must);
  for (const n of new Set((W.git_or_tools + W.ref_deploy_note).match(/ateam_[a-z_]+(?=[( ,.:])/g))) {
    if (n === "ateam_github_") continue;
    assert.ok(toolNames.has(n), `${n} is named but is not a tool`);
  }
});

test("the owner says honestly what a ref deploy of a commit that is not main's tip does", () => {
  const n = W.ref_deploy_note;
  assert.match(n, /WARNS/);
  assert.match(n, /REF_DEPLOY/);
  assert.match(n, /never pushes to `dev` or `main`/);
  assert.match(n, /connector files Core runs are the commit's files and no others/);
  assert.match(n, /Deployed is not shipped/);
  assert.match(n, /without ref deploys `main`/);
});

test("A4 is unchanged: work on dev, main only by explicit promote, no ref deploys main", () => {
  assert.match(W.one_line, /edit on `dev` .* ateam_github_promote .* ateam_build_and_run deploys `main`/);
  assert.match(W.git_or_tools, /`main` changes only by an explicit ateam_github_promote/);
  assert.match(W.deploy_side, /ateam_build_and_run\(solution_id\) deploys `main`; pass ref/);
});

test("ateam_bootstrap teaches it in developer_loop, branching and github_tools", () => {
  assert.ok(boot.developer_loop._note.includes(W.git_or_tools));
  assert.equal(boot.branching.with_git_or_without, W.git_or_tools);
  assert.equal(boot.branching.deploy_an_exact_commit, W.ref_deploy_note);
  assert.ok(boot.github_tools._note.includes("fallback for an agent that cannot run Git"));
  assert.ok(boot.github_tools._note.includes(W.git_or_tools));
  assert.equal(boot.github_tools.when_to_use_what["ateam_build_and_run(ref)"], W.ref_deploy_note);
  assert.match(boot.developer_loop.steps[5].description, /with ref it deploys one exact commit instead/);
});

test("the CLAUDE.md written into tenant repos teaches it", () => {
  assert.match(DOC, /### With Git, or without/);
  assert.ok(DOC.includes(W.git_or_tools));
  assert.ok(DOC.includes(W.ref_deploy_note));
  assert.match(DOC, /ateam_build_and_run\(solution_id: "walkmate", ref: "<sha>"\)/);
  for (const row of ["ateam_get_repository_binding(solution_id)", "the `running` field", "`ateam_inspect_data`"]) {
    assert.ok(DOC.includes(row), row);
  }
  // the dev -> promote -> main story is still there
  assert.match(DOC, /ateam_github_promote\(solution_id: "walkmate"\)/);
});

test("ateam_build_and_run: ref is described in the schema, and the description neither grew nor says there is no ref", () => {
  const t = tool("ateam_build_and_run");
  assert.ok(t.inputSchema.properties.ref.description.includes(W.ref_deploy_note));
  assert.match(t.description, /`ref` \(branch, tag or commit SHA; with solution_id only\) deploys that exact commit \(a Git push\)/);
  assert.match(t.description, /off `main` it warns/);
  assert.match(t.description, /Ship dev → main → ateam_github_promote/);
  assert.ok(t.description.length <= 2434, `description is ${t.description.length}`);
  for (const text of [t.description, JSON.stringify(boot)]) assert.doesNotMatch(text, /no ref parameter|has no ref\b/);
});

test("ateam_get_repository_binding tells the reader what to do with the clone URL", () => {
  const d = tool("ateam_get_repository_binding").description;
  assert.match(d, /Can you run Git\? Clone `clone_url`/);
  assert.match(d, /ateam_github_\* tools/);
  assert.ok(d.length <= 1200);
});

test("no served text hands out or asks for a GitHub token", () => {
  assert.match(W.git_or_tools, /never ask for one or put one in the chat/);
});
