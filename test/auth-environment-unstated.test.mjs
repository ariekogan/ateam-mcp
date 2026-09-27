// A key that names no environment gets no claim about one.
//
// c35cd0e: a legacy `adas_<tenant>_<hex>` key still authenticates and lands on
// the process default — which is production. Reporting that as
// `environment: "prod"` would turn an unstated default into a confident
// assertion, so ateam_auth reports `environment: "unstated"` with a note naming
// the base it used. Nothing tested it (Codex e30f1d503f, ateam-mcp #13): reverting
// that line to envForBaseUrl(getBaseUrl(...)) kept every suite green.
//
// Behavioural: the real ateam_auth through the real dispatcher. The process
// default is a local stand-in (ADAS_API_URL, read once when src/api.js is
// imported — hence the dynamic import), so no key reaches a real host.
//
// Run: node --test test/auth-environment-unstated.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const HEX = "0123456789abcdef0123456789abcdef";
const NO_ENV_KEY = `adas_acme_${HEX}`;
const DEV_KEY = `adas_dev_acme_${HEX}`;
let server, BASE, handleToolCall;

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, solutions: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.ADAS_API_URL = BASE;
  ({ handleToolCall } = await import("../src/tools.js"));
});
after(() => server.close());

const auth = async (sid, args) => {
  const r = await handleToolCall("ateam_auth", args, sid);
  return JSON.parse(r.content[0].text);
};

test("a key that names no environment is reported as 'unstated', with the base it used", async () => {
  const out = await auth("sess-unstated-1", { api_key: NO_ENV_KEY });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.environment, "unstated", `a key naming no environment was reported as "${out.environment}"`);
  assert.ok(out.environment_note, "no note says why the environment is unstated");
  assert.ok(out.environment_note.includes(BASE), "the note does not name the base that was used");
  assert.equal(out.base_url, BASE);
});

test("a key that names its environment is reported as that environment, with no note", async () => {
  // `url` points the call at the stand-in; it is not a known host, so it does
  // not contradict the key, and the environment comes from the key.
  const out = await auth("sess-unstated-2", { api_key: DEV_KEY, url: BASE });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.environment, "dev");
  assert.equal(out.environment_note, undefined);
});
