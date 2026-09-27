// THE CLONE LINE IN THE GENERATED CLAUDE.md MUST WORK WHEN SOMEONE RUNS IT.
//
// Every build_and_run commits this header into the tenant's repo, and the next
// agent or human there copies its "Editing files by hand" line. It was
//
//   git clone <this repo> && git checkout dev 2>/dev/null || git checkout -b dev
//
// `git clone` does not cd, so the checkout ran in whatever directory the reader
// was in; and `a && b || c` runs `c` whenever `a` or `b` fails — so a failed
// clone, or a checkout outside the clone, went on to CREATE `dev` in that
// unrelated repo (commonly the agent's own workspace), and the next two lines
// committed and pushed from the wrong tree. The only guard was a regex over the
// text (bootstrap-one-branch-model.test.mjs), which a broken command satisfies.
//
// So this RUNS the rendered line, with a real git, against real repos: a
// main-only origin (three live tenant repos are like that — ensureDevBranch
// makes `dev` only on the platform's first write), an origin that has `dev`,
// and a clone that fails — every time from inside an unrelated git checkout.
//
// Run: node --test test/agent-doc-clone-step.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAgentDocHeader } from "../src/agentDoc.js";

const SOL = "walkmate";
const DOC = renderAgentDocHeader({ solution: { id: SOL, name: "Walkmate" }, skills: [], connectors: [] });
const LINE = DOC.split("\n").find((l) => l.startsWith("git clone <this repo>"));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const branches = (cwd) => git(cwd, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

let root;
function repoWithCommit(dir, branch = "main") {
  git(root, "init", "-q", "-b", branch, dir);
  writeFileSync(join(dir, "solution.json"), "{}\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
function bareOrigin(name, { withDev }) {
  const work = repoWithCommit(join(root, `${name}-src`));
  if (withDev) {
    git(work, "checkout", "-q", "-b", "dev");
    writeFileSync(join(work, "dev-only.txt"), "dev\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "dev work");
    git(work, "checkout", "-q", "main");
  }
  const bare = join(root, `${name}.git`);
  git(root, "clone", "-q", "--bare", work, bare);
  return bare;
}

/** Run the doc's line, verbatim but for the URL, from `cwd`. */
function runLine(cwd, url) {
  return spawnSync("sh", ["-c", LINE.replace("<this repo>", url)], { cwd, env: GIT_ENV, encoding: "utf8" });
}

before(() => { root = mkdtempSync(join(tmpdir(), "agent-doc-clone-")); });
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

test("(control) the doc carries the clone line", () => {
  assert.ok(LINE, "no line starting `git clone <this repo>` in the rendered header");
});

test("main-only origin: the CLONE ends on dev, and the repo you ran it from is untouched", () => {
  const origin = bareOrigin("main-only", { withDev: false });
  const workspace = repoWithCommit(join(root, "workspace-1"));
  const r = runLine(workspace, origin);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(branches(workspace), ["main"], "the line created a branch in the repo it was run FROM");
  const clone = join(workspace, SOL);
  assert.ok(existsSync(join(clone, ".git")), `no clone at ${clone}`);
  assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "dev", "the clone is not on dev");
});

test("origin with dev: the clone ends on dev AT origin/dev", () => {
  const origin = bareOrigin("with-dev", { withDev: true });
  const workspace = repoWithCommit(join(root, "workspace-2"));
  const r = runLine(workspace, origin);
  assert.equal(r.status, 0, r.stderr);
  const clone = join(workspace, SOL);
  assert.ok(existsSync(join(clone, ".git")), `no clone at ${clone}`);
  assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
  assert.equal(git(clone, "rev-parse", "HEAD"), git(clone, "rev-parse", "origin/dev"),
    "a fresh dev was cut from main instead of taking the origin's dev");
  assert.deepEqual(branches(workspace), ["main"]);
});

test("a clone that FAILS creates nothing anywhere", () => {
  const workspace = repoWithCommit(join(root, "workspace-3"));
  const r = runLine(workspace, join(root, "does-not-exist.git"));
  assert.notEqual(r.status, 0, "a failed clone reported success");
  assert.deepEqual(branches(workspace), ["main"], "a failed clone went on to create dev in the current repo");
  assert.equal(git(workspace, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});
