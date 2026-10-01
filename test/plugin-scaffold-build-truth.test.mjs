// The plugin scaffold must describe the deploy that exists.
//
// d7b92aa (2026-07-27) wrote, into the .tsx every RN plugin starts from, into
// ateam_create_plugin's next_steps and into the connector README:
//   "Core does NOT compile this .tsx. Deploys run 'npm install --production
//    --no-optional' … and only ever run a 'build' script — never 'build:rn'."
// True that day. Core then changed under it, and nothing here followed:
//   66184e18a (#102, 2026-09-07)  a package with a build script gets a full
//                                 install; `--production` is gone
//   0fa6d551e (2026-09-09)        EVERY `build` / `build:*` script runs
//                                 (connectorBuildScripts.js), build:rn included
// So the scaffold told agents that a deploy can never build their bundle, while
// ateam_get_spec("ui-plugins") and ateam_get_examples("ui-plugin-native") tell
// them to do exactly that with a build:rn script. Two answers, one question.
// (Core PR #127 names this.)
//
// That recipe keeps esbuild in devDependencies, and Core #127 (54f38b74a) is
// what makes it deploy: under the container's NODE_ENV=production a plain
// `npm install` omitted devDependencies ("esbuild: not found", 422), so a
// package with a build script is now installed with `--include=dev`. The
// build:rn hint therefore says where esbuild goes; without that an agent
// reaching for "dependencies" works around a defect that is fixed.
//
// The true statement is narrower and checkable against what the scaffold
// ships: the phone loads the committed bundle, a deploy runs the build scripts
// package.json declares, and THIS scaffold declares none.
//
// Behavioural: ateam_create_connector and ateam_create_plugin run through the
// real dispatcher against a local stand-in for the API; what they upload and
// what they answer is what is checked.
//
// Run: node --test test/plugin-scaffold-build-truth.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const SID = "sess-scaffold-truth";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const uploads = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      let reply = { ok: true };
      if (req.method === "POST" && path.endsWith("/upload")) {
        uploads.push(JSON.parse(body || "{}"));
        reply = { ok: true, tools: 1 };
      } else if (req.method === "GET" && path.endsWith("/source")) {
        // A new connector: nothing authored, nothing deployed (create's existence check).
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "AUTHORED_SOURCE_MISSING", deployed_in_core: false }));
        return;
      } else if (path.endsWith("/ui-plugins")) {
        // Found at once, so create_plugin's render check does not wait.
        reply = { ok: true, plugins: [{ id: "mcp:demo-mcp:walk", render: { mode: "adaptive", iframeUrl: "/ui/walk/index.html" } }] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

const call = async (tool, args) => {
  uploads.length = 0;
  const r = await handleToolCall(tool, { solution_id: "walkmate", ...args }, SID);
  assert.ok(!r.isError, `${tool} failed: ${r.content?.[0]?.text?.slice(0, 300)}`);
  return { out: JSON.parse(r.content[0].text), files: uploads.flatMap((u) => u.files || []) };
};
const fileText = (files, suffix) => files.find((f) => f.path.endsWith(suffix))?.content || "";

// The claims d7b92aa made, as an agent would read them.
const STALE = [
  [/Core (does NOT|never) compiles?\b/i, "Core never compiles the .tsx"],
  [/--production/, "deploys install with --production"],
  [/never ["`]?build:rn/i, "a deploy never runs build:rn"],
  [/not ["`]?build:rn["`]?\)/i, "only `build` runs, not build:rn"],
  [/skips esbuild/i, "the install skips esbuild"],
];
const assertNoStaleClaim = (where, text) => {
  for (const [rx, claim] of STALE) assert.doesNotMatch(text, rx, `${where} still says: ${claim}`);
};
// The build:rn hint must match the ui-plugins recipe it points to: esbuild in
// devDependencies, which a package with a build script is installed with.
const assertBuildHintNamesDevDeps = (where, text) => {
  assert.match(text, /build:rn[\s\S]{0,120}esbuild[\s\S]{0,20}devDependencies/,
    `${where} names build:rn but not where esbuild goes (devDependencies)`);
  assert.match(text, /installed\s+WITH\s+its[\s/]+devDependencies/i,
    `${where} does not say a package with a build script is installed with its devDependencies`);
};

test("the scaffolded connector ships no build script — the fact the text now rests on", async () => {
  const { files } = await call("ateam_create_connector", { connector_id: "demo-mcp", ui_capable: true });
  const pkg = JSON.parse(fileText(files, "package.json"));
  const builds = Object.keys(pkg.scripts || {}).filter((k) => k === "build" || k.startsWith("build:"));
  assert.deepEqual(builds, [], "the scaffold declares a build script, so 'this scaffold declares none' is false");
});

test("the connector README describes the deploy that exists", async () => {
  const { files } = await call("ateam_create_connector", { connector_id: "demo-mcp", ui_capable: true });
  const readme = fileText(files, "README.md");
  assert.ok(readme.includes("rn-bundle/"), "the README no longer explains the RN bundle at all");
  assertNoStaleClaim("README.md", readme);
  assert.match(readme, /build:rn/, "the README does not say a build:rn script is how a deploy builds the bundle");
  assertBuildHintNamesDevDeps("README.md", readme);
});

for (const kind of ["rn", "adaptive"]) {
  test(`create_plugin (${kind}): the .tsx header and next_steps describe the deploy that exists`, async () => {
    const { out, files } = await call("ateam_create_plugin", { connector_id: "demo-mcp", plugin_name: "walk", kind });
    const tsx = fileText(files, "rn-src/walk.tsx");
    assert.ok(tsx, "no .tsx was uploaded");
    const header = tsx.slice(0, tsx.indexOf("import "));
    assertNoStaleClaim("the .tsx header", header);
    assert.match(header, /rn-bundle\/walk\.bundle\.js/, "the header no longer names the bundle the phone loads");
    assert.match(header, /build:rn/, "the header does not name the build script a deploy would run");
    assertBuildHintNamesDevDeps("the .tsx header", header);
    assert.ok(files.some((f) => f.path === "rn-bundle/walk.bundle.js"), "the pre-built bundle the text relies on was not shipped");

    const step = (out.next_steps || []).find((s) => s.includes("rn-src/"));
    assert.ok(step, "next_steps no longer tell the caller what to do with the .tsx");
    assertNoStaleClaim("next_steps", step);
    assert.match(step, /build:rn/);
    assertBuildHintNamesDevDeps("next_steps", step);
  });
}
