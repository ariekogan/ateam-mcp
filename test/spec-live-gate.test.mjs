// The default suite must be HERMETIC, and the live check must be able to FAIL.
//
// test/spec-topics.test.mjs compares the topic map against a live deployment.
// It ran inside `npm test` and, when the deployment was unreachable, printed
// "⚠ SKIPPED — this check did NOT run" and exited 0 — so an offline run
// reported ALL CHECKS PASSED, and an online run made `npm test` depend on a
// server someone else deploys. Its own comment said "a check that cannot fail
// is a label"; the exit code disagreed.
//
// Now: the live check runs only when asked for (`--live`, i.e.
// `npm run test:live`), and when asked for and unreachable it FAILS.
// This file proves both halves by running the real test file against a base
// URL nothing listens on.
//
// Run: node --test test/spec-live-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SPEC_TEST = fileURLToPath(new URL("./spec-topics.test.mjs", import.meta.url));
const UNREACHABLE = "http://127.0.0.1:9";   // the discard port — nothing answers

function run(args) {
  const r = spawnSync(process.execPath, [SPEC_TEST, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ATEAM_SPEC_BASE: UNREACHABLE },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("default run: the live check is not attempted, and says how to run it", () => {
  const { status, out } = run([]);
  assert.equal(status, 0, `the hermetic suite failed:\n${out.slice(-800)}`);
  assert.doesNotMatch(out, /could not reach/i, "the default suite still reached for the network");
  assert.match(out, /npm run test:live/, "a skipped live check does not say how to run it");
});

test("--live against an unreachable deployment FAILS, loudly and by name", () => {
  const { status, out } = run(["--live"]);
  assert.notEqual(status, 0, `the live check could not run and still exited 0:\n${out.slice(-800)}`);
  assert.match(out, /SPEC_BASE_UNREACHABLE/, "the failure does not name its cause");
});
