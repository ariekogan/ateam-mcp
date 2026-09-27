// MGAP-A15: every docs answer says which environment gave it.
//
// An agent that never signed in read the PROD docs (the process default API),
// compared them with DEV's and reported the difference — the SDK module a
// plugin imports — as a contradiction in the docs. Nothing in ateam_get_spec,
// ateam_get_examples or ateam_spec_search, nor in ateam_bootstrap, said which
// environment had answered; there was no served_by field anywhere in src.
//
// `served_by` is derived from the base the call actually went to, never
// configured: prod or dev when that base is one of KEY_ENVIRONMENTS, the base
// itself otherwise. Here every request is answered in-process (fetch is
// replaced), and each served_by is checked against the URL fetch was called
// with.
//
// Run: node --test test/served-by.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials, KEY_ENVIRONMENTS, envForBaseUrl } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const HEX = "0".repeat(32);
const OTHER = "http://127.0.0.1:9"; // never dialled: fetch is replaced below
const SESSIONS = {
  prod: { sid: "sess-served-prod", apiUrl: KEY_ENVIRONMENTS.prod, expect: "prod" },
  dev: { sid: "sess-served-dev", apiUrl: KEY_ENVIRONMENTS.dev, expect: "dev" },
  other: { sid: "sess-served-other", apiUrl: OTHER, expect: OTHER },
};

let fetched = [];
let bigDoc = null;
const realFetch = globalThis.fetch;

before(() => {
  for (const [env, s] of Object.entries(SESSIONS)) {
    setSessionCredentials(s.sid, { tenant: "tenanta", apiKey: `adas_${env === "other" ? "prod" : env}_tenanta_${HEX}`, apiUrl: s.apiUrl });
  }
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    fetched.push(u.origin);
    const path = u.pathname;
    const body =
      path === "/spec/search" ? { ok: true, query: "q", count: 0, results: [] }
      : path.startsWith("/spec/examples") ? { type: "skill", example: { id: "k" } }
      : path === "/deploy/solutions" ? { solutions: [] }
      : path.startsWith("/spec") ? (bigDoc || { topic: path.split("/").pop(), fields: { a: 1 } })
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});
after(() => { globalThis.fetch = realFetch; });

async function call(sid, tool, args) {
  fetched = [];
  const res = await handleToolCall(tool, args, sid);
  assert.ok(!res.isError, `${tool}: ${res.content[0].text.slice(0, 200)}`);
  return JSON.parse(res.content[0].text);
}

const DOC_CALLS = [
  ["ateam_get_spec", { topic: "skill" }],
  ["ateam_get_examples", { type: "skill" }],
  ["ateam_get_workflows", {}],
  ["ateam_spec_search", { query: "per-user persistence" }],
];

for (const [name, s] of Object.entries(SESSIONS)) {
  test(`${name}: every docs answer names the environment its request went to`, async () => {
    for (const [tool, args] of DOC_CALLS) {
      const out = await call(s.sid, tool, args);
      assert.ok(fetched.length > 0, `${tool} made no request`);
      const went = fetched[0];
      assert.equal(out.served_by, envForBaseUrl(went) || went, `${tool}: served_by does not name ${went}`);
      assert.equal(out.served_by, s.expect, `${tool}`);
      // First, so it is read before anything a long answer is cut at.
      assert.equal(Object.keys(out)[0], "served_by", `${tool}: served_by is not the first field`);
    }
  });
}

test("bootstrap names the same environment the session's docs calls go to", async () => {
  for (const s of Object.values(SESSIONS)) {
    const boot = await call(s.sid, "ateam_bootstrap", {});
    const spec = await call(s.sid, "ateam_get_spec", { topic: "overview" });
    assert.equal(boot.served_by, s.expect);
    assert.equal(boot.served_by, spec.served_by);
  }
});

test("a session with no sign-in names the default it actually used", async () => {
  const out = await call("sess-served-nobody", "ateam_get_spec", { topic: "capabilities" });
  assert.equal(out.served_by, envForBaseUrl(fetched[0]) || fetched[0]);
});

// get_spec's answers that are too long are rebuilt by summarizeSpecResult. Both
// shapes it can return must still say where they came from, and served_by must
// not be offered as a section of the doc.
test("an oversized spec keeps served_by — whole sections stubbed, and the index-only backstop", async () => {
  try {
    bigDoc = { topic: "device-capabilities", matrix: "x".repeat(80_000), small: { a: 1 } };
    const stubbed = await call(SESSIONS.dev.sid, "ateam_get_spec", { topic: "device-capabilities" });
    assert.ok(stubbed._truncation, "the doc was not summarized — the test did not reach that path");
    assert.equal(stubbed.served_by, "dev");
    assert.ok(!stubbed.sections.includes("served_by"), `sections: ${stubbed.sections}`);

    bigDoc = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, "x".repeat(12)]));
    const index = await call(SESSIONS.dev.sid, "ateam_get_spec", { topic: "device-capabilities" });
    assert.ok(index.section_count > 0 && !index.k0, "not the index-only backstop");
    assert.equal(index.served_by, "dev");
    assert.ok(!index.sections.includes("served_by"));
    assert.equal(index.section_count, 6000);
  } finally {
    bigDoc = null;
  }
});
