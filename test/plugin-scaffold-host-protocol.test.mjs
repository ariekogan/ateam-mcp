// The iframe plugin ateam_create_plugin scaffolds must speak the protocol the
// HOST reads — RUN5-16 (ateam-mcp half).
//
// Run 5's dashboard had dead buttons on web and phone. The scaffold every
// author starts from sent { type:"adas-plugin", action:"mcpCall", ... } (flat,
// no connectorId) and listened for a top-level type:"adas-host". The host reads
// message.action "mcp-call" under source "adas-plugin" and replies under
// source "adas-host": it dropped every message, nothing errored, and the
// button sat there with no timeout and no result. Unchanged from ae85a46
// (2026-05-12) to this fix.
//
// THE HOST. Core is read-only here. This test runs the generated page against
//
//   (1) HOST DOUBLE — a faithful reproduction of the host's side, with the Core
//       line of each rule beside it (packages/widget-surface/src/, Core
//       0bbefc575). It always runs, CI included.
//   (2) THE REAL BRIDGE — Core's own attachHostBridge + mcpProxy, imported from
//       a Core checkout, driven by the same scenarios. It runs when
//       ADAS_CORE_WIDGET_SURFACE_DIR names that src/ directory and is SKIPPED,
//       loudly, when it does not: the double is only as good as the last run
//       against the real thing. Run it before changing the double.
//
// Every scenario runs against both. What the page does is the thing checked:
// the page is the uploaded index.html, executed.
//
// Run: node --test test/plugin-scaffold-host-protocol.test.mjs
//      ADAS_CORE_WIDGET_SURFACE_DIR=<Core>/packages/widget-surface/src node --test test/plugin-scaffold-host-protocol.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import vm from "node:vm";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, coreTools, _widgetProtocolProblems } from "../src/tools.js";
import { createOnlyAnswer } from "./create-only-stand-in.mjs";

const SID = "sess-scaffold-host";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const SCAFFOLD_CONNECTOR = "demo-mcp";
const HOST_CONNECTOR = "host-says-mcp";   // differs on purpose: the id must come from init
const PLUGIN = "walk";
let server;
let html = "";
let created;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      let reply = { ok: true };
      if (req.method === "POST" && path.endsWith("/upload")) {
        const sent = JSON.parse(body || "{}");
        const f = (sent.files || []).find((x) => x.path === `ui-dist/${PLUGIN}/index.html`);
        if (f) html = f.content;
        reply = { ok: true, tools: 1, ...createOnlyAnswer(sent) };
      } else if (path.endsWith("/ui-plugins")) {
        reply = { ok: true, plugins: [{ id: `mcp:${SCAFFOLD_CONNECTOR}:${PLUGIN}`, render: { mode: "adaptive", iframeUrl: `/ui/${PLUGIN}/index.html` } }] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
  const r = await handleToolCall("ateam_create_plugin", { solution_id: "walkmate", connector_id: SCAFFOLD_CONNECTOR, plugin_name: PLUGIN, kind: "iframe" }, SID);
  assert.ok(!r.isError, `ateam_create_plugin failed: ${r.content?.[0]?.text?.slice(0, 300)}`);
  assert.ok(html, "ateam_create_plugin uploaded no ui-dist/<plugin>/index.html");
  created = JSON.parse(r.content[0].text);
});
after(() => server.close());

// ─── The tool API behind the host: POST /api/connectors/:id/call ─────────────
// Core apps/backend/routes/connectors.js:489-512. A tool that flags isError
// comes back { ok:false, tool_error:true, error, result }; a tool that merely
// ANSWERS { ok:false } in its text body comes back { ok:true, result } — "NOT a
// failure by this reading" (utils/parseConnectorResult.js toolFailure).
const textResult = (body, extra = {}) => ({ content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }], ...extra });
const answers = {
  ok: (body) => ({ ok: true, result: textResult(body) }),
  isError: (text) => ({ ok: false, tool_error: true, error: text, result: textResult(text, { isError: true }) }),
  never: () => new Promise(() => {}),
};

function makeApi(respond) {
  const calls = [];
  return { calls, call: async (connectorId, tool, args) => { calls.push(JSON.parse(JSON.stringify({ connectorId, tool, args }))); return respond(connectorId, tool, args); } };   // plain copy: args may come from the page's realm
}

// What the host pushes into a plugin for a server command: WidgetSurface.jsx:176-196
// (dispatchToIframe) — it carries BOTH conventions, type and action; the phone's
// usePluginBridge.ts dispatchToWebView sends the type form.
const commandMessage = ({ command, args, correlationId }) => ({
  source: "adas-host", pluginId: PLUGIN,
  message: { type: "plugin.command", action: "plugin.command", payload: { command, args, data: undefined, correlationId } },
});

// ─── Host 1: the double ──────────────────────────────────────────────────────
function makeHostDouble(api) {
  let toPlugin = () => {};
  const commandResults = [];
  const reply = (requestId, result, error) =>
    toPlugin({ source: "adas-host", message: { type: "mcp-result", payload: { requestId, result, error } } });   // mcpProxy.js:80-83
  async function handleMcpCall(payload) {
    const { requestId, args: callArgs } = payload;                                                               // mcpProxy.js:17
    const connectorId = payload.connectorId || callArgs?.params?.connectorId || callArgs?.connectorId;           // :19
    const tool = payload.tool || callArgs?.params?.tool || callArgs?.tool;                                       // :20
    const toolArgs = payload.args || callArgs?.params?.args || callArgs?.args || {};                             // :21
    if (!connectorId || !tool) { reply(requestId, null, "Missing connectorId or tool"); return; }                // :26-31
    const data = await api.call(connectorId, tool, toolArgs);                                                    // :41-46
    if (data.ok) reply(requestId, data.result, null);                                                            // :48-51
    else reply(requestId, data.result ?? null, data.error || "MCP call failed");                                 // :60-63
  }
  return {
    attach(deliver) { toPlugin = deliver; },
    fromPlugin(d) {
      d = d || {};
      if (d.source !== "adas-plugin") return;                                                                    // attachHostBridge.js:42
      const action = d.message?.action || d.action;                                                              // :45
      const payload = d.message?.payload || d.payload;                                                           // :46
      if (action === "mcp-call" && payload?.requestId) handleMcpCall(payload);                                   // :56
      const type = d.message?.type || d.type;                                                                    // :47
      if (type === "plugin.command.result" && payload?.correlationId) commandResults.push(JSON.parse(JSON.stringify(payload)));   // :50
    },
    commandResults,
    sendCommand: (cmd) => toPlugin(commandMessage(cmd)),
    // WidgetSurface.jsx:248-259 — init carries the connector's id.
    sendInit: (connectorId) => toPlugin({ source: "adas-host", pluginId: PLUGIN, message: { type: "init", payload: { tenant: "t", token: "", connectorId, mcpEndpoint: null, selectedJobId: null } } }),
    async done() {},
  };
}

// ─── Host 2: Core's own bridge ───────────────────────────────────────────────
const CORE_DIR = process.env.ADAS_CORE_WIDGET_SURFACE_DIR;
const realAvailable = !!CORE_DIR && existsSync(`${CORE_DIR}/attachHostBridge.js`);

async function makeRealHost(api) {
  globalThis.window = { location: { origin: "http://localhost:3102" } };
  globalThis.fetch = async (url, opts) => {
    const connectorId = decodeURIComponent(/\/api\/connectors\/([^/]+)\/call/.exec(url)[1]);
    const { tool, args } = JSON.parse(opts.body);
    const data = await api.call(connectorId, tool, args);
    return { status: 200, json: async () => data };
  };
  const { attachHostBridge } = await import(pathToFileURL(`${CORE_DIR}/attachHostBridge.js`).href);
  let toPlugin = () => {};
  let listener;
  const contentWindow = { postMessage: (m) => toPlugin(m) };
  const iframeRef = { current: { contentWindow, src: "http://localhost:3102/mcp-ui/t/c/p/index.html" } };
  const commandResults = [];
  attachHostBridge({
    iframeRef, getToken: () => "tok",
    targetWindow: { addEventListener: (_t, fn) => { listener = fn; }, removeEventListener() {} },
    // WidgetSurface.jsx wires onCommandResult to sendCommandResult; here it records.
    handlers: { onCommandResult: (payload) => commandResults.push(JSON.parse(JSON.stringify(payload))) },
  });
  return {
    attach(deliver) { toPlugin = deliver; },
    fromPlugin: (d) => listener({ source: contentWindow, data: d }),
    commandResults,
    sendCommand: (cmd) => toPlugin(commandMessage(cmd)),
    // sendInit builds the same message WidgetSurface.jsx:248-259 posts.
    sendInit: (connectorId) => toPlugin({ source: "adas-host", pluginId: PLUGIN, message: { type: "init", payload: { tenant: "t", token: "", connectorId, mcpEndpoint: null, selectedJobId: null } } }),
    async done() {},
  };
}

// ─── Run the generated page ──────────────────────────────────────────────────
// The page's <script type="module"> executed in a context that has a window
// whose parent is the host, a DOM of two elements, and timers the test fires.
function runPage(host, pageHtml = html) {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(pageHtml)?.[1];
  assert.ok(script, "the scaffold has no <script type=\"module\">");
  const listeners = [];
  const timers = new Map();
  let nextTimer = 1;
  const elements = {};
  const element = () => ({
    textContent: "", style: {}, handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
  });
  const window = {
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    parent: { postMessage: (data) => host.fromPlugin(data) },
  };
  const ctx = vm.createContext({
    window,
    document: { getElementById: (id) => (elements[id] ||= element()) },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  host.attach((data) => { for (const fn of listeners) fn({ data, source: window.parent }); });
  vm.runInContext(script, ctx);
  return {
    output: elements.output,
    click: () => elements.callTool.handlers.click(),
    timers,
  };
}

// A click that never settles must FAIL the scenario, not hang the run: that is
// exactly how the old scaffold behaved (no reply, no timeout, no result).
const settles = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("the click never settled: the user is left with a button that does nothing and nothing on screen")), 1500).unref()),
]);

// Silence the real bridge's console tracing for the duration of one scenario.
async function quiet(fn) {
  const keep = [console.log, console.debug, console.error];
  console.log = console.debug = console.error = () => {};
  try { return await fn(); } finally { [console.log, console.debug, console.error] = keep; }
}

// A widget that answers plugin.command, correct and broken. The reply is the
// only thing that differs between them.
const commandPage = (reply) => `<html><body><script type="module">
  window.addEventListener("message", (e) => {
    const m = e.data && e.data.message;
    if (e.data && e.data.source === "adas-host" && m && m.type === "plugin.command") {
      const cid = m.payload.correlationId;
      ${reply}
    }
  });
</script></body></html>`;
const replyWith = (message) => `window.parent.postMessage({ source: "adas-plugin", message: ${message} }, "*");`;
const COMMAND_PAGES = [
  ["correct reply", commandPage(replyWith(`{ type: "plugin.command.result", payload: { correlationId: cid, result: { shown: m.payload.command } } }`)), false],
  ["reply keyed by requestId", commandPage(replyWith(`{ type: "plugin.command.result", payload: { requestId: cid, result: { shown: m.payload.command } } }`)), true],
  ["reply with no id", commandPage(replyWith(`{ type: "plugin.command.result", payload: { result: { shown: m.payload.command } } }`)), true],
  ["reply sent as action", commandPage(replyWith(`{ action: "plugin.command.result", payload: { correlationId: cid, result: { shown: m.payload.command } } }`)), true],
];

const hosts = [
  ["host double", (api) => makeHostDouble(api)],
  ["Core's real bridge", (api) => makeRealHost(api)],
];

for (const [label, makeHost] of hosts) {
  const skip = label === "Core's real bridge" && !realAvailable
    ? "ADAS_CORE_WIDGET_SURFACE_DIR is not set to Core's packages/widget-surface/src: the double alone ran"
    : false;

  test(`[${label}] a button call reaches the host as mcp-call with the connectorId from init, and the reply settles it`, { skip }, async () => {
    await quiet(async () => {
      const api = makeApi(() => answers.ok({ ok: true, echo: "hello" }));
      const host = await makeHost(api);
      const sent = [];
      const realFrom = host.fromPlugin;
      host.fromPlugin = (d) => { sent.push(JSON.parse(JSON.stringify(d))); return realFrom(d); };   // plain objects: d came from the page's own realm
      const page = runPage(host);
      host.sendInit(HOST_CONNECTOR);
      await settles(page.click());

      assert.equal(sent.length, 1, "the page sent no message to the host");
      assert.equal(sent[0].source, "adas-plugin");
      assert.equal(sent[0].message.action, "mcp-call");
      assert.match(sent[0].message.payload.requestId, /^\S+$/);
      assert.deepEqual({ ...sent[0].message.payload, requestId: "-" },
        { requestId: "-", connectorId: HOST_CONNECTOR, tool: `${SCAFFOLD_CONNECTOR}.echo`, args: { message: "hello" } });
      assert.deepEqual(api.calls, [{ connectorId: HOST_CONNECTOR, tool: `${SCAFFOLD_CONNECTOR}.echo`, args: { message: "hello" } }],
        "the host did not route the call to the connector tool");
      assert.deepEqual(JSON.parse(page.output.textContent), { ok: true, echo: "hello" }, "the tool's own answer is not what the user sees");
      assert.ok(!page.output.style.color, "a success is shown as an error");
    });
  });

  test(`[${label}] an MCP-wrapped answer, wrapped twice, is unwrapped to the tool's own body`, { skip }, async () => {
    await quiet(async () => {
      const inner = textResult({ ok: true, rows: [1, 2] });
      const host = await makeHost(makeApi(() => answers.ok(inner)));
      const page = runPage(host);
      host.sendInit(HOST_CONNECTOR);
      await settles(page.click());
      assert.deepEqual(JSON.parse(page.output.textContent), { ok: true, rows: [1, 2] });
    });
  });

  test(`[${label}] with no reply the call times out and the user is told`, { skip }, async () => {
    await quiet(async () => {
      const host = await makeHost(makeApi(() => answers.never()));
      const page = runPage(host);
      host.sendInit(HOST_CONNECTOR);
      const clicked = page.click();
      await new Promise((r) => setImmediate(r));
      assert.equal(page.timers.size, 1, "the call armed no timeout: a silent host hangs the button forever");
      const [{ fn, ms }] = page.timers.values();
      assert.ok(ms > 0 && ms <= 60_000, `the timeout is ${ms}ms`);
      fn();
      await settles(clicked);
      assert.match(page.output.textContent, /^Error: no reply from the host to demo-mcp\.echo within \d+s$/);
      assert.equal(page.output.style.color, "#b00020", "a timeout is not shown as an error");
    });
  });

  test(`[${label}] a tool that answers {ok:false} without isError is shown as an error, with its own reason`, { skip }, async () => {
    await quiet(async () => {
      // Arrives as a SUCCESS: { ok:true, result:{ content:[{ text:'{"ok":false,...}' }] } }.
      const host = await makeHost(makeApi(() => answers.ok({ ok: false, error: "no such record" })));
      const page = runPage(host);
      host.sendInit(HOST_CONNECTOR);
      await settles(page.click());
      assert.equal(page.output.textContent, "Error: no such record");
      assert.equal(page.output.style.color, "#b00020");
    });
  });

  test(`[${label}] a tool that flags isError is shown as an error, with the tool's text`, { skip }, async () => {
    await quiet(async () => {
      const host = await makeHost(makeApi(() => answers.isError("MCP error -32602: bad input")));
      const page = runPage(host);
      host.sendInit(HOST_CONNECTOR);
      await settles(page.click());
      assert.equal(page.output.textContent, "Error: MCP error -32602: bad input");
      assert.equal(page.output.style.color, "#b00020");
    });
  });

  // The linter's verdict on a command widget must be the host's: the page the
  // linter passes is answered, the pages it flags are not.
  for (const [name, page, flagged] of COMMAND_PAGES) {
    test(`[${label}] command widget, ${name}: ${flagged ? "the host drops the reply, and the linter flags it" : "the host takes the reply, and the linter passes it"}`, { skip }, async () => {
      await quiet(async () => {
        const host = await makeHost(makeApi(() => answers.ok({ ok: true })));
        runPage(host, page);
        host.sendCommand({ command: "show_item", args: { id: 7 }, correlationId: "corr_1" });
        if (flagged) {
          assert.deepEqual(host.commandResults, [], "the host took a reply the linter says it cannot match");
          assert.ok(_widgetProtocolProblems(page).length > 0, "the host drops this reply and the linter passes it");
        } else {
          assert.deepEqual(host.commandResults, [{ correlationId: "corr_1", result: { shown: "show_item" } }],
            "the host did not match the reply to the command");
          assert.deepEqual(_widgetProtocolProblems(page), [], "the host answers this widget and the linter flags it");
        }
      });
    });
  }

  test(`[${label}] an isError result that arrives as a success (a Core older than 2026-09-27) is still shown as an error`, { skip }, async () => {
    await quiet(async () => {
      // Core connectors.js answered { ok:true, result } for a tool that flagged isError until 2026-09-27.
      const host = await makeHost(makeApi(() => ({ ok: true, result: textResult("tool refused: out of range", { isError: true }) })));
      const page = runPage(host);
      host.sendInit(HOST_CONNECTOR);
      await settles(page.click());
      assert.equal(page.output.textContent, "Error: tool refused: out of range");
      assert.equal(page.output.style.color, "#b00020");
    });
  });

  test(`[${label}] a click before the host's init says so, and sends nothing`, { skip }, async () => {
    await quiet(async () => {
      const api = makeApi(() => answers.ok({ ok: true }));
      const host = await makeHost(api);
      const sent = [];
      const realFrom = host.fromPlugin;
      host.fromPlugin = (d) => { sent.push(JSON.parse(JSON.stringify(d))); return realFrom(d); };   // plain objects: d came from the page's own realm
      const page = runPage(host);
      await settles(page.click());
      assert.match(page.output.textContent, /^Error: no connectorId: the host has not sent its init message/);
      assert.deepEqual(sent, [], "a call without a connectorId was sent to the host");
    });
  });
}

// ─── The scaffold is judged by the same linter that judges deployed widgets ──
test("the scaffold's own page lints clean — and says nothing the host does not read", () => {
  assert.deepEqual(_widgetProtocolProblems(html), []);
  assert.doesNotMatch(html, /type:\s*"adas-plugin"/, "the page still signs itself with type");
  assert.doesNotMatch(html, /action:\s*"ready"/, "the page still sends a 'ready' message no host reads");
});

// ─── What the tool says about itself ─────────────────────────────────────────
// create_plugin said "iframe for web-only" (ae85a46, 2026-05-12) while the
// served spec says an iframe plugin is not web-only: the web renders it in an
// iframe and the phone in a WebView (Builder uiPluginRules.js IFRAME_MODE,
// #106 round 2; Core renders `iframeUrl` on web, the mobile app mounts
// EmbeddedPluginWebView for it). Two answers to one question.
test("create_plugin does not call an iframe plugin web-only — it runs on the phone's WebView too", () => {
  const { description } = coreTools.find((t) => t.name === "ateam_create_plugin");
  assert.doesNotMatch(description, /web[- ]only/i);
  assert.match(description, /'iframe' = HTML \(web \+ phone WebView\)/);
  assert.match(description, /'rn' = native \(phone only\)/);
});

// "it will render" was said (b3205aa, 2026-07-18) of a plugin Core merely LISTS
// with a render block. It checks the catalog entry, not that a button reaches
// the host — which is the thing that was dead.
test("create_plugin says what it checked: the catalog entry, not that the page works", () => {
  assert.equal(created.verified.renders, true, "the stand-in catalog lists the plugin: the verify step should see it");
  assert.doesNotMatch(created.verified.note, /will render/i);
  assert.match(created.verified.note, /catalog entry/);
  assert.match(created.verified.note, /ateam_verify_surface/);
});
