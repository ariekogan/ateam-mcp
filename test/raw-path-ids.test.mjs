// BUILDER-SEC-MCP-RAWID: NO TOOL PUTS A CALLER'S ID INTO A URL PATH RAW.
//
// tools.js pasted ids into API paths as they came, at over a hundred sites. A
// raw id can rewrite the request it sits in. fetch normalizes dot-segments, so
//   ateam_test_abort(solution_id:"walkmate", skill_id:"..", job_id:"..?force=true")
// sent DELETE /deploy/solutions/walkmate?force=true: a FORCED tenant wipe, and
// test_abort asks for no confirm at all. ateam_delete_skill and
// ateam_delete_connector did the same with "..?force=true", "%2e%2e?force=true"
// or "walkmate?force=true#". (CORE review R1 of ateam-mcp #26.)
//
// Now every API path is built by ONE tag, src/pathParam.js apiPath: each value
// is checked (pathSeg) and percent-encoded, and a value that cannot be an id is
// refused before any request. The guard below fails on any API path built
// another way.
//
// Run: node --test test/raw-path-ids.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";
import { apiPath, pathSeg, rawQuery } from "../src/pathParam.js";

const SID = "sess-raw-path-ids";
let hits = [];
let server;
before(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chain: { chainJobs: [] } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    explicit: true,
  });
});
after(() => server.close());

async function call(tool, args) {
  hits = [];
  const res = await handleToolCall(tool, args, SID);
  return { res, text: res.content[0].text };
}

// CORE's payloads, and the neighbours they stand for.
const PAYLOADS = ["..?force=true", "%2e%2e?force=true", "walkmate?force=true#", "..", ".", "", "a b", "x\\y", "x%2Fy"];

test("R1: delete_skill, delete_connector and test_abort refuse an injecting id with ZERO requests", async () => {
  const cases = (bad) => [
    ["ateam_delete_skill", { solution_id: "walkmate", skill_id: bad, confirm: true }],
    ["ateam_delete_skill", { solution_id: bad, skill_id: "k", confirm: true }],
    ["ateam_delete_connector", { solution_id: "walkmate", connector_id: bad, confirm: true }],
    ["ateam_delete_connector", { solution_id: bad, connector_id: "c", confirm: true }],
    ["ateam_test_abort", { solution_id: "walkmate", skill_id: "..", job_id: bad }],
    ["ateam_test_abort", { solution_id: "walkmate", skill_id: bad, job_id: "j1" }],
    ["ateam_test_abort", { solution_id: bad, skill_id: "k", job_id: "j1" }],
  ];
  for (const bad of PAYLOADS) {
    for (const [tool, args] of cases(bad)) {
      const { res, text } = await call(tool, args);
      assert.equal(hits.length, 0, `${tool}(${JSON.stringify(args)}) sent: ${hits.join(", ")}`);
      assert.equal(res.isError, true, `${tool}(${JSON.stringify(args)}) did not fail`);
      // test_abort refuses an empty skill_id/job_id itself, before any path is built.
      if (tool === "ateam_test_abort" && bad === "" && !("solution_id" in args && args.solution_id === "")) continue;
      assert.match(text, /cannot be used as an id in a URL path.*Nothing was sent/s, `${tool}: ${text}`);
      assert.equal(res.structuredContent?.code, "INVALID_PATH_PARAM");
    }
  }
});

test("R1: the exact wipe CORE found — test_abort(skill_id:'..', job_id:'..?force=true') — sends nothing", async () => {
  await call("ateam_test_abort", { solution_id: "walkmate", skill_id: "..", job_id: "..?force=true" });
  assert.deepEqual(hits, [], `sent: ${hits.join(", ")}`);
});

test("(control) valid ids reach the path encoded, one segment each", async () => {
  await call("ateam_delete_skill", { solution_id: "walkmate", skill_id: "walk-guide", confirm: true });
  assert.deepEqual(hits, ["DELETE /deploy/solutions/walkmate/skills/walk-guide"]);
  await call("ateam_delete_connector", { solution_id: "walkmate", connector_id: "device-mock-mcp", confirm: true });
  assert.deepEqual(hits, ["DELETE /deploy/solutions/walkmate/connectors/device-mock-mcp"]);
  await call("ateam_test_abort", { solution_id: "walkmate", skill_id: "k", job_id: "redeploy-skill-a/b" });
  assert.deepEqual(hits, ["DELETE /deploy/solutions/walkmate/skills/k/test/redeploy-skill-a%2Fb"],
    "a legacy job id with '/' must stay one segment");
  await call("ateam_github_read", { solution_id: "walkmate", path: "skills/a b/skill.json", ref: "dev" });
  assert.deepEqual(hits, ["GET /deploy/solutions/walkmate/github/read?path=skills%2Fa+b%2Fskill.json&branch=dev"]);
});

test("pathSeg and apiPath: check, then encode; query values encoded; rawQuery untouched", () => {
  for (const ok of ["walkmate", "Walk_Mate-2", "mcp:w:p", "a/b", "v1.2", 42]) {
    assert.equal(pathSeg(ok), encodeURIComponent(String(ok)), String(ok));
  }
  for (const bad of [...PAYLOADS, undefined, null, {}, NaN, "x\ny"]) {
    assert.throws(() => pathSeg(bad), (e) => e.code === "INVALID_PATH_PARAM", `${JSON.stringify(bad)} was accepted`);
  }
  const id = "mcp:w:p";
  const file = "a&b=c";
  const qs = new URLSearchParams({ x: "1", y: "2" });
  assert.equal(apiPath`/deploy/solutions/${"s"}/plugins/${id}/v?path=${file}`, "/deploy/solutions/s/plugins/mcp%3Aw%3Ap/v?path=a%26b%3Dc");
  assert.equal(apiPath`/deploy/jobs/${"j"}/chain?${rawQuery(qs)}`, "/deploy/jobs/j/chain?x=1&y=2");
  assert.equal(apiPath`/deploy/solutions/${"s"}/logs${rawQuery("")}`, "/deploy/solutions/s/logs");
  assert.throws(() => apiPath`/deploy/solutions/${"..?force=true"}`, /Nothing was sent/);
});

// ─── the guard ──────────────────────────────────────────────────────────────

const API_PREFIX = String.raw`/(?:deploy|api|spec|validate|auth)/`;

test("GUARD: every API path in src/ with an interpolation is built by apiPath", () => {
  const offenders = [];
  for (const f of readdirSync(new URL("../src/", import.meta.url)).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const line = (i) => src.slice(0, i).split("\n").length;
    // A template literal that starts with an API path and interpolates.
    for (const m of src.matchAll(new RegExp("`(" + API_PREFIX + "[^`]*?\\$\\{[^`]*)`", "g"))) {
      const tagged = src.slice(Math.max(0, m.index - 7), m.index) === "apiPath";
      if (!tagged) offenders.push(`${f}:${line(m.index)} raw template: \`${m[1].slice(0, 90)}\``);
      else if (/encodeURIComponent\(/.test(m[1])) offenders.push(`${f}:${line(m.index)} encoded twice: \`${m[1].slice(0, 90)}\``);
    }
    // A path glued together with +.
    for (const m of src.matchAll(new RegExp(`["'\`]${API_PREFIX}[^"'\`]*["'\`]\\s*\\+`, "g"))) {
      offenders.push(`${f}:${line(m.index)} concatenated: ${m[0].slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], `API paths built without apiPath:\n${offenders.join("\n")}`);
});
