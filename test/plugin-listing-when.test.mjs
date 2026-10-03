// CHECK A (Run 5, 2026-10-03): WHEN a UI plugin is listed — what the served texts say.
//
// ateam_create_plugin's description said "At deploy, Phase 5 discovers plugins"
// (02d4321), its next step "it renders on the next deploy", the deploy sentence
// "every deploy calls ui.listPlugins" (0f5f4d3), and bootstrap listed
// solution.ui_plugins[] as "Phase 5: MCP introspection" among what the platform
// generates at deploy (2a07c08). An in-app builder read that as "the plugin
// list is only populated during ateam_build_and_run Phase 5 … must promote",
// logged it as a lesson, and every later run read it first.
//
// What the code does today:
//  - Core (cp.listContextPlugins) asks every connected connector the solution
//    uses for its ui.listPlugins LIVE: a running connector's plugin is listed
//    with no deploy and no promote. ateam_create_plugin's own handler relies on
//    it (it polls Core's live catalog after the upload).
//  - The Builder's introspection (pluginDiscovery) writes solution.ui_plugins[]
//    in the full deploy (POST /deploy/solution: ateam_build_and_run) on every
//    run, and in the whole-solution redeploy only while that list is empty. The
//    connector upload and a one-skill redeploy never run it.
//
// Run: node --test test/plugin-listing-when.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

const SID = "sess-plugin-listing-when";
let server;
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url.split("?")[0];
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

const LIVE = /Core lists a running connector's plugins live, so ateam_upload_connector needs no deploy and no promote to show one/;

test("create_plugin's description says Core lists a running connector's plugins live — and no longer says Phase 5 or 'at deploy' discovers them", () => {
  const d = tools.find((t) => t.name === "ateam_create_plugin").description;
  assert.doesNotMatch(d, /Phase 5/, d);
  assert.doesNotMatch(d, /At deploy,/, d);
  assert.doesNotMatch(d, /every deploy calls/, d);
  assert.match(d, LIVE);
  assert.match(d, /ateam_build_and_run's deploy, on every run, calls ui\.listPlugins \+ ui\.getPlugin/);
});

test("create_plugin's next steps say it is listed by the live connector, not 'on the next deploy'", async () => {
  const r = await handleToolCall("ateam_create_plugin", { solution_id: "walkmate", connector_id: "demo-mcp", plugin_name: "walk", kind: "iframe" }, SID);
  assert.ok(!r.isError, r.content[0].text.slice(0, 300));
  const steps = JSON.parse(r.content[0].text).next_steps.join("\n");
  assert.doesNotMatch(steps, /renders on the next deploy/, steps);
  assert.doesNotMatch(steps, /after deploy/, steps);
  assert.match(steps, LIVE);
});

test("bootstrap lists solution.ui_plugins[] as recorded by ateam_build_and_run's deploy, not as a numbered 'Phase 5' — and says when the whole-solution redeploy refills it", async () => {
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, SID)).content[0].text);
  const list = boot.minimal_authoring.platform_generates_at_deploy;
  const line = list.find((l) => /^solution\.ui_plugins\[\]/.test(l));
  assert.ok(line, "bootstrap lost its solution.ui_plugins[] line");
  assert.doesNotMatch(line, /Phase 5/, line);
  assert.match(line, /ateam_build_and_run's deploy on every run/, line);
  assert.match(line, /ateam_redeploy of the whole solution only while the list is empty/, line);
  assert.match(line, LIVE, line);
});
