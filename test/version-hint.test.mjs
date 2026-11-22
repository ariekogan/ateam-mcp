/**
 * THE SOLUTION VERSION'S SOFT HINTS (Arie, 2026-11-22): X.Y.Z of what runs. After ten deploys since the last promote
 * (Z >= 10) a deploy's answer recommends promoting dev to prod; after ten promotes since the last major (Y >= 10) it
 * offers the next major, in Arie's words. Only hints: nothing blocks, and X moves only through
 * ateam_switch_major_version, on the user's yes.
 *
 * Run: node --test test/version-hint.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionHint, deployedVersionOf } from "../src/versionHint.js";
import { handlers, tools as TOOLS, TOOL_SAFETY, toolExposure } from "../src/tools.js";

test("nothing to say below ten deploys and ten promotes", () => {
  for (const v of ["0.1.0", "1.9.9", "1.2.3", "0.9.0"]) assert.equal(versionHint(v, "s"), null, v);
  for (const v of [null, undefined, "beta", "1.0", 7]) assert.equal(versionHint(v, "s"), null, String(v));
});

test("Z reaches 10: recommend promoting dev to prod, in Arie's words", () => {
  const h = versionHint("1.7.10", "jaisos");
  assert.match(h.promote, /"Current version is 1\.7\.10, I recommend promoting dev to prod\."/);
  assert.match(h.promote, /nothing is blocked/);
  assert.equal(h.major, undefined);
  assert.ok(versionHint("1.7.57", "jaisos").promote, "and on every deploy after it");
});

test("Y reaches 10: offer the next major, and say how to switch only on a yes", () => {
  const h = versionHint("1.10.3", "jaisos");
  assert.equal(h.major.ask, "Current solution version is 1.10.3. Do you want to switch it to 2.0.0?");
  assert.equal(h.major.to, "2.0.0");
  assert.match(h.major.how, /Only on their yes: ateam_switch_major_version\(\{ solution_id: "jaisos", to: "2\.0\.0" \}\)/);
  assert.equal(h.promote, undefined);
  const both = versionHint("3.12.15", "s");
  assert.ok(both.promote && both.major, "both at once");
  assert.equal(both.major.to, "4.0.0");
});

test("the version is read from the answer, or from the redeploy ateam_patch ran", () => {
  assert.equal(deployedVersionOf({ version: { moved: true, version: "0.2.4" } }), "0.2.4");
  assert.equal(deployedVersionOf({ redeploy: { version: { version: "0.2.5" } } }), "0.2.5");
  assert.equal(deployedVersionOf({ version: "0.2.4" }), null, "a solution file's own version field is not the deployed one");
  assert.equal(deployedVersionOf({ version: { moved: false, reason: "no secret" } }), null);
  assert.equal(deployedVersionOf(null), null);
});

test("ateam_switch_major_version: listed, destructive, seen by every agent, and it posts `to` to the Builder", async () => {
  const def = TOOLS.find((t) => t.name === "ateam_switch_major_version");
  assert.ok(def, "the tool is listed");
  assert.deepEqual(def.inputSchema.required, ["solution_id", "to"]);
  assert.match(def.description, /Never call it on your own/);
  assert.ok(TOOL_SAFETY.destructive.includes("ateam_switch_major_version"));
  assert.equal(toolExposure.get("ateam_switch_major_version"), "all");
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const body = { ok: true, version: "2.0.0", previous: "1.9.57", changed: true };
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const out = await handlers.ateam_switch_major_version({ solution_id: "jaisos", to: "2.0.0" }, "sid");
    assert.equal(out.version, "2.0.0");
  } finally { global.fetch = orig; }
  const call = seen.find((r) => r.url.includes("/version/major"));
  assert.ok(call, JSON.stringify(seen.map((r) => r.url)));
  assert.ok(call.url.endsWith("/deploy/solutions/jaisos/version/major"));
  assert.deepEqual(call.body, { to: "2.0.0" });
});
