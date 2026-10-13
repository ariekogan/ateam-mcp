/**
 * ateam_build_and_run(ref) DEPLOYS ONE EXACT COMMIT — git plan A2.
 *
 * `ref` is a branch, a tag or a commit. The Builder resolves it (pull-bundle
 * with pin_commit) to one commit of the workspace's own bound repository; this
 * client then carries THAT SHA, never the typed name, to the deploy door and to
 * the connector upload, and reports it. Without `ref` the call is what it was:
 * it deploys `main` (build-and-run-deploys-main.test.mjs pins that side).
 *
 * Run: node --test test/build-and-run-ref.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers, tools as TOOLS } from "../src/tools.js";

const SHA = "c1".repeat(20);
const SOLUTION = { id: "walkmate", name: "WalkMate", skills: [{ id: "walk-guide" }] };

const pulled = (extra = {}) => ({
  ok: true,
  solution: SOLUTION,
  skills: [{ id: "walk-guide", name: "Walking Guide" }],
  mcp_store: { "walk-trail": [{ path: "server.js", content: "// at the commit" }] },
  skills_found: 1, connectors_found: 1, files_loaded: 1,
  commit: SHA, ref: "prod-2026-10-01-001", ref_kind: "tag", repo: "ateam-tenants/ADT-x",
  ...extra,
});

/**
 * Runs the whole handler against a fake Builder. `pull` is pull-bundle's answer
 * (or a function of its request), `door` the deploy door's.
 */
async function run(args, { pull = pulled(), pullStatus = 200, door = (b) => ({ ok: true, deployed_commit: b.ref, import: { skills: [], connectors: 1 } }), syncDeploy } = {}) {
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    const reqBody = opts.body ? JSON.parse(opts.body) : undefined;
    seen.push({ url: u, method, body: reqBody });
    let status = 200;
    let body = { ok: true };
    if (u.includes("/github/status")) body = { ok: true, repo_url: "https://github.com/x/y" };
    else if (u.includes("/github/pull-bundle")) { status = pullStatus; body = typeof pull === "function" ? pull(reqBody) : pull; }
    else if (u.includes("/validate/solution")) body = { ok: true, errors: [], warnings: [] };
    else if (u.endsWith("/deploy/solution") && method === "POST") {
      if (reqBody.async) body = { ok: true, async: true, job_id: "job-1" };
      else if (syncDeploy === "gateway-timeout") { status = 524; body = { error: "timeout" }; }
      else body = door(reqBody);
    } else if (u.includes("/deploy/jobs/job-1")) body = { status: "done", ...door(seen.filter((s) => s.body?.async).at(-1).body) };
    else if (u.includes("/upload")) body = { ok: true, tools: 3 };
    return {
      ok: status < 400, status, headers: { get: () => "application/json" },
      json: async () => body, text: async () => JSON.stringify(body),
    };
  };
  try {
    const result = await handlers.ateam_build_and_run({ solution_id: "walkmate", ...args }, "sid");
    return { result, seen };
  } finally { global.fetch = orig; }
}

const deployPosts = (seen) => seen.filter((r) => r.url.endsWith("/deploy/solution") && r.method === "POST");
const pullOf = (seen) => seen.find((r) => r.url.includes("/github/pull-bundle"));

test("THE PULL: ref is sent as the branch with pin_commit, and the repo-status probe is not needed", async () => {
  const { seen } = await run({ ref: "prod-2026-10-01-001" });
  const pull = pullOf(seen);
  assert.ok(pull, "build_and_run never asked for the bundle");
  assert.deepEqual(pull.body, { branch: "prod-2026-10-01-001", pin_commit: true });
  assert.equal(seen.some((r) => r.url.includes("/github/status")), false);
});

test("THE DEPLOY carries the resolved SHA, never the typed name, and the whole bundle is named as the repo's own", async () => {
  const { seen } = await run({ ref: "prod-2026-10-01-001" });
  const [sync] = deployPosts(seen);
  assert.ok(sync, "no deploy was posted");
  assert.equal(sync.body.ref, SHA);
  assert.deepEqual(sync.body.pulled_from_github, ["solution", "skills", "mcp_store"]);
  assert.equal("github" in sync.body, false, "github:true must still never be sent");
});

test("the async fallback carries the same SHA", async () => {
  const { seen } = await run({ ref: "main" }, { syncDeploy: "gateway-timeout" });
  const posts = deployPosts(seen);
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.body.ref === SHA), JSON.stringify(posts.map((p) => p.body.ref)));
});

test("the connector re-upload reads the commit, not `main` and not the moving name", async () => {
  const { seen } = await run({ ref: "main" });
  const uploads = seen.filter((r) => r.url.includes("/upload"));
  assert.ok(uploads.length > 0, "no connector upload ran");
  assert.ok(uploads.every((u) => u.body.ref === SHA), JSON.stringify(uploads.map((u) => u.body.ref)));
});

test("THE ANSWER names the commit, the ref asked, its kind and the repository; it never claims `main`", async () => {
  const { result } = await run({ ref: "prod-2026-10-01-001" });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.deployed_commit, SHA);
  assert.equal(result.requested_ref, "prod-2026-10-01-001");
  assert.equal(result.ref_kind, "tag");
  assert.equal(result.repo, "ateam-tenants/ADT-x");
  assert.equal("deployed_from_branch" in result, false, "an exact-commit deploy claimed a branch");
  assert.match(result._next, new RegExp(SHA));
  assert.match(result._next, /no ref deploys `main`/);
  const pullPhase = result.phases.find((p) => p.phase === "github_pull");
  assert.equal(pullPhase.commit, SHA);
});

test("a branch ref reports the branch it was, as the branch it was asked", async () => {
  const { result } = await run({ ref: "dev" }, { pull: pulled({ ref: "dev", ref_kind: "branch" }) });
  assert.equal(result.deployed_commit, SHA);
  assert.equal(result.deployed_from_branch, "dev");
});

test("the Builder's warning about replacing dev work is passed on in the deploy's warnings", async () => {
  const warning = { check: "REF_DEPLOY", warning: "Deploying commit c1c1c1c (tag ...), which is not the tip of main." };
  const { result } = await run({ ref: "prod-2026-10-01-001" }, {
    door: (b) => ({ ok: true, deployed_commit: b.ref, deploy_warnings: [warning], import: { skills: [], connectors: 1 } }),
  });
  assert.deepEqual(result.deploy.warnings, [warning]);
});

test("INLINE PARTS CANNOT RIDE A COMMIT: each is refused before anything is sent", async () => {
  for (const [what, args] of [
    ["solution", { solution: SOLUTION }],
    ["skills", { skills: [{ id: "walk-guide" }] }],
    ["connectors", { connectors: [{ id: "walk-trail" }] }],
    ["mcp_store", { mcp_store: { "walk-trail": [{ path: "server.js", content: "x" }] } }],
  ]) {
    const { result, seen } = await run({ ref: "main", ...args });
    assert.equal(result.ok, false, what);
    assert.equal(result.code, "REF_WITH_INLINE_PARTS", what);
    assert.match(result.error, new RegExp(what));
    assert.equal(seen.length, 0, `${what}: the refused call still sent ${seen.map((s) => s.url)}`);
  }
});

test("a ref that is not a string is refused; an empty one is no ref", async () => {
  const bad = await run({ ref: 42 });
  assert.equal(bad.result.code, "REF_INVALID");
  assert.equal(bad.seen.length, 0);
  const none = await run({ ref: "" });
  assert.deepEqual(pullOf(none.seen).body, { branch: "main" });
});

test("A BUILDER THAT CANNOT NAME THE COMMIT deploys nothing", async () => {
  // A Builder from before ref ignores pin_commit and answers the branch's current content, with no commit.
  const old = pulled(); delete old.commit; delete old.ref_kind; delete old.repo;
  const { result, seen } = await run({ ref: "dev" }, { pull: old });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REF_NOT_SUPPORTED_BY_BUILDER");
  assert.equal(deployPosts(seen).length, 0, "an unnamed commit was deployed");
  // And a commit that is not a SHA is not a commit.
  const odd = await run({ ref: "dev" }, { pull: pulled({ commit: "main" }) });
  assert.equal(odd.result.code, "REF_NOT_SUPPORTED_BY_BUILDER");
});

test("THE BUILDER'S REFUSALS reach the caller with their code: another repository, another tenant, an unknown ref", async () => {
  for (const [code, error] of [
    ["REF_REPO_NOT_BOUND", "ref names the repository o/other, but this workspace's bound repository is o/mine."],
    ["REF_NOT_FOUND", 'ref "nope" is not a branch, a tag or a commit of o/mine.'],
    ["GITHUB_BINDING_MISMATCH", "Resolving the ref failed: github_binding_mismatch: another tenant"],
  ]) {
    const { result, seen } = await run({ ref: "x" }, { pull: { ok: false, code, error }, pullStatus: code === "REF_NOT_FOUND" ? 404 : 409 });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
    assert.equal(result.phase, "github_pull");
    assert.match(result.error, new RegExp(error.slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(deployPosts(seen).length, 0, `${code}: a refused ref still deployed`);
  }
});

test("a deploy door that answers ANOTHER commit than asked is not trusted", async () => {
  const { result } = await run({ ref: "dev" }, { door: () => ({ ok: true, deployed_commit: "9".repeat(40), import: { skills: [], connectors: 1 } }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REF_COMMIT_MISMATCH");
  assert.equal(result.requested_commit, SHA);
});

test("a commit that holds no solution says so in terms of the ref, not 'promote'", async () => {
  const noSolution = pulled(); delete noSolution.solution;
  const { result } = await run({ ref: "prod-2026-10-01-001" }, { pull: noSolution });
  assert.equal(result.ok, false);
  assert.match(result.error, /prod-2026-10-01-001/);
  assert.match(result.error, new RegExp(SHA));
  assert.doesNotMatch(result.message, /promote/i);
  const noSkills = pulled({ skills: [] });
  const second = await run({ ref: "dev" }, { pull: noSkills });
  assert.match(second.result.error, /lacks skills/);
});

test("A COMMIT NAMED ONLY BY ITS ABBREVIATION is sent as typed; the Builder resolves it", async () => {
  const { seen } = await run({ ref: "c1c1c1c" });
  assert.equal(pullOf(seen).body.branch, "c1c1c1c");
});

// ─── WITHOUT ref NOTHING CHANGES ─────────────────────────────────────────────

test("no ref: main is pulled exactly as before, no ref or commit reaches the Builder, none comes back", async () => {
  const { result, seen } = await run({}, { pull: pulled({ commit: undefined, ref: undefined, ref_kind: undefined, repo: undefined }) });
  assert.deepEqual(pullOf(seen).body, { branch: "main" });
  const [sync] = deployPosts(seen);
  assert.equal("ref" in sync.body, false);
  assert.equal(seen.some((r) => r.url.includes("/github/status")), true, "the repo probe was dropped");
  assert.equal(result.deployed_from_branch, "main");
  for (const key of ["deployed_commit", "requested_ref", "ref_kind", "repo"]) assert.equal(key in result, false, key);
  assert.match(result._next, /This deployed `main`/);
  const uploads = seen.filter((r) => r.url.includes("/upload"));
  assert.ok(uploads.every((u) => u.body.ref === "main"));
});

test("no ref: inline parts are still welcome", async () => {
  const { result, seen } = await run({ solution: SOLUTION });
  assert.notEqual(result.code, "REF_WITH_INLINE_PARTS");
  assert.deepEqual(pullOf(seen).body, { branch: "main" });
});

// ─── THE TOOL'S OWN TEXT ─────────────────────────────────────────────────────

test("the tool declares ref and no longer says it has none", () => {
  const tool = TOOLS.find((t) => t.name === "ateam_build_and_run");
  assert.equal(tool.inputSchema.properties.ref.type, "string");
  assert.doesNotMatch(tool.description, /there is no `ref` parameter/);
  assert.match(tool.description, /`ref` \(branch, tag or commit SHA/);
  assert.match(tool.description, /deployed_commit/);
});

/** Runs `run`, with the agent-doc writer replaced by a counter: the doc is written to dev. */
async function runCountingDocWrites(args, opts) {
  const real = handlers.ateam_write_agent_doc;
  const writes = [];
  handlers.ateam_write_agent_doc = async (a) => { writes.push(a); return { ok: true, created: true }; };
  try {
    const out = await run(args, opts);
    return { ...out, writes };
  } finally { handlers.ateam_write_agent_doc = real; }
}

test("NO WRITE TO DEV FOR AN OLDER COMMIT: the post-deploy CLAUDE.md write is skipped, and the phase says why", async () => {
  // The Builder says the commit is not main's tip.
  const { result, writes } = await runCountingDocWrites({ ref: "prod-2026-10-01-001" }, {
    door: (b) => ({ ok: true, deployed_commit: b.ref, at_main_tip: false, import: { skills: [], connectors: 1 } }),
  });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(writes.length, 0, "a deploy of an older commit wrote the agent doc to dev");
  const phase = result.phases.find((p) => p.phase === "agent_doc");
  assert.equal(phase.status, "skipped");
  assert.match(phase.reason, /not the tip of main/);
  assert.equal("agent_doc" in result, false);
});

test("an answer that does not say it is the tip is not the tip: no write to dev (an older Builder)", async () => {
  const { writes } = await runCountingDocWrites({ ref: "prod-2026-10-01-001" });
  assert.equal(writes.length, 0);
});

test("a ref that IS main's tip is a deploy of main: the doc is written as it is without ref", async () => {
  const { result, writes } = await runCountingDocWrites({ ref: "main" }, {
    door: (b) => ({ ok: true, deployed_commit: b.ref, at_main_tip: true, import: { skills: [], connectors: 1 } }),
  });
  assert.equal(writes.length, 1);
  assert.equal(result.phases.find((p) => p.phase === "agent_doc").status, "done");
});

test("WITHOUT ref the doc is written, as it always was", async () => {
  const { writes } = await runCountingDocWrites({}, {
    pull: pulled({ commit: undefined, ref: undefined, ref_kind: undefined, repo: undefined }),
    door: () => ({ ok: true, import: { skills: [], connectors: 1 } }),
  });
  assert.equal(writes.length, 1);
});
