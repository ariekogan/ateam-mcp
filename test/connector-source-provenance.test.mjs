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

describe('build_and_run does not restart a phone-side connector', () => {
  // Phase 2.5 uploads source for every connector that HAS files, and a
  // runtime:"device" connector does have authored source — the RN bundle. So it
  // looked like an ordinary connector, the upload 409'd on the merge, and health
  // then marked it "error": a failed deploy for a connector working as designed.
  //
  // These used to regex src/tools.js for `deviceConnectorIds.has(connId)` and
  // `skipped: "device_runtime"` (c1534f6) — satisfied by any code spelling
  // those, reachable or not (Codex 79ee198bc3, ateam-mcp #13). They now run the
  // real handler through the fetch stub above and read what it SENT.
  //
  // Only the declared path is covered. When connectors[] is omitted and the
  // bundle is pulled from GitHub, connectors[] is synthesized from mcp_store
  // keys with no `runtime`, so this skip cannot see a device connector there;
  // pull-bundle does not return connector manifests to read it from.
  const PHONE = { id: 'phone-mcp', name: 'Phone', transport: 'stdio', runtime: 'device' };
  const SERVER = { id: 'weather-mcp', name: 'Weather', transport: 'stdio' };
  const STORE = {
    'phone-mcp': [{ path: 'rn-bundle/phone.bundle.js', content: 'module.exports = {};' }],
    'weather-mcp': [{ path: 'server.js', content: '// server' }],
  };

  // One deploy, read three ways (each run waits out the health phase's 2s).
  let ran = null;
  const buildAndRun = () => (ran ||= deploy());
  async function deploy() {
    stubFetch();
    const sent = [];
    try {
      const res = await withRoute(
        () => handlers.ateam_build_and_run({
          solution: { id: 'walkmate', name: 'Walkmate' },
          skills: [{ id: 'walk-guide', name: 'Walk Guide' }],
          connectors: [PHONE, SERVER],
          mcp_store: STORE,
        }, 'sid'),
        (url, opts) => {
          sent.push({ method: opts.method || 'GET', url });
          if (url.includes('/validate/solution')) return { valid: true, errors: [], warnings: [] };
          if (url.endsWith('/upload')) return { ok: true, tools: 3 };
          return { ok: true };
        },
      );
      return { res, sent };
    } finally { global.fetch = origFetch; }
  }

  test('the declared device connector is never uploaded; the server connector still is', async () => {
    const { sent } = await buildAndRun();
    const uploads = sent.filter((r) => r.method === 'POST' && r.url.endsWith('/upload'));
    assert.ok(uploads.some((r) => r.url.includes('/connectors/weather-mcp/upload')),
      'the ordinary connector was not uploaded — the skip swallowed more than the phone');
    assert.ok(!uploads.some((r) => r.url.includes('/connectors/phone-mcp/')),
      'the phone bundle was uploaded as a server connector — it will 409 and read as a failed deploy');
  });

  test('it is classified from the DECLARED connectors, without asking any service', async () => {
    // Asking Core would put the classification one outage away from re-breaking:
    // an unreachable Core turns the phone back into a server.
    const { sent } = await buildAndRun();
    const about = sent.filter((r) => r.url.includes('/connectors/phone-mcp'));
    assert.deepEqual(about, [], `the deploy asked about the device connector: ${JSON.stringify(about)}`);
  });

  test('a skipped device connector is reported, not silently dropped', async () => {
    const { res } = await buildAndRun();
    const restart = (res.phases || []).find((p) => p.phase === 'connector_restart');
    assert.ok(restart, `no connector_restart phase: ${JSON.stringify(res.phases)}`);
    const phone = restart.connectors.find((c) => c.id === 'phone-mcp');
    assert.deepEqual(phone, { id: 'phone-mcp', ok: true, tools: 0, skipped: 'device_runtime' },
      'the skip is invisible in the result — a reader cannot tell it was deliberate');
    assert.equal(restart.status, 'done', 'a deliberate skip made the restart phase look partial');
  });
});
