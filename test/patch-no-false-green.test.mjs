/**
 * ateam_patch MUST NOT REPORT SUCCESS WHEN THE REBUILD DID NOT RUN.
 *
 * Changing skill.connectors[] makes the connector-derived half of tools[]
 * stale; only the redeploy rebuilds it. Returning ok:true on a failed redeploy
 * hands back a skill whose declarations and generated tools disagree, labelled
 * done — and the caller stops, because it was told it succeeded.
 *
 * Source-level, deliberately: driving the whole handler needs GitHub, a
 * Builder and a Core. What must be pinned is the CONTRACT, and the contract is
 * one expression.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("ateam_patch: async"), src.indexOf("ateam_validate_skill:"));

describe("no false green between patch and rebuild", () => {
  test("ok is the LIFECYCLE verdict, not the write verdict", () => {
    assert.match(body, /const lifecycleOk = redeployResult === undefined \? true : redeployOk;/,
      "ateam_patch no longer derives ok from whether the redeploy completed");
    assert.match(body, /\n      ok: lifecycleOk,/,
      "the return went back to a hardcoded ok: true");
  });

  test("a failed redeploy still says the edit was kept", () => {
    // The original ok:true existed for a real reason — the patch is not lost.
    // That fact must survive as a field rather than as a wrong verdict.
    assert.match(body, /patch_persisted: true/,
      "a failed rebuild no longer tells the caller the edit was preserved");
    assert.match(body, /ateam_redeploy\(solution_id/,
      "the failure does not name the command that finishes the job");
  });

  test("dry_run is unaffected — it attempts no redeploy", () => {
    assert.match(body, /redeployResult === undefined \? true/,
      "a path that never attempts a redeploy would now report failure");
  });
});
