/**
 * A NEW SKILL INTO A SOLUTION THAT WAS NEVER INITIALIZED IS REFUSED UP FRONT.
 *
 * Seen on dev (cos-dev, 2026-11-02): ateam_patch created "chief-of-staff"
 * while the repo had no solution.json and the Builder no solution. It wrote
 * skill.json, logged the topology step as a non-fatal warning, then failed
 * the redeploy with "Skill not found" — a half-write and an unclear error.
 * Now it refuses before writing anything, naming the first step to take.
 *
 * Run: node --test test/patch-new-skill-needs-solution.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/tools.js";

function reply(status, body) {
  return {
    ok: status < 400, status, statusText: status === 404 ? "Not Found" : "OK",
    headers: { get: () => "application/json" },
    json: async () => body, text: async () => JSON.stringify(body),
  };
}

async function patchWith({ solutionInGithub, solutionInBuilder, otherError }) {
  const origFetch = global.fetch;
  const writes = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (method !== "GET") writes.push(`${method} ${u}`);
    if (u.includes("/github/read") && u.includes("skill.json")) return reply(404, { error: "Not Found" });
    if (u.includes("/github/read") && u.includes("solution.json")) {
      if (otherError) return reply(500, { error: "boom" });
      return solutionInGithub ? reply(200, { content: JSON.stringify({ id: "cos", skills: [] }) }) : reply(404, { error: "Not Found" });
    }
    if (u.includes("/definition")) return solutionInBuilder ? reply(200, { solution: { id: "cos" } }) : reply(404, { error: "Solution cos not found" });
    if (u.match(/\/skills\/chief-of-staff$/) && method === "GET") return reply(404, { error: "Skill not found" });
    if (u.includes("/github/patch")) return reply(200, { ok: true, branch: "dev" });
    if (u.endsWith("/redeploy")) return reply(200, { ok: true, deployed: 1 });
    return reply(200, { ok: true });
  };
  try {
    const r = await handlers.ateam_patch({ solution_id: "cos", target: "skill", skill_id: "chief-of-staff", updates: { description: "d" }, source: "github" }, "sid");
    return { r, writes };
  } finally { global.fetch = origFetch; }
}

test("no solution anywhere → refused with SOLUTION_NOT_INITIALIZED, nothing written", async () => {
  const { r, writes } = await patchWith({ solutionInGithub: false, solutionInBuilder: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, "SOLUTION_NOT_INITIALIZED");
  assert.match(r.hint, /ateam_build_and_run/);
  assert.deepEqual(writes, [], `wrote before refusing: ${writes.join(", ")}`);
});

test("solution exists in GitHub → the new skill is created as before", async () => {
  const { r, writes } = await patchWith({ solutionInGithub: true, solutionInBuilder: false });
  assert.notEqual(r.code, "SOLUTION_NOT_INITIALIZED");
  assert.ok(writes.some((w) => w.includes("/github/patch")), "skill was not written");
});

test("solution only in the Builder → not refused", async () => {
  const { r } = await patchWith({ solutionInGithub: false, solutionInBuilder: true });
  assert.notEqual(r.code, "SOLUTION_NOT_INITIALIZED");
});

test("an unclear read error (500) does not block the patch", async () => {
  const { r } = await patchWith({ otherError: true });
  assert.notEqual(r.code, "SOLUTION_NOT_INITIALIZED");
});
