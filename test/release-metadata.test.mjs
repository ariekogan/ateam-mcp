/**
 * WHAT A RELEASE IS MADE OF AGREES WITH ITSELF.
 *
 * Three files describe one release, and each had drifted on its own:
 *   - package-lock.json carried unresolved merge-conflict markers from d5bc9d9
 *     ("merge dev: v0.4.0", 2026-07-01): not JSON, and still at 0.3.57/0.4.0.
 *     `npm version` could not parse it and skipped it without a word, which is
 *     why every release since changed package.json alone.
 *   - publish.yml installed with `npm ci … 2>/dev/null || npm install …`
 *     (324eb47), so a failing `npm ci` was silenced and replaced by a fresh,
 *     unpinned resolution.
 *   - server.json, the MCP Registry manifest, said 0.1.2 from 3af3782
 *     (2026-02-17) on: nothing ever moved it.
 * .github/review-rules/ATEAM_MCP_INVARIANTS.md already demands the lockstep;
 * nothing enforced it. This does, and the `npm version` test drives the release
 * step itself to show the three now move together.
 *
 * And what a release is CHECKED by: publish.yml (324eb47) published on every
 * push to main and never ran a test, and no workflow ran the suite at all, so
 * a release shipped whatever main held, green or red. Now publish.yml runs
 * `npm test` between `npm ci` and `npm publish`, and ci.yml runs it on every
 * pull request. The last tests here keep both that way.
 *
 * Run: node --test test/release-metadata.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p, dir = ROOT) => readFileSync(join(dir, p), "utf8");
const json = (p, dir = ROOT) => JSON.parse(read(p, dir));
const pkg = json("package.json");

// ── Reading a workflow ──
// A workflow cannot run here, so these read what it would run. They know the
// one YAML shape .github/workflows uses — `jobs:` → `<job>:` → `steps:` →
// `- key: value` items, `on:` → `<event>:` → `branches: [..]` — and nothing
// more. A shape they do not understand yields nothing, and every check below
// first asserts that the thing it checks was found, so it fails loudly rather
// than passing on an empty read.
const PUBLISH = ".github/workflows/publish.yml";
const CI = ".github/workflows/ci.yml";
const indentOf = (l) => l.length - l.trimStart().length;
const live = (l) => l.trim() !== "" && !l.trimStart().startsWith("#");

/** Every step of every job, in file order: { job, name, uses, run, if, ... }. */
function workflowSteps(file) {
  const lines = read(file).split("\n");
  const from = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const steps = [];
  if (from < 0) return steps;
  let job = null, jobIndent = null, stepsIndent = null, itemIndent = null, step = null, lastKey = null;
  const keyValue = (t) => {
    const m = t.match(/^([\w-]+):\s*(.*)$/);
    if (!m) return;
    lastKey = m[1];
    step[m[1]] = /^[|>][-+]?$/.test(m[2]) ? "" : m[2]; // a block scalar's body follows
  };
  for (const l of lines.slice(from + 1)) {
    if (!live(l)) continue;
    const n = indentOf(l), t = l.trim();
    if (n === 0) break; // the next top-level key: jobs: is over
    jobIndent ??= n;
    if (n <= jobIndent) { job = t.replace(/:\s*$/, ""); stepsIndent = itemIndent = step = null; continue; }
    if (stepsIndent === null || n <= stepsIndent) {
      stepsIndent = t === "steps:" ? n : null;
      itemIndent = step = null;
      continue;
    }
    itemIndent ??= n;
    if (n === itemIndent && t.startsWith("- ")) { step = { job }; steps.push(step); keyValue(t.slice(2)); continue; }
    if (!step) continue;
    if (n === itemIndent + 2) { keyValue(t); continue; }
    if (lastKey) step[lastKey] += (step[lastKey] ? "\n" : "") + t; // a key's continuation lines
  }
  return steps;
}

/** The workflow's triggers: { <event>: { <key>: [values] } }. */
function workflowTriggers(file) {
  const lines = read(file).split("\n");
  const from = lines.findIndex((l) => /^["']?on["']?:\s*$/.test(l));
  const events = {};
  if (from < 0) return events;
  const list = (v) => v.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  let eventIndent = null, event = null, key = null;
  for (const l of lines.slice(from + 1)) {
    if (!live(l)) continue;
    const n = indentOf(l), t = l.trim();
    if (n === 0) break;
    eventIndent ??= n;
    if (n === eventIndent) { event = t.replace(/:.*$/, ""); events[event] = {}; key = null; continue; }
    const m = t.match(/^([\w-]+):\s*(.*)$/);
    if (m) { key = m[1]; events[event][key] = list(m[2]); }
    else if (key && t.startsWith("- ")) events[event][key].push(...list(t.slice(2)));
  }
  return events;
}

/** A step that runs the suite must be able to stop its job. */
function assertTestStepGates(step, where) {
  assert.equal(step.run, "npm test", `${where} runs \`${step.run}\` as its test step: only a bare \`npm test\` stops on a failing test`);
  assert.equal(step["continue-on-error"], undefined, `${where}'s test step has continue-on-error: a failing test would not stop it`);
  assert.equal(step.if, undefined, `${where}'s test step has an \`if:\`: it can be skipped`);
}

test("package-lock.json is JSON: no merge-conflict markers", () => {
  const text = read("package-lock.json");
  const markers = text.split("\n").filter((l) => /^(<{7}|={7}|>{7})( |$)/.test(l)).length;
  assert.equal(markers, 0, `package-lock.json holds ${markers} merge-conflict marker line(s)`);
  assert.doesNotThrow(() => JSON.parse(text), "package-lock.json is not valid JSON");
});

test("package-lock.json describes this package.json", () => {
  const lock = json("package-lock.json");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version, "the lockfile's version is not package.json's");
  assert.equal(lock.packages[""].version, pkg.version, "the lockfile's root package is not package.json's version");
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies, "the lockfile was made for other dependencies");
});

test("server.json names the package and the version package.json ships", () => {
  const server = json("server.json");
  assert.equal(server.name, pkg.mcpName, "server.json.name must equal package.json.mcpName (registry validation)");
  assert.equal(server.version, pkg.version, "server.json.version is not package.json's version");
  const npm = (server.packages || []).filter((p) => p.registryType === "npm");
  assert.equal(npm.length, 1, "server.json must list exactly one npm package");
  assert.equal(npm[0].identifier, pkg.name);
  assert.equal(npm[0].version, pkg.version, "server.json's npm package version is not package.json's version");
});

test("publish and CI install exactly the lockfile, and a failed install stops them", () => {
  // Every step that installs: `npm ci` alone, nothing after it that could catch
  // its failure, nothing that hides its error. CI installs the same way, so it
  // tests the tree the release would ship.
  const installsOf = (file) => workflowSteps(file)
    .map((s) => s.run ?? "")
    .filter((cmd) => /\bnpm (ci|install|i)\b/.test(cmd));
  for (const file of [PUBLISH, CI]) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing`);
    const installs = installsOf(file);
    assert.ok(installs.length > 0, `${file} installs nothing: the check below would pass vacuously`);
    for (const cmd of installs) {
      assert.match(cmd, /^npm ci( --[a-z-]+)*$/, `${file} installs with \`${cmd}\`: only a bare \`npm ci\` fails when the lockfile is wrong`);
    }
  }
  assert.deepEqual(installsOf(CI), installsOf(PUBLISH), "ci.yml does not install the way publish.yml does: CI would test a different tree from the one that ships");
});

test("`npm version` moves package.json, package-lock.json and server.json together", () => {
  // The real release step, on a copy: the version hook must rewrite server.json
  // and stage it for the version commit, and npm must be able to update the lock.
  const dir = mkdtempSync(join(tmpdir(), "ateam-mcp-release-"));
  try {
    for (const f of ["package.json", "package-lock.json", "server.json"]) copyFileSync(join(ROOT, f), join(dir, f));
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(ROOT, "scripts", "sync-server-version.mjs"), join(dir, "scripts", "sync-server-version.mjs"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("npm", ["version", "patch", "--no-git-tag-version", "--ignore-scripts=false"], { cwd: dir, stdio: "pipe" });

    const next = json("package.json", dir).version;
    assert.notEqual(next, pkg.version, "npm version did not bump package.json (the checks below would be vacuous)");
    assert.equal(json("package-lock.json", dir).version, next, "npm version left package-lock.json behind");
    const server = json("server.json", dir);
    assert.equal(server.version, next, "npm version left server.json behind");
    assert.equal(server.packages.find((p) => p.registryType === "npm").version, next);
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }).split("\n");
    assert.ok(staged.includes("server.json"), "the version hook did not stage server.json for the version commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish runs the suite between `npm ci` and `npm publish`, in the publishing job", () => {
  const all = workflowSteps(PUBLISH);
  const publishing = all.find((s) => /\bnpm publish\b/.test(s.run ?? ""));
  assert.ok(publishing, "publish.yml has no `npm publish` step: the checks below would pass vacuously");
  // Only a step in the SAME job gates the publish: another job runs beside it.
  const steps = all.filter((s) => s.job === publishing.job);
  const at = (re) => steps.findIndex((s) => re.test(s.run ?? ""));
  const install = at(/^npm ci\b/), suite = at(/\bnpm (run )?test\b/), publish = steps.indexOf(publishing);
  assert.ok(install >= 0, `publish.yml's \`${publishing.job}\` job publishes without \`npm ci\``);
  assert.ok(suite >= 0, `publish.yml's \`${publishing.job}\` job never runs \`npm test\`: a red main publishes`);
  assert.ok(install < suite, "publish.yml runs `npm test` before `npm ci`: it tests a tree it has not installed");
  assert.ok(suite < publish, "publish.yml runs `npm test` after `npm publish`: the package is on npm before a failing test can stop it");
  assertTestStepGates(steps[suite], "publish.yml");
});

test("CI runs the suite on every pull request and every push to main", () => {
  assert.ok(existsSync(join(ROOT, CI)), `${CI} is missing: no workflow runs the suite on a pull request`);
  const on = workflowTriggers(CI);
  assert.ok(on.pull_request, "ci.yml does not trigger on pull_request: a PR merges untested");
  for (const [event, filters] of Object.entries(on)) {
    for (const f of ["paths", "paths-ignore", "branches-ignore"]) {
      assert.equal(filters[f], undefined, `ci.yml filters ${event} by ${f}: a change it filters out is merged untested`);
    }
  }
  const { branches: prTo } = on.pull_request;
  assert.ok(!prTo || prTo.includes("main"), `ci.yml runs on pull requests to [${prTo}] only: a PR to main merges untested`);
  assert.ok(on.push, "ci.yml does not trigger on push: main itself is never tested");
  const { branches: pushed } = on.push;
  assert.ok(!pushed || pushed.includes("main"), `ci.yml runs on pushes to [${pushed}] only: main itself is never tested`);

  const all = workflowSteps(CI);
  const suiteStep = all.find((s) => /\bnpm (run )?test\b/.test(s.run ?? ""));
  assert.ok(suiteStep, "ci.yml never runs `npm test`");
  const steps = all.filter((s) => s.job === suiteStep.job);
  const install = steps.findIndex((s) => /^npm ci\b/.test(s.run ?? ""));
  assert.ok(install >= 0, `ci.yml's \`${suiteStep.job}\` job runs \`npm test\` without \`npm ci\``);
  assert.ok(install < steps.indexOf(suiteStep), "ci.yml runs `npm test` before `npm ci`: it tests a tree it has not installed");
  assertTestStepGates(suiteStep, "ci.yml");
});
