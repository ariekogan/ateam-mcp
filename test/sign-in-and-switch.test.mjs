// Which workspace a session is on, how to sign in, and how to switch — ONE
// statement (src/signInSteps.js), rendered word for word where it is read.
//
// A session on the hosted connector was signed in to one workspace while the
// user needed another. The user pasted a key into the chat (the agent rightly
// refused it), and neither of them could tell which workspace the session was
// on or how to change it. 0f5f4d3 (MGAP-A1) had said how to sign in; nothing
// said where a session was or how to move.
//
// Also pinned here: a served text names production only (Arie, 2026-10-01 —
// the package is public), while a dev key still routes exactly as before.
//
// The shared module is loaded dynamically so that, on a tree without it, each
// test fails on its own assertion rather than the file failing to load.
//
// Run: node --test test/sign-in-and-switch.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KEY_ENVIRONMENTS, formatError, getBaseUrl, servedBy, baseUrlForKeyEnv } from "../src/api.js";
import * as api from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

const steps = await import("../src/signInSteps.js").catch(() => ({}));
const server = await import("../src/server.js").catch(() => ({}));
const oauth = await import("../src/oauth.js").catch(() => ({}));
const shared = (name) => {
  assert.equal(typeof steps[name], "string", `no shared ${name} in src/signInSteps.js`);
  return steps[name];
};

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HEX = "0".repeat(32);
const PROD_KEY = `adas_prod_acme_${HEX}`;
const DEV_KEY = `adas_dev_acme_${HEX}`;

// One stub for every request: who was asked, and an answer per path.
const asked = [];
const realFetch = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const stub = async (url) => {
  const u = new URL(String(url));
  asked.push(u);
  if (u.pathname === "/deploy/solutions/ateam-mcp-test/definition") {
    // The Builder's own answer for a solution this tenant does not have:
    // code + a specific hint naming what IS here (utils/solutionNotFound.js).
    return json(404, { ok: false, code: "SOLUTION_NOT_FOUND", error: 'No solution "ateam-mcp-test" in tenant "acme".', hint: 'This tenant has exactly ONE solution: "walk-guide-hud" — use that id from now on.' });
  }
  return json(200, { solutions: [] });
};
before(() => { globalThis.fetch = stub; });
after(() => { globalThis.fetch = realFetch; });

const signIn = async (sid, key) => {
  const r = await handleToolCall("ateam_auth", { api_key: key }, sid);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.ok, true, r.content[0].text);
  return out;
};
const bootstrap = async (sid) => JSON.parse((await handleToolCall("ateam_bootstrap", {}, sid)).content[0].text);

// ─── 1. Where the session is, first ─────────────────────────────────────────

test("bootstrap, signed in: it opens with the workspace and the environment, then how to switch", async () => {
  await signIn("sess-sw-in", PROD_KEY);
  const boot = await bootstrap("sess-sw-in");
  assert.equal(Object.keys(boot)[0], "session", `bootstrap opens with ${Object.keys(boot)[0]}, not where the session is`);
  assert.ok(boot.session?.startsWith('You are signed in to workspace "acme" (prod).'), `opening: ${boot.session}`);
  assert.ok(boot.session.includes(shared("SWITCH_STEPS")), "the opening does not carry the switch steps verbatim");
  assert.ok(boot.session.includes(shared("NO_KEY_IN_CHAT")), "the opening does not say no key goes in the chat");
  assert.doesNotMatch(boot.session, /signed in as /, "it names a person, which the session is not told");
});

test("bootstrap, signed out: it opens with the connect steps", async () => {
  const boot = await bootstrap("sess-sw-out");
  assert.equal(Object.keys(boot)[0], "session");
  assert.ok(boot.session?.startsWith("You are NOT signed in to any A-Team workspace."), `opening: ${boot.session}`);
  assert.ok(boot.session.includes(shared("CONNECT_STEPS")), "the opening does not carry the connect steps verbatim");
  assert.ok(boot.session.includes(shared("NO_KEY_IN_CHAT")));
});

test("the server instructions open with the same text as bootstrap", async () => {
  assert.equal(typeof server.serverInstructions, "function", "src/server.js builds no instructions per session");
  for (const sid of ["sess-sw-in", "sess-sw-out"]) {
    const boot = await bootstrap(sid);
    assert.ok(server.serverInstructions(sid).startsWith(boot.session), `${sid}: the instructions do not open with where the session is`);
  }
  assert.match(server.serverInstructions("sess-sw-out"), /ALWAYS call the ateam_bootstrap tool/, "the onboarding instruction was lost");
});

// ─── 2. The refusals carry the shared steps, word for word ──────────────────

test("not signed in: the auth gate's refusal carries the connect steps verbatim", async () => {
  const r = await handleToolCall("ateam_list_solutions", {}, "sess-sw-gate");
  assert.equal(r.structuredContent?.stage, "auth_gate");
  assert.ok(r.content[0].text.includes(shared("CONNECT_STEPS")), r.content[0].text);
  assert.ok(r.content[0].text.includes(shared("NO_KEY_IN_CHAT")), r.content[0].text);
});

test("a solution this workspace does not have: the refusal says it may be in another workspace, then the switch steps", async () => {
  await signIn("sess-sw-404", PROD_KEY);
  // The incident's shape: the Builder's SOLUTION_NOT_FOUND names what IS here.
  const r = await handleToolCall("ateam_show_solution_minimal", { solution_id: "ateam-mcp-test" }, "sess-sw-404");
  assert.equal(r.isError, true, r.content[0].text);
  assert.ok(r.content[0].text.includes(shared("NOT_IN_THIS_WORKSPACE")), r.content[0].text);
  assert.ok(shared("NOT_IN_THIS_WORKSPACE").includes(shared("SWITCH_STEPS")));
  // The table's own 404 on a solution path, with no body hint.
  const generic = formatError("GET", "/deploy/solutions/x/skills/y", 404, "", "https://api.ateam-ai.com");
  assert.ok(generic.includes(shared("NOT_IN_THIS_WORKSPACE")), generic);
  // (control) a 404 whose body names another cause is not told to switch.
  const noMatch = formatError("POST", "/deploy/solutions/x/github/patch", 404, JSON.stringify({ code: "NO_MATCH", hint: "copy the exact bytes" }), "");
  assert.doesNotMatch(noMatch, /ANOTHER WORKSPACE/, noMatch);
});

// ─── 3. One statement ───────────────────────────────────────────────────────

test("the links in the shared steps are the verified ones", () => {
  const connect = shared("CONNECT_STEPS");
  const sw = shared("SWITCH_STEPS");
  for (const link of ["https://mcp.ateam-ai.com", "https://claude.ai/customize/connectors", "https://app.ateam-ai.com"]) {
    assert.ok(connect.includes(link), `CONNECT_STEPS lacks ${link}`);
  }
  for (const link of ["https://claude.ai/customize/connectors", "https://app.ateam-ai.com"]) {
    assert.ok(sw.includes(link), `SWITCH_STEPS lacks ${link}`);
  }
  // The app link is the production API's app, by the one api → app map.
  assert.equal(steps.PROD_APP_URL, api.apiToAppUrl?.(KEY_ENVIRONMENTS.prod));
});

test("no other src/ file restates the steps", () => {
  // Phrases only a sign-in or switch step uses, and the older variants.
  const STEP_PHRASES = [
    /claude\.ai\/customize\/connectors/, /admin-settings\/connectors/, /Add custom connector/, /Tenant administration/,
    /A-Team sign-in page/, /Agent API Key/, /workspace picker/, /authorize it in the browser/, /get-api-key/,
    /Get your API key/i, /get their API key/i,
  ];
  const offenders = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".js") && n !== "signInSteps.js")) {
    readFileSync(join(SRC, f), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // history in comments is not a served text
      if (f === "http.js" && line.includes('app.get("/get-api-key"')) return; // the route itself, kept for outside links
      for (const rx of STEP_PHRASES) if (rx.test(line)) offenders.push(`${f}:${i + 1} ${rx} — ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, [], `restated outside src/signInSteps.js:\n${offenders.join("\n")}`);
});

// ─── 4. Public text names production only; dev routes as before ────────────

const DEV_TEXT = /dev-api|dev-app|dev-mcp|dev-builder|adas_dev_/;

test("no served text names a dev host or a dev key", async () => {
  const served = [];
  served.push(["tools/list (every tool, core or not)", JSON.stringify(tools)]);
  await signIn("sess-sw-guard", PROD_KEY);
  served.push(["bootstrap signed in", JSON.stringify(await bootstrap("sess-sw-guard"))]);
  served.push(["bootstrap signed out", JSON.stringify(await bootstrap("sess-sw-guard-out"))]);
  if (server.serverInstructions) {
    served.push(["instructions signed in", server.serverInstructions("sess-sw-guard")]);
    served.push(["instructions signed out", server.serverInstructions("sess-sw-guard-out")]);
  }
  served.push(["auth gate", (await handleToolCall("ateam_list_solutions", {}, "sess-sw-guard-gate")).content[0].text]);
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
    served.push([`formatError ${status}`, formatError("GET", "/deploy/solutions/x/definition", status, "", "https://api.ateam-ai.com")]);
  }
  // ateam_auth's own failures: an older key the default API refused, and any other refusal.
  globalThis.fetch = async () => json(401, { error: "Invalid or unconfigured API key" });
  try {
    for (const key of [`adas_acme_${HEX}`, PROD_KEY]) {
      served.push([`ateam_auth refused ${key.slice(0, 10)}…`, (await handleToolCall("ateam_auth", { api_key: key }, "sess-sw-guard-auth")).content[0].text]);
    }
  } finally { globalThis.fetch = stub; }
  assert.ok(served.some(([, t]) => t.includes("env_mismatch_suspected")), "ateam_auth's older-key branch was not reached");
  if (oauth.generateAuthPage) served.push(["the sign-in page", oauth.generateAuthPage("p", { name: "Claude", host: "claude.ai" })]);
  // A session on the dev API is told where it is, with no dev link either.
  await signIn("sess-sw-guard-dev", DEV_KEY);
  served.push(["bootstrap's opening, signed in with a dev key", (await bootstrap("sess-sw-guard-dev")).session ?? ""]);
  for (const [where, text] of served) {
    const hit = text.match(DEV_TEXT);
    assert.ok(!hit, `${where} names dev: …${hit ? text.slice(Math.max(0, hit.index - 80), hit.index + 40) : ""}…`);
  }

  // Every string in src/ too, for the branches no call above reaches. Only the
  // routing code that maps a key to its API may hold a dev host.
  const ROUTING = [/^\s*dev: "https:\/\/dev-api\.ateam-ai\.com",$/, /host\.startsWith\("dev-api\."\)\) host = "dev-app\."/];
  const offenders = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".js"))) {
    readFileSync(join(SRC, f), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || !DEV_TEXT.test(line)) return;
      if (f === "api.js" && ROUTING.some((rx) => rx.test(line))) return;
      offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, [], `a served string names dev:\n${offenders.join("\n")}`);
});

test("(control) a dev key still reaches the dev API — routing unchanged", async () => {
  asked.length = 0;
  assert.equal(baseUrlForKeyEnv(DEV_KEY), KEY_ENVIRONMENTS.dev, "the key → API map (http.js seedCredentials uses it) moved");
  const authed = await signIn("sess-sw-dev", DEV_KEY);
  assert.equal(authed.environment, "dev");
  assert.deepEqual([...new Set(asked.map((u) => u.origin))], [KEY_ENVIRONMENTS.dev], "ateam_auth asked another API");
  assert.equal(getBaseUrl("sess-sw-dev"), KEY_ENVIRONMENTS.dev);
  assert.equal(servedBy("sess-sw-dev"), "dev");
  const boot = await bootstrap("sess-sw-dev");
  assert.equal(boot.runtime.base_url, KEY_ENVIRONMENTS.dev);
  assert.equal(boot.served_by, "dev");
});
