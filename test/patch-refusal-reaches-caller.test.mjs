/**
 * A REFUSED REDEPLOY REACHES ateam_patch's CALLER WITH ITS FILE AND ITS WAY OUT.
 *
 * The Builder refuses a deploy when a file changed on both sides since the
 * Builder and `dev` last agreed, or when the Builder's copy holds `main`
 * content `dev` lacks (DRIFT_DETECTED, with a hint naming the file and how to
 * choose). ateam_patch's redeploy phase kept only the bare reason — "Pre-deploy
 * consistency check failed" — and then told the agent the connector-derived
 * tools "were NOT rebuilt, finish it with ateam_redeploy", which is refused
 * the same way. And the github write's fs_mirror note (the Builder left its
 * own copy of the file alone) was dropped.
 *
 * Drives the real handler with fetch stubbed: github/read → github/patch →
 * redeploy (answered synchronously, refused).
 *
 * Run: node --test test/patch-refusal-reaches-caller.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/tools.js";

const HINT = "skills/walk-guide/skill.json changed on BOTH sides since the Builder and dev last agreed … choose explicitly — dev's copy: ateam_github_pull …";
const NOTE = "Committed, but NOT copied into the Builder: the Builder's copy of skills/walk-guide/skill.json has a change dev did not have …";

async function patchWith({ redeploy, fsMirror }) {
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    seen.push(u);
    let body = { ok: true };
    if (u.includes("/github/read")) body = { ok: true, content: JSON.stringify({ id: "walk-guide", name: "Walk Guide", description: "d" }) };
    else if (u.includes("/github/patch")) body = { ok: true, branch: "dev", ...(fsMirror && { fs_mirror: fsMirror }) };
    else if (u.endsWith("/redeploy")) body = redeploy;
    return {
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => body, text: async () => JSON.stringify(body),
    };
  };
  try {
    return await handlers.ateam_patch({ solution_id: "walkmate", target: "skill", skill_id: "walk-guide", updates: { description: "new" } }, "sid");
  } finally { global.fetch = origFetch; }
}

test("the redeploy phase carries the refusal's code and hint", async () => {
  const r = await patchWith({ redeploy: { ok: false, error: "Pre-deploy consistency check failed", code: "DRIFT_DETECTED", hint: HINT } });
  const phase = r.phases.find((p) => p.phase === "redeploy");
  assert.equal(phase.status, "error");
  assert.equal(phase.code, "DRIFT_DETECTED");
  assert.equal(phase.hint, HINT, "the hint that names the file and the way out was dropped");
});

test("the result says the redeploy was REFUSED and why — not that it merely did not complete", async () => {
  const r = await patchWith({ redeploy: { ok: false, error: "Pre-deploy consistency check failed", code: "DRIFT_DETECTED", hint: HINT } });
  assert.equal(r.ok, false);
  assert.equal(r.patch_persisted, true);
  assert.match(r.error, /redeploy was REFUSED \(DRIFT_DETECTED\)/);
  assert.ok(r.error.includes(HINT), "the error does not carry the way out");
  assert.equal(r.hint, HINT);
  assert.doesNotMatch(r.error, /were NOT rebuilt/, "a refusal was described as an unfinished rebuild");
  assert.match(r._status, /REFUSED/);
});

test("a redeploy that failed without a hint keeps the old sentence (finish it with ateam_redeploy)", async () => {
  const r = await patchWith({ redeploy: { ok: false, error: "Core unreachable" } });
  assert.match(r.error, /redeploy did not complete[\s\S]*ateam_redeploy\(solution_id, skill_id: "walk-guide"\)/);
  assert.equal(r.hint, undefined);
});

test("the github write says when the Builder did NOT take the commit (its own copy had a change of its own)", async () => {
  const r = await patchWith({
    redeploy: { ok: false, error: "Pre-deploy consistency check failed", code: "DRIFT_DETECTED", hint: HINT },
    fsMirror: { ok: true, kind: "skill", mirrored: false, provenance: "diverged", note: NOTE },
  });
  const write = r.phases.find((p) => p.phase === "github_write");
  assert.equal(write.builder_copy, NOTE);
});

test("a clean patch carries no builder_copy note", async () => {
  const r = await patchWith({ redeploy: { ok: true, deployed: 1 }, fsMirror: { ok: true, kind: "skill" } });
  assert.equal(r.phases.find((p) => p.phase === "github_write").builder_copy, undefined);
});
