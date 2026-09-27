// MGAP-A29 and the ateam-mcp half of MGAP-A13: what an agent is told about
// where a UI plugin is declared, and what platform_connectors can hold.
//
// A29. ateam_create_plugin's description (02d4321) and its next_steps (3e7c8c0)
// said "Then declare it at solution ui_plugins[]". The Builder's deploy has
// MERGED what it discovers into solution.ui_plugins[] since 7ebab07
// (2026-05-15, routes/deploy.js {...disc, ...prev}), so following the text
// made a second, hand-copied manifest, and a partial render in it replaced the
// discovered one. Discovery walks platform_connectors and every skill's
// connectors[] (Builder services/pluginDiscovery.js), and never a
// runtime:"device" connector.
//
// A13. bootstrap's platform_connectors note (727cae5) described the array as
// fixed platform services only. The solution schema lets it carry the
// solution's OWN connectors (source:"solution"), and "tools are automatically
// merged into every skill's tool catalog" is not what the Builder enforces: a
// skill reaches a connector's tools through its own connectors[].
//
// create_plugin runs through the real dispatcher against a local stand-in.
//
// Run: node --test test/ui-plugin-merge-texts.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

const SID = "sess-merge-texts";
let server;
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url.split("?")[0];
      // Listed at once, so create_plugin's render check does not wait.
      const reply = path.endsWith("/ui-plugins")
        ? { ok: true, plugins: [{ id: "mcp:demo-mcp:walk", render: { mode: "adaptive", iframeUrl: "/ui/walk/index.html" } }] }
        : { ok: true };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_" + "0".repeat(32), apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

// Each place the merge is described must say MERGE, name the lists discovery
// walks, and never tell the author to declare what discovery fills in.
function assertMergeTold(where, text) {
  assert.doesNotMatch(text, /declare it at solution/i, `${where} still says "declare it": ${text}`);
  assert.match(text, /MERGES/, `${where} does not say the discovered entry is merged`);
  assert.match(text, /platform_connectors or in a skill's connectors\[\]/, `${where}: which connectors are walked`);
  assert.match(text, /runtime:'device'/, `${where}: the one connector kind that is never introspected`);
  assert.match(text, /do not restate render, native or stateDomains/, `${where}: a partial render replaces the discovered one`);
}

test("A29: ateam_create_plugin's description says the discovered entry is MERGED", () => {
  assertMergeTold("description", tools.find((t) => t.name === "ateam_create_plugin").description);
});

test("A29: ateam_create_plugin's next_steps say the same, from a real call", async () => {
  const r = await handleToolCall("ateam_create_plugin", { solution_id: "walkmate", connector_id: "demo-mcp", plugin_name: "walk", kind: "iframe" }, SID);
  assert.ok(!r.isError, r.content[0].text.slice(0, 300));
  assertMergeTold("next_steps", JSON.parse(r.content[0].text).next_steps.join("\n"));
});

test("A13: bootstrap says platform_connectors can hold the solution's own connectors, and how a skill reaches tools", async () => {
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-merge-boot")).content[0].text);
  const pc = boot.platform_connectors;
  assert.match(pc._note, /source: 'solution'/, pc._note);
  assert.match(pc._note, /OWN connectors\[\]/);
  for (const [k, v] of [["_note", pc._note], ["how_to_use.step_2", pc.how_to_use.step_2]]) {
    assert.doesNotMatch(v, /automatically merged into every skill|become available in the skill's tool catalog automatically/i, `${k}: ${v}`);
  }
});
