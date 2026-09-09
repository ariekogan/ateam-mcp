/**
 * The connector-source surfaces tell you WHICH STORE answered.
 *
 * ateam_get_connector_source used to read Core's mcp-store — the RUNTIME
 * PROJECTION — while calling itself "source". A connector could be deployed and
 * healthy with no authored copy anywhere, and this tool would hand back the
 * running bytes as though someone had written them. An agent that then "patched
 * the current code" was editing a reconstruction of unknown provenance.
 *
 * Three tools now, and each says what it is:
 *   ateam_get_connector_source           authored source of record (+ provenance)
 *   ateam_get_deployed_connector_source  what Core runs (authored_source_of_record:false)
 *   ateam_recover_connector_source       explicit, stamped adoption of the latter
 *
 * Run: node --test test/connector-source-provenance.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tools, handlers } from "../src/tools.js";

const byName = (n) => tools.find((t) => t.name === n);

// Stand in for the Builder API. Each test sets `route` to decide what the
// endpoint returns, including the error shapes, which is where most of the
// behaviour under test lives.
let route = () => ({ ok: true });
const httpError = (status, body) => {
  const e = new Error(`A-Team API error: ${status}`);
  e.status = status;
  e.body = JSON.stringify(body);
  return e;
};

const origFetchers = {};
async function withRoute(fn, r) {
  route = r;
  try { return await fn(); } finally { route = () => ({ ok: true }); }
}

// The handlers call get/post from ../src/api.js. Rather than intercept the
// module, drive them through a thin shim: both helpers ultimately fetch, so
// stubbing global.fetch keeps this honest about the real code path.
const origFetch = global.fetch;
function stubFetch() {
  global.fetch = async (url, opts = {}) => {
    const r = route(String(url), opts);
    if (r instanceof Error) {
      return {
        ok: false, status: r.status, headers: { get: () => "application/json" },
        text: async () => r.body, json: async () => JSON.parse(r.body),
      };
    }
    return {
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => r, text: async () => JSON.stringify(r),
    };
  };
}

describe("the three surfaces are declared, and named for what they read", () => {
  test("all three tools exist and are advertised", () => {
    for (const n of ["ateam_get_connector_source", "ateam_get_deployed_connector_source", "ateam_recover_connector_source"]) {
      const t = byName(n);
      assert.ok(t, `${n} is not declared`);
      assert.equal(t.core, true, `${n} is not advertised — a connector-wildcard grant expands over advertised tools only`);
      assert.ok(handlers[n], `${n} has no handler`);
    }
  });

  test("the authored tool says it is NOT the running code", () => {
    const d = byName("ateam_get_connector_source").description;
    assert.match(d, /AUTHORED/, "the description does not say it returns authored source");
    assert.match(d, /provenance/i, "provenance is not promised to the caller");
    assert.match(d, /does NOT return what Core is currently RUNNING/i);
    assert.match(d, /ateam_get_deployed_connector_source/, "it does not point at the runtime surface");
  });

  test("the deployed tool warns against laundering runtime bytes into authored source", () => {
    const d = byName("ateam_get_deployed_connector_source").description;
    assert.match(d, /NOT the source of record/i);
    assert.match(d, /authored_source_of_record:false/);
    assert.match(d, /re-upload them as if you had authored them|launders/i);
  });

  test("recovery is described as explicit and stamped, never a deploy step", () => {
    const d = byName("ateam_recover_connector_source").description;
    assert.match(d, /never part of a deploy/i);
    assert.match(d, /recovered_from_core/);
    assert.match(d, /AUTHORED_SOURCE_EXISTS/);
    assert.ok(byName("ateam_recover_connector_source").inputSchema.properties.force,
      "no force flag — the refusal would be unescapable");
  });
});

describe("provenance rides on every answer", () => {
  test("the manifest carries provenance and scheme", async () => {
    stubFetch();
    try {
      const res = await withRoute(
        () => handlers.ateam_get_connector_source({ solution_id: "s", connector_id: "c" }, "sid"),
        () => ({ ok: true, provenance: "authored_fs", scheme: "legacy", authored_source_of_record: true,
                 files: [{ path: "server.js", content: "//x" }] }),
      );
      assert.equal(res.provenance, "authored_fs");
      assert.equal(res.scheme, "legacy");
      assert.equal(res.authored_source_of_record, true);
    } finally { global.fetch = origFetch; }
  });

  test("a single-file read carries it too — the store must not be forgettable", async () => {
    stubFetch();
    try {
      const res = await withRoute(
        () => handlers.ateam_get_connector_source({ solution_id: "s", connector_id: "c", path: "server.js" }, "sid"),
        () => ({ ok: true, provenance: "github", authored_source_of_record: true,
                 files: [{ path: "server.js", content: "// from the repo" }] }),
      );
      assert.equal(res.provenance, "github");
      assert.equal(res.content, "// from the repo");
    } finally { global.fetch = origFetch; }
  });

  test("the deployed surface always reports authored_source_of_record:false", async () => {
    stubFetch();
    try {
      const res = await withRoute(
        () => handlers.ateam_get_deployed_connector_source({ solution_id: "s", connector_id: "c" }, "sid"),
        () => ({ ok: true, provenance: "core_runtime", authored_source_of_record: false,
                 files: [{ path: "server.js", content: "// running" }] }),
      );
      assert.equal(res.authored_source_of_record, false);
      assert.equal(res.provenance, "core_runtime");
      assert.match(res.note, /not authored source/i);
    } finally { global.fetch = origFetch; }
  });

  test("even a not-found file on the deployed surface stays labelled", async () => {
    stubFetch();
    try {
      const res = await withRoute(
        () => handlers.ateam_get_deployed_connector_source({ solution_id: "s", connector_id: "c", path: "nope.js" }, "sid"),
        () => ({ ok: true, provenance: "core_runtime", files: [{ path: "server.js", content: "//" }] }),
      );
      assert.equal(res.ok, false);
      assert.equal(res.authored_source_of_record, false, "an error response dropped the label");
    } finally { global.fetch = origFetch; }
  });
});

describe("AUTHORED_SOURCE_MISSING is an answer, not a lookup failure", () => {
  test("it names the two tools that act on it, and warns against rewriting from memory", async () => {
    stubFetch();
    try {
      const res = await withRoute(
        () => handlers.ateam_get_connector_source({ solution_id: "s", connector_id: "c" }, "sid"),
        () => httpError(404, { ok: false, code: "AUTHORED_SOURCE_MISSING", deployed_in_core: true,
                               error: "No AUTHORED source for connector \"c\". Core IS running a deployed copy of it." }),
      );
      assert.equal(res.code, "AUTHORED_SOURCE_MISSING");
      assert.equal(res.deployed_in_core, true);
      assert.ok(res.next.some((n) => n.includes("ateam_get_deployed_connector_source")));
      assert.ok(res.next.some((n) => n.includes("ateam_recover_connector_source")));
      assert.match(res.warning, /Do NOT write a replacement from memory/);
    } finally { global.fetch = origFetch; }
  });

  test("with nothing in Core either, it does not offer recovery there is nothing to recover from", async () => {
    stubFetch();
    try {
      const res = await withRoute(
        () => handlers.ateam_get_connector_source({ solution_id: "s", connector_id: "c" }, "sid"),
        () => httpError(404, { ok: false, code: "AUTHORED_SOURCE_MISSING", deployed_in_core: false, error: "nothing anywhere" }),
      );
      assert.equal(res.deployed_in_core, false);
      assert.ok(res.next.some((n) => n.includes("ateam_create_connector")));
      assert.ok(!res.next.some((n) => n.includes("ateam_recover_connector_source")),
        "offered to recover a connector that is not deployed");
      assert.equal(res.warning, undefined);
    } finally { global.fetch = origFetch; }
  });

  test("an unrelated error is NOT swallowed into a missing-source answer", async () => {
    stubFetch();
    try {
      await assert.rejects(
        () => withRoute(
          () => handlers.ateam_get_connector_source({ solution_id: "s", connector_id: "c" }, "sid"),
          () => httpError(500, { ok: false, error: "boom" }),
        ),
      );
    } finally { global.fetch = origFetch; }
  });
});

describe("recovery reports its refusal as a decision, not a failure to retry past", () => {
  test("AUTHORED_SOURCE_EXISTS tells the caller to compare both copies first", async () => {
    stubFetch();
    try {
      const res = await withRoute(
        () => handlers.ateam_recover_connector_source({ solution_id: "s", connector_id: "c" }, "sid"),
        () => httpError(409, { ok: false, code: "AUTHORED_SOURCE_EXISTS", error: "already authored" }),
      );
      assert.equal(res.code, "AUTHORED_SOURCE_EXISTS");
      assert.ok(res.next.some((n) => n.includes("ateam_get_connector_source")));
      assert.ok(res.next.some((n) => n.includes("ateam_get_deployed_connector_source")));
      assert.ok(res.next.some((n) => /force:true/.test(n)));
    } finally { global.fetch = origFetch; }
  });

  test("force is passed through as a real boolean, not whatever the caller sent", async () => {
    stubFetch();
    let sentBody = null;
    try {
      await withRoute(
        () => handlers.ateam_recover_connector_source({ solution_id: "s", connector_id: "c", force: "yes" }, "sid"),
        (_u, opts) => { sentBody = JSON.parse(opts.body || "{}"); return { ok: true, provenance: "recovered_from_core", recovered: [] }; },
      );
      assert.equal(sentBody.force, false, "a truthy string was forwarded as force:true");
    } finally { global.fetch = origFetch; }
  });
});
