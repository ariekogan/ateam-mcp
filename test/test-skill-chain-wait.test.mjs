// ateam_test_skill wait_for:"chain" RETURNS WHEN THE CHAIN IS DONE, NOT AT ITS TIMEOUT.
//
// The Builder answers the chain as {ok, success, data:{chainJobs}}. The wait read
// the job list at the top of the reply, never found it, and always ran to
// chain_timeout_ms ("Chain wait timed out") even for a test that finished in seconds.
//
// Run: node --test test/test-skill-chain-wait.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const API = "http://builder.test";
setSessionCredentials("sess-chain", { apiKey: "adas_tenanta_00000000000000000000000000000000", apiUrl: API, explicit: true });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("a finished chain in the Builder's real shape ends the wait early", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(String(url));
    if ((opts.method || "GET") === "POST" && pathname.endsWith("/test")) return json({ ok: true, job_id: "job_root" });
    if (pathname.includes("/deploy/jobs/job_root/chain")) {
      return json({ ok: true, success: true, data: { chainJobs: [{ id: "job_root", status: "done" }, { id: "job_b", status: "completed" }] } });
    }
    return json({ ok: false });
  };
  const started = Date.now();
  const out = JSON.parse((await handleToolCall("ateam_test_skill", { solution_id: "sol", skill_id: "s1", message: "hi", wait_for: "chain", chain_timeout_ms: 20000 }, "sess-chain")).content?.[0]?.text ?? "{}");
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.ok(Date.now() - started < 10000, "returned long before chain_timeout_ms");
});
