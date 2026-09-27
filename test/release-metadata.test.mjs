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
 * nothing enforced it. This does, and the last test drives the release step
 * itself (`npm version`) to show the three now move together.
 *
 * Run: node --test test/release-metadata.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p, dir = ROOT) => readFileSync(join(dir, p), "utf8");
const json = (p, dir = ROOT) => JSON.parse(read(p, dir));
const pkg = json("package.json");

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

test("publish installs exactly the lockfile, and a failed install stops it", () => {
  // A workflow cannot run here, so this reads what it runs: every `run:` line
  // that installs. `npm ci` alone, nothing after it that could catch its
  // failure, nothing that hides its error.
  const installs = read(".github/workflows/publish.yml").split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(- )?run:/.test(l) && /\bnpm (ci|install|i)\b/.test(l))
    .map((l) => l.replace(/^(- )?run:\s*/, ""));
  assert.ok(installs.length > 0, "publish.yml installs nothing: the check below would pass vacuously");
  for (const cmd of installs) {
    assert.match(cmd, /^npm ci( --[a-z-]+)*$/, `publish.yml installs with \`${cmd}\`: only a bare \`npm ci\` fails the release when the lockfile is wrong`);
  }
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
