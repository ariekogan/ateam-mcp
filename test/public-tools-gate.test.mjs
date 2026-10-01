// The auth gate denies by default: a session that has not signed in may call
// only the tools src/publicTools.js lists, whatever else the registry holds.
//
// eb5e007 (2026-03-01) gated an allow-list of tenant tools (TENANT_TOOLS), and
// fifteen tools added later never joined it. On a local (stdio) process with an
// ADAS_API_KEY in its environment — which by design is not a sign-in — they
// ran on that key: CORE reproduced a signed-out session running
// ateam_github_promote, ateam_github_rollback and ateam_github_write.
//
// The registry is enumerated, not hand-listed, so a tool added tomorrow is
// covered without anyone remembering this file.
//
// Run: node --test test/public-tools-gate.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// The env fallback the gate must not honour, set before api.js reads it.
process.env.ADAS_API_KEY = `adas_prod_acme_${"0".repeat(32)}`;
const { isAuthenticated, isExplicitlyAuthenticated, runToolCall } = await import("../src/api.js");
const { tools, handlers, handleToolCall } = await import("../src/tools.js");
const { PUBLIC_TOOLS } = await import("../src/publicTools.js").catch(() => ({}));

const sent = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url) => {
    sent.push(String(url));
    return new Response(JSON.stringify({ ok: true, solutions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});
after(() => { globalThis.fetch = realFetch; });

// Every name a caller can invoke: the advertised registry and the handler table.
const registry = [...new Set([...tools.map((t) => t.name), ...Object.keys(handlers)])];
// Enough arguments to get past each handler's own argument checks, so a tool
// the gate lets through would reach the network and be seen doing so.
const ARGS = { solution_id: "acme-sol", skill_id: "a-skill", connector_id: "a-conn", path: "x.js", content: "x", goal: "x", tenant: "acme" };

test("the public list is the one list, and every entry is a real tool", () => {
  assert.ok(PUBLIC_TOOLS instanceof Set, "no PUBLIC_TOOLS in src/publicTools.js");
  for (const name of PUBLIC_TOOLS) assert.ok(registry.includes(name), `PUBLIC_TOOLS names ${name}, which is not a tool`);
});

test("signed out, with ADAS_API_KEY in the environment: every tool not on the public list is refused before it runs", async () => {
  assert.ok(PUBLIC_TOOLS instanceof Set, "no PUBLIC_TOOLS in src/publicTools.js");
  const ran = [];
  for (const name of registry.filter((n) => !PUBLIC_TOOLS.has(n))) {
    const sid = `sess-gate-${name}`;
    sent.length = 0;
    const r = await runToolCall(sid, () => handleToolCall(name, { ...ARGS }, sid), { transport: "stdio" });
    assert.ok(isAuthenticated(sid) && !isExplicitlyAuthenticated(sid), "the env-key fallback is not in place, so this proves nothing");
    if (r.structuredContent?.stage !== "auth_gate" || sent.length > 0) ran.push(`${name}${sent.length ? ` (sent ${sent.length} request(s))` : ""}`);
  }
  assert.deepEqual(ran, [], `ran signed out, on the env key:\n${ran.join("\n")}`);
});

test("(control) the public tools are not refused by the gate", async () => {
  assert.ok(PUBLIC_TOOLS instanceof Set, "no PUBLIC_TOOLS in src/publicTools.js");
  for (const name of PUBLIC_TOOLS) {
    const sid = `sess-public-${name}`;
    const r = await runToolCall(sid, () => handleToolCall(name, { topic: "overview", type: "skill", query: "x", skill: {}, solution: {} }, sid), { transport: "stdio" });
    assert.notEqual(r.structuredContent?.stage, "auth_gate", `${name} is public but was refused at the gate`);
  }
});

test("signed out, bootstrap does not list the env key's workspace", async () => {
  sent.length = 0;
  const boot = JSON.parse((await runToolCall("sess-gate-boot", () => handleToolCall("ateam_bootstrap", {}, "sess-gate-boot"), { transport: "stdio" })).content[0].text);
  assert.equal(boot.tenant_onboarding, undefined, "bootstrap read the env key's solutions for a session that is not signed in");
  assert.ok(!sent.some((u) => u.includes("/deploy/solutions")), `it asked: ${sent.join(", ")}`);
});
