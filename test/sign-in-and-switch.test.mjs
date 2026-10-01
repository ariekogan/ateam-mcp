// Which workspace a session is on, how to sign in, and how to switch — ONE
// statement (src/signInSteps.js), rendered word for word where it is read, in
// the variant for how the session is connected (hosted, stdio, platform).
//
// A session on the hosted connector was signed in to one workspace while the
// user needed another. The user pasted a key into the chat (the agent rightly
// refused it), and neither of them could tell which workspace the session was
// on or how to change it. 0f5f4d3 (MGAP-A1) had said how to sign in; nothing
// said where a session was or how to move.
//
// Also pinned here: public text links production only (Arie, 2026-10-01 — the
// package is public), while a dev key still routes exactly as before.
//
// Expected texts are rendered from the shared module, never copied, except in
// the one test that pins the verified links. The module is loaded dynamically
// so that, on a tree without it, each test fails on its own assertion.
//
// The served server instructions: test/session-opening-served.test.mjs.
// The gate: test/public-tools-gate.test.mjs.
//
// Run: node --test test/sign-in-and-switch.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as api from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

const { KEY_ENVIRONMENTS, formatError, getBaseUrl, servedBy, baseUrlForKeyEnv, runToolCall, bindSessionPlatform } = api;
const steps = await import("../src/signInSteps.js").catch(() => ({}));
const publicTools = await import("../src/publicTools.js").catch(() => ({}));
const oauth = await import("../src/oauth.js").catch(() => ({}));
const shared = (name) => {
  assert.ok(name in steps, `no shared ${name} in src/signInSteps.js`);
  return steps[name];
};
const render = (name, ...args) => {
  const v = shared(name);
  assert.equal(typeof v, "function", `${name} is not a renderer`);
  return v(...args);
};

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HEX = "0".repeat(32);
const PROD_KEY = `adas_prod_acme_${HEX}`;
const DEV_KEY = `adas_dev_acme_${HEX}`;
const LEGACY_KEY = `adas_acme_${HEX}`;
const HOSTED_PROD = { audience: "hosted", signedIn: true, tenant: "acme", environment: "prod", masterMode: false };

// One stub for every request: who was asked, and an answer per path.
const asked = [];
const realFetch = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// The Builder's own answer for a solution this tenant does not have: code + a
// specific hint naming what IS here (utils/solutionNotFound.js).
const BUILDER_NOT_FOUND = { ok: false, code: "SOLUTION_NOT_FOUND", error: 'No solution "ateam-mcp-test" in tenant "acme".', hint: 'This tenant has exactly ONE solution: "walk-guide-hud" — use that id from now on.' };
const stub = async (url) => {
  const u = new URL(String(url));
  asked.push(u);
  if (u.pathname === "/deploy/solutions/ateam-mcp-test/definition") return json(404, BUILDER_NOT_FOUND);
  if (u.pathname === "/deploy/solutions/ateam-mcp-test" && u.search.includes("force=true")) return json(404, BUILDER_NOT_FOUND);
  // A body of JSON null: what the minimal views' own "not found" branch reads.
  if (u.pathname.startsWith("/deploy/solutions/empty-sol")) return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
  // An empty body: request() names the server it came from.
  if (u.pathname.startsWith("/deploy/solutions/empty-body")) return new Response("", { status: 200 });
  return json(200, { solutions: [] });
};
before(() => { globalThis.fetch = stub; });
after(() => { globalThis.fetch = realFetch; });

const signIn = async (sid, args) => {
  const r = await handleToolCall("ateam_auth", typeof args === "string" ? { api_key: args } : args, sid);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.ok, true, r.content[0].text);
  return out;
};
const bootstrap = async (sid, transport) => {
  const call = () => handleToolCall("ateam_bootstrap", {}, sid);
  const r = transport ? await runToolCall(sid, call, { transport }) : await call();
  return JSON.parse(r.content[0].text);
};

// ─── 1. Where the session is, first — per way of being connected ───────────

test("bootstrap, hosted, signed in: it opens with the workspace and the environment, then how to switch", async () => {
  await signIn("sess-sw-in", PROD_KEY);
  const boot = await bootstrap("sess-sw-in");
  assert.equal(Object.keys(boot)[0], "session", `bootstrap opens with ${Object.keys(boot)[0]}, not where the session is`);
  assert.ok(boot.session?.startsWith('You are signed in to workspace "acme" (prod).'), `opening: ${boot.session}`);
  assert.equal(boot.session, render("sessionOpening", HOSTED_PROD));
  assert.ok(boot.session.includes(render("switchSteps", HOSTED_PROD)), "the opening does not carry the switch steps verbatim");
  assert.ok(boot.session.includes(shared("NO_KEY_IN_CHAT")));
  assert.doesNotMatch(boot.session, /signed in as /, "it names a person, which the session is not told");
});

test("bootstrap, hosted, signed out: it opens with the connect steps and the one list of tools that need none", async () => {
  const boot = await bootstrap("sess-sw-out");
  assert.equal(Object.keys(boot)[0], "session");
  assert.equal(boot.session, render("sessionOpening", { audience: "hosted", signedIn: false }));
  assert.ok(boot.session.includes(render("connectSteps", { audience: "hosted" })));
  assert.ok(boot.session.includes(publicTools.NO_SIGN_IN_NEEDED ?? "\0"), "the opening restates its own list of tools that need no sign-in");
});

test("bootstrap, stdio: the local sign-in, never the connector's", async () => {
  const boot = await bootstrap("sess-sw-stdio", "stdio");
  assert.equal(boot.session, render("sessionOpening", { audience: "stdio", signedIn: false }));
  assert.ok(!boot.session.includes(render("connectSteps", { audience: "hosted" })), "a local process was told to sign in through the hosted connector");
  await runToolCall("sess-sw-stdio", () => signIn("sess-sw-stdio", PROD_KEY), { transport: "stdio" });
  const signedIn = await bootstrap("sess-sw-stdio", "stdio");
  assert.ok(signedIn.session.includes(render("switchSteps", { audience: "stdio", environment: "prod" })), signedIn.session);
  assert.doesNotMatch(signedIn.session, /Disconnect/, "a local process was told to disconnect a connector");
});

test("platform (the A-Team app's builder): no sign-in or switch steps, in the opening or the refusal", async () => {
  bindSessionPlatform("sess-sw-platform");
  const boot = await bootstrap("sess-sw-platform");
  assert.equal(boot.session, render("sessionOpening", { audience: "platform", signedIn: false }));
  const r = await handleToolCall("ateam_list_solutions", {}, "sess-sw-platform");
  assert.equal(r.structuredContent?.stage, "auth_gate", "the refusal lost the mark the proxy replays on");
  for (const text of [boot.session, r.content[0].text]) assert.doesNotMatch(text, /HOW TO SIGN IN|HOW TO SWITCH/);
});

test("master key: the opening says the tenant argument moves the session, not 'this workspace only'", async () => {
  await signIn("sess-sw-master", { master_key: "mk", tenant: "acme" });
  const boot = await bootstrap("sess-sw-master");
  assert.ok(boot.session.includes(render("switchSteps", { masterMode: true })), boot.session);
  assert.match(boot.session, /MASTER key/);
});

test("one answer for the environment: a key that names none is 'unstated' in ateam_auth AND the opening", async () => {
  const authed = await signIn("sess-sw-legacy", LEGACY_KEY);
  assert.equal(authed.environment, "unstated");
  assert.equal(api.sessionEnvironment?.("sess-sw-legacy"), authed.environment, "the opening and ateam_auth read different owners");
  const boot = await bootstrap("sess-sw-legacy");
  assert.ok(boot.session.startsWith('You are signed in to workspace "acme" (environment unstated'), boot.session);
});

// ─── 2. The refusals carry the shared steps, word for word ──────────────────

test("not signed in: the auth gate's refusal carries the connect steps and the one public list", async () => {
  const r = await handleToolCall("ateam_list_solutions", {}, "sess-sw-gate");
  assert.equal(r.structuredContent?.stage, "auth_gate");
  assert.ok(r.content[0].text.includes(render("connectSteps", { audience: "hosted" })), r.content[0].text);
  assert.ok(r.content[0].text.includes(shared("NO_KEY_IN_CHAT")));
  assert.ok(r.content[0].text.includes(publicTools.NO_SIGN_IN_NEEDED ?? "\0"), "the gate restates its own list of tools that need no sign-in");
});

test("a solution this workspace does not have: the refusal says it may be in another workspace, then the switch steps", async () => {
  await signIn("sess-sw-404", PROD_KEY);
  const r = await handleToolCall("ateam_show_solution_minimal", { solution_id: "ateam-mcp-test" }, "sess-sw-404");
  assert.equal(r.isError, true, r.content[0].text);
  assert.ok(r.content[0].text.includes(render("notInThisWorkspace", HOSTED_PROD)), r.content[0].text);
});

test("only a missing solution or skill gets it — not a missing file, job or connector inside one", () => {
  const ctx = { signIn: HOSTED_PROD };
  const hint = render("notInThisWorkspace", HOSTED_PROD);
  const has = (path, body) => formatError("GET", path, 404, typeof body === "string" ? body : JSON.stringify(body), "https://api.ateam-ai.com", ctx).includes(hint);
  assert.ok(has("/deploy/solutions/x/skills/y", { error: "Skill 'y' not found" }), "Core's missing skill");
  assert.ok(has("/deploy/solutions/x/definition", { ok: false, error: "Solution not found in Builder" }), "the Builder's missing solution");
  assert.ok(has("/deploy/solutions/x/definition", BUILDER_NOT_FOUND), "the Builder's SOLUTION_NOT_FOUND");
  assert.ok(!has("/deploy/solutions/x/connectors/c/files", { ok: false, error: 'No files found for connector "c" in GitHub repo on ref "dev"' }), "a missing file");
  assert.ok(!has("/deploy/solutions/x/connectors/c", { ok: false, error: 'Connector "c" not found in solution "x"' }), "a missing connector");
  assert.ok(!has("/deploy/solutions/x/jobs/j", { ok: false, error: "Job not found" }), "a missing job");
  assert.ok(!has("/deploy/solutions/x/github/patch", { code: "NO_MATCH", hint: "copy the exact bytes" }), "a patch's own cause");
  assert.ok(!has("/deploy/solutions/x/definition", ""), "a 404 with no body says nothing about which is missing");
});

test("the three handlers' own not-found answers carry it: forced delete, and both minimal views", async () => {
  await signIn("sess-sw-handlers", PROD_KEY);
  const hint = render("notInThisWorkspace", HOSTED_PROD);
  const del = JSON.parse((await handleToolCall("ateam_delete_solution",
    { solution_id: "ateam-mcp-test", confirm: true, confirm_solution_id: "ateam-mcp-test", force: true }, "sess-sw-handlers")).content[0].text);
  assert.ok(String(del._next).includes(hint), `delete _next: ${del._next}`);
  for (const [tool, args] of [["ateam_show_solution_minimal", { solution_id: "empty-sol" }], ["ateam_show_skill_minimal", { solution_id: "empty-sol", skill_id: "s" }]]) {
    const out = JSON.parse((await handleToolCall(tool, args, "sess-sw-handlers")).content[0].text);
    assert.equal(out.ok, false, `${tool}: ${JSON.stringify(out)}`);
    assert.equal(out.hint, hint, `${tool}: ${JSON.stringify(out)}`);
  }
});

test("401: a signed-in session is told its key was refused; one that never signed in, how to sign in", () => {
  const signedIn = formatError("GET", "/deploy/solutions", 401, "", "https://api.ateam-ai.com", { signIn: HOSTED_PROD });
  assert.ok(signedIn.includes(render("switchSteps", HOSTED_PROD)), signedIn);
  const signedOut = formatError("GET", "/deploy/solutions", 401, "", "https://api.ateam-ai.com", { signIn: { audience: "stdio", signedIn: false } });
  assert.ok(signedOut.includes(render("connectSteps", { audience: "stdio" })), signedOut);
  assert.doesNotMatch(signedOut, /signed in with/, "a session that never signed in was told its sign-in key was refused");
});

// Review round 2 (R2-3): request() must hand formatError THIS session's
// sign-in context. Without it every refusal is told the hosted steps, so a
// local process hearing "IT MAY BE IN ANOTHER WORKSPACE" was told to
// Disconnect a connector it does not have.
test("a stdio session's not-in-this-workspace refusal gives the stdio switch steps (request passes the context)", async () => {
  const sid = "sess-sw-stdio-404";
  await runToolCall(sid, () => signIn(sid, PROD_KEY), { transport: "stdio" });
  const r = await runToolCall(sid, () => handleToolCall("ateam_show_solution_minimal", { solution_id: "ateam-mcp-test" }, sid), { transport: "stdio" });
  const text = r.content[0].text;
  assert.ok(text.includes(render("notInThisWorkspace", { audience: "stdio", signedIn: true, tenant: "acme", environment: "prod" })), `stdio refusal:\n${text}`);
  assert.doesNotMatch(text, /Disconnect/, "a local process was told to disconnect a connector");
});

// Review round 2 (R2-3): the stdio refusal text itself.
test("a stdio session's auth-gate refusal: why it is not signed in, and the local sign-in", async () => {
  const sid = "sess-sw-stdio-gate";
  const r = await runToolCall(sid, () => handleToolCall("ateam_list_solutions", {}, sid), { transport: "stdio" });
  const text = r.content[0].text;
  assert.equal(r.structuredContent?.stage, "auth_gate");
  assert.ok(text.includes(render("connectSteps", { audience: "stdio" })), `stdio gate:\n${text}`);
  assert.match(text, /IT RESTARTED|ADAS_API_KEY is set in this process's environment/, "the gate does not say why a local process is signed out");
  assert.ok(!text.includes(render("connectSteps", { audience: "hosted" })), "a local process was told to sign in through the hosted connector");
});

test("a self-hosted url is named as the environment, not folded into 'unstated'", async () => {
  const SELF = "http://127.0.0.1:9";
  const authed = await signIn("sess-sw-self", { api_key: LEGACY_KEY, url: SELF });
  assert.equal(authed.environment, SELF);
  assert.ok((await bootstrap("sess-sw-self")).session.startsWith(`You are signed in to workspace "acme" (${SELF}).`));
});

// ─── 3. One statement ───────────────────────────────────────────────────────

test("the verified links, pinned (the one place they are written twice, on purpose)", () => {
  const hosted = render("connectSteps", { audience: "hosted" });
  for (const link of ["https://mcp.ateam-ai.com", "https://claude.ai/customize/connectors", "https://app.ateam-ai.com/connect"]) {
    assert.ok(hosted.includes(link), `the hosted connect steps lack ${link}`);
  }
  const sw = render("switchSteps", { audience: "hosted", environment: "prod" });
  for (const link of ["https://claude.ai/customize/connectors", "https://app.ateam-ai.com/connect"]) assert.ok(sw.includes(link), `the switch steps lack ${link}`);
  assert.equal(shared("KEY_PAGE_URL"), `${api.apiToAppUrl?.(KEY_ENVIRONMENTS.prod)}/connect`, "the key page is not the production API's app");
});

test("no other src/ file restates the steps", () => {
  // Phrases only a sign-in or switch step uses, and the older variants.
  const STEP_PHRASES = [
    /claude\.ai\/customize\/connectors/, /admin-settings\/connectors/, /Add custom connector/, /Tenant administration/,
    /A-Team sign-in page/, /Agent API Key/, /workspace picker/, /authorize it in the browser/, /get-api-key/,
    /Get your API key/i, /get their API key/i, /Clear authentication/, /\/connect\b(?!-github|ors)/,
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

// ─── 4. Public text links production only; dev routes as before ────────────

const DEV_TEXT = /dev-api|dev-app|dev-mcp|dev-builder|adas_dev_/;

test("no served text names a dev host or a dev key, and a dev session is given no URL for its key", async () => {
  const served = [];
  served.push(["tools/list (every tool, core or not)", JSON.stringify(tools)]);
  await signIn("sess-sw-guard", PROD_KEY);
  served.push(["bootstrap signed in", JSON.stringify(await bootstrap("sess-sw-guard"))]);
  served.push(["bootstrap signed out", JSON.stringify(await bootstrap("sess-sw-guard-out"))]);
  served.push(["bootstrap stdio", JSON.stringify(await bootstrap("sess-sw-guard-stdio", "stdio"))]);
  served.push(["auth gate", (await handleToolCall("ateam_list_solutions", {}, "sess-sw-guard-gate")).content[0].text]);
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
    served.push([`formatError ${status}`, formatError("GET", "/deploy/solutions/x/definition", status, JSON.stringify(BUILDER_NOT_FOUND), "https://api.ateam-ai.com")]);
  }
  // ateam_auth's own failures: an older key the default API refused, and any other refusal.
  globalThis.fetch = async () => json(401, { error: "Invalid or unconfigured API key" });
  try {
    for (const key of [LEGACY_KEY, PROD_KEY]) {
      served.push([`ateam_auth refused ${key.slice(0, 10)}…`, (await handleToolCall("ateam_auth", { api_key: key }, "sess-sw-guard-auth")).content[0].text]);
    }
  } finally { globalThis.fetch = stub; }
  assert.ok(served.some(([, t]) => t.includes("env_mismatch_suspected")), "ateam_auth's older-key branch was not reached");
  if (oauth.generateAuthPage) served.push(["the sign-in page", oauth.generateAuthPage("p", { name: "Claude", host: "claude.ai" })]);
  // A session on the dev API is told where it is, with no dev link — and no
  // production link for its key either: its key is in its own environment's app.
  // ...and is served no dev host in any DATA field either (review round 2):
  // ateam_auth's result, bootstrap's runtime.base_url, _where, error targets.
  const devAuth = await signIn("sess-sw-guard-dev", DEV_KEY);
  served.push(["ateam_auth's result for a dev key", JSON.stringify(devAuth)]);
  const devBoot = await bootstrap("sess-sw-guard-dev");
  served.push(["bootstrap for a dev session", JSON.stringify(devBoot)]);
  served.push(["_where for a dev session", JSON.stringify(api.getWhere("sess-sw-guard-dev"))]);
  const dev404 = (await handleToolCall("ateam_show_solution_minimal", { solution_id: "ateam-mcp-test" }, "sess-sw-guard-dev")).content[0].text;
  const devEmpty = (await handleToolCall("ateam_show_solution_minimal", { solution_id: "empty-body" }, "sess-sw-guard-dev")).content[0].text;
  assert.match(dev404, /returned 404/, "the 404 branch was not reached");
  assert.match(devEmpty, /empty body/, "the empty-body branch was not reached");
  served.push(["a dev session's 404", dev404], ["a dev session's empty answer", devEmpty]);
  const devOpening = devBoot.session ?? "";
  assert.ok(!devOpening.includes(steps.KEY_PAGE_URL ?? "https://app.ateam-ai.com"), "a dev session was sent to the production app for its key");
  assert.match(devOpening, /your environment's own A-Team app/);
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
  assert.equal(boot.served_by, "dev");
  assert.equal(boot.runtime.base_url, api.shownBase?.(KEY_ENVIRONMENTS.dev), "the routing moved, or the host is served");
});
