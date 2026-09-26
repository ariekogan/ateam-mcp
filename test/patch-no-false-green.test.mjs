/**
 * ateam_patch MUST NOT REPORT SUCCESS WHEN THE REBUILD DID NOT RUN.
 *
 * Changing skill.connectors[] makes the connector-derived half of tools[]
 * stale; only the redeploy rebuilds it. Returning ok:true on a failed redeploy
 * hands back a skill whose declarations and generated tools disagree, labelled
 * done — and the caller stops, because it was told it succeeded.
 *
 * WHY THIS FILE IS NOW BEHAVIOURAL. It used to pin one expression by regex:
 * `lifecycleOk = redeployResult === undefined ? true : redeployOk`. That
 * expression WAS the bug. `redeployResult` is undefined only when the redeploy
 * THREW — a timeout, a 5xx, a dropped socket — because dry_run returns long
 * before it (the "dry_run is unaffected" case it claimed to protect never
 * reaches the line). So the one failure the fix (daf254a) was written for came
 * back ok:true, and this test insisted it stay that way.
 *
 * Now it drives the real tool through handleToolCall with fetch stubbed:
 * github/read → github/patch → redeploy, the redeploy answered each way.
 *
 * Run: node --test test/patch-no-false-green.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const SID = "sess-patch-no-false-green";
setSessionCredentials(SID, {
  apiKey: "adas_tenanta_00000000000000000000000000000000",
  apiUrl: "http://builder.stub.invalid",
  explicit: true,
});

const json = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => "application/json" },
  json: async () => body, text: async () => JSON.stringify(body),
});

/**
 * @param {(url: string) => any} redeploy  answers the redeploy POST: a
 *   response object, or throws to play a dropped connection
 */
async function patchWith(redeploy) {
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/github/read")) return json(200, { ok: true, content: JSON.stringify({ id: "walk-guide", name: "Walk Guide", description: "d" }) });
    if (u.includes("/github/patch")) return json(200, { ok: true, branch: "dev" });
    if (u.endsWith("/redeploy")) return redeploy(u);
    return json(200, { ok: true });
  };
  try {
    const r = await handleToolCall("ateam_patch",
      { solution_id: "walkmate", target: "skill", skill_id: "walk-guide", updates: { description: "new" } }, SID);
    return { r, out: JSON.parse(r.content[0].text), seen };
  } finally { global.fetch = origFetch; }
}

test("a redeploy that THREW (the Builder answered 500) is not a successful patch", async () => {
  const { r, out, seen } = await patchWith(() => json(500, { error: "Core unreachable" }));
  assert.ok(seen.some((u) => u.endsWith("/redeploy")), "the redeploy was never attempted — the test proves nothing");
  assert.equal(out.ok, false, "a patch whose rebuild threw came back ok:true");
  assert.equal(out.patch_persisted, true, "the failure no longer says the edit was kept");
  assert.equal(out.phase, "redeploy");
  assert.match(out.error, /redeploy did not complete[\s\S]*ateam_redeploy\(solution_id, skill_id: "walk-guide"\)/,
    "the failure does not name the command that finishes the job");
  assert.equal(out.phases.find((p) => p.phase === "redeploy")?.status, "timeout_or_error");
  assert.equal(r.isError, true, "the dispatcher did not flag the failed lifecycle");
  assert.doesNotMatch(out._status, /✅ Patched on GitHub \+ redeployed/);
});

test("a redeploy whose connection DROPPED (fetch threw) is not a successful patch", async () => {
  const { r, out } = await patchWith(() => { throw new TypeError("fetch failed"); });
  assert.equal(out.ok, false, "a patch whose rebuild never answered came back ok:true");
  assert.equal(out.patch_persisted, true);
  assert.equal(r.isError, true);
});

test("a redeploy that completed is a successful patch", async () => {
  const { r, out } = await patchWith(() => json(200, { ok: true, deployed: 1 }));
  assert.equal(out.ok, true);
  assert.equal(out.patch_persisted, undefined, "a clean patch carries the failure-only field");
  assert.equal(r.isError, undefined);
  assert.match(out._status, /Patched on GitHub \+ redeployed/);
});

test("a redeploy that answered FAILED is not a successful patch", async () => {
  const { out } = await patchWith(() => json(200, { ok: false, error: "Core unreachable" }));
  assert.equal(out.ok, false);
  assert.equal(out.patch_persisted, true);
});

test("dry_run attempts no redeploy and is not a failure", async () => {
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/github/read")) return json(200, { ok: true, content: JSON.stringify({ id: "walk-guide", name: "Walk Guide" }) });
    return json(200, { ok: true });
  };
  try {
    const r = await handleToolCall("ateam_patch",
      { solution_id: "walkmate", target: "skill", skill_id: "walk-guide", updates: { description: "new" }, dry_run: true }, SID);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.ok, true);
    assert.equal(out.dry_run, true);
    assert.ok(!seen.some((u) => u.endsWith("/redeploy")), "dry_run redeployed");
    assert.equal(r.isError, undefined);
  } finally { global.fetch = origFetch; }
});
