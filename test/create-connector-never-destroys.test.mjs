// CREATE NEVER DESTROYS (CORE) — ateam_create_connector and ateam_create_plugin
// against the Builder's create-only upload (Builder #160).
//
// ateam_create_connector uploaded its scaffold with replace:true (575e993, "this
// is a NEW connector") and never checked that the id was new; replace:true
// deletes every file the upload lacks — from Core, the Builder's source and the
// repo's working branch — so create on an existing id swapped that connector for
// a skeleton. The check that replaced it (GET …/source first) read a failed read
// as "new", and left a window between the question and the upload. Now there is
// no question: create POSTs `{ files, if_absent: true }` (a plugin:
// `{ files, if_absent: { plugin }, async: true }`) and the Builder checks its
// source, the repo's working branch and Core, and writes, in ONE request under
// its per-connector lock. ateam-mcp reads the answer:
//
//   200 + create_only (the scope)  created
//   409 CONNECTOR_EXISTS / PLUGIN_EXISTS (found_in)    refused, names where
//   502 CONNECTOR_UNREADABLE (retryable, unreadable)  refused: a failed read is not "absent"
//   409 CONNECTOR_BASE_MISSING / UPLOAD_WOULD_DELETE   create_plugin refusals
//   400 INVALID_IF_ABSENT
//   200 WITHOUT create_only  an older Builder that ignored the field: a failure
//
// and never falls back to replace:true.
//
// THE MIDDLE PATH (Builder #160, chosen 2026-10-04). A binary, or a file over
// 512 KB, that Core runs cannot be read back, so a merge that does not carry it
// drops it. A CREATE (if_absent: create_plugin's merge) that would is refused,
// UPLOAD_WOULD_DELETE, and its refusal never offers replace:true (that deletes
// the rest of the connector: the agent holds only the plugin's files). Any other
// upload (a plain merge, github:true) goes through and WARNS: the reply carries
// dropped[] and dropped_warning, and what Core's build writes again is listed in
// regenerated[], not as lost. The texts below say exactly that, no more.
//
// Run: node --test test/create-connector-never-destroys.test.mjs
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

const SID = "sess-create-never-destroys";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const CORE_DESCRIPTION_CUT = 1200;

// ── A stand-in Builder. Each test sets what the upload route answers. ─────────
let uploadReply = () => [200, { ok: true, create_only: "connector" }];   // (body, n) → [status, json | string]
let jobs = {};                                                            // job_id → job entry
let nextJob = 0;
const requests = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      requests.push({ method: req.method, path, body });
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": typeof payload === "string" ? "text/html" : "application/json" });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      if (req.method === "POST" && path.endsWith("/upload")) {
        const n = requests.filter((r) => r.method === "POST" && r.path.endsWith("/upload")).length;
        const [status, payload] = uploadReply(body, n);
        if (body?.async === true && typeof payload === "object" && payload?.__job) {
          // The async door: accepted at once; the job carries the result.
          const id = payload.__job.id || `job_${++nextJob}`;
          jobs[id] = payload.__job.entry;
          return send(202, { ok: true, async: true, job_id: id });
        }
        return send(status, payload);
      }
      const job = /\/deploy\/jobs\/([^/]+)$/.exec(path);
      if (req.method === "GET" && job) return send(jobs[job[1]] ? 200 : 404, jobs[job[1]] || { ok: false, error: "no such job" });
      if (req.method === "GET" && path.endsWith("/ui-plugins")) {
        return send(200, { ok: true, plugins: [{ id: "mcp:demo-mcp:walk", render: { mode: "adaptive", iframeUrl: "/ui/walk/index.html" } }] });
      }
      return send(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());
beforeEach(() => { requests.length = 0; jobs = {}; nextJob = 0; uploadReply = () => [200, { ok: true, create_only: "connector" }]; });

const uploads = () => requests.filter((r) => r.method === "POST" && r.path.endsWith("/upload"));
const text = (r) => r.content?.[0]?.text || "";
const create = (connector_id = "walk-mcp") => handleToolCall("ateam_create_connector", { solution_id: "walkmate", connector_id }, SID);
const createPlugin = (connector_id = "demo-mcp", plugin_name = "walk", kind = "iframe") =>
  handleToolCall("ateam_create_plugin", { solution_id: "walkmate", connector_id, plugin_name, kind }, SID);

/** create_plugin polls a job every 2s and verifies the catalog after 1.5s: do not wait them out. */
async function fast(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...rest) => real(f, ms >= 1500 && ms <= 2500 ? 0 : ms, ...rest);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}
/** An async door that answers with this job entry. */
const asJob = (entry, id) => [202, { __job: { id, entry } }];
/** A job entry as the Builder stores a refused upload: the body plus http_status, status "failed". */
const refusedJob = (httpStatus, body) => ({ status: "failed", ok: false, http_status: httpStatus, ...body });

// ── ateam_create_connector ───────────────────────────────────────────────────

test("a new id: ONE upload, { files, if_absent: true } with no replace and no earlier read", async () => {
  const r = await create();
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.ok, true);
  assert.equal(requests.length, 1, `create made ${requests.length} requests: ${requests.map((q) => `${q.method} ${q.path}`)}`);
  const sent = uploads()[0].body;
  assert.equal(sent.if_absent, true);
  assert.ok(!("replace" in sent), "create sent replace");
  assert.ok(Array.isArray(sent.files) && sent.files.some((f) => f.path === "server.js"), "the scaffold was not sent");
});

test("CONNECTOR_EXISTS: refused, names where it was found, and the next step differs per place", async () => {
  uploadReply = () => [409, { ok: false, code: "CONNECTOR_EXISTS", connector_id: "walk-mcp", found_in: [{ where: "builder", paths: ["server.js", "package.json"] }, { where: "github", branch: "dev", paths: ["server.js"] }] }];
  const both = JSON.parse(text(await create()));
  assert.equal(both.code, "CONNECTOR_EXISTS");
  assert.match(both.error, /already exists: the Builder's source \(server\.js, package\.json\); the repo's dev branch \(server\.js\)/);
  assert.match(both.error, /Create never replaces, so nothing was created or uploaded/);
  assert.ok(both.next.some((n) => /ateam_get_connector_source\(.*\) reads it; change it with ateam_github_patch.*ateam_upload_connector\(.*github:true\)/.test(n)), both.next.join(" | "));
  assert.equal(uploads().length, 1, "create went on to a second upload after the refusal");

  // R7: a connector only CORE runs is read with the DEPLOYED-source tool and adopted, not read as authored source or patched in the repo.
  uploadReply = () => [409, { ok: false, code: "CONNECTOR_EXISTS", found_in: [{ where: "core", paths: ["server.js"] }] }];
  const onlyCore = JSON.parse(text(await create()));
  const next = onlyCore.next.join(" | ");
  assert.match(next, /ateam_get_deployed_connector_source\(.*\) shows what Core runs, and ateam_recover_connector_source\(.*\) adopts it as the Builder's source/);
  assert.doesNotMatch(next, /ateam_get_connector_source|ateam_github_patch/, "a Core-only connector is sent to tools that read the authored source");
});

test("CONNECTOR_UNREADABLE (502, retryable): refused, names the layers, says retry — and never replaces", async () => {
  uploadReply = () => [502, { ok: false, code: "CONNECTOR_UNREADABLE", retryable: true, unreadable: [{ where: "core", error: "Core answered 500", cause_code: "HTTP_500" }, { where: "github", error: "TREE_TRUNCATED" }] }];
  const r = await create();
  assert.equal(r.isError, true, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.code, "CONNECTOR_UNREADABLE");
  assert.equal(out.retryable, true);
  assert.match(out.error, /core \(Core answered 500\); github \(TREE_TRUNCATED\)/);
  assert.match(out.error, /an unreadable answer is not an empty one/);
  assert.ok(out.next.some((n) => /Retry the same call/.test(n)), out.next.join(" | "));
  assert.ok(out.next.some((n) => /Never create it with replace:true/.test(n)));
  assert.equal(uploads().length, 1);
  assert.ok(!("replace" in uploads()[0].body));
});

test("INVALID_IF_ABSENT (400): refused with the Builder's reason", async () => {
  uploadReply = () => [400, { ok: false, code: "INVALID_IF_ABSENT", error: "if_absent cannot be combined with replace. Nothing was read or written." }];
  const out = JSON.parse(text(await create()));
  assert.equal(out.code, "INVALID_IF_ABSENT");
  assert.match(out.error, /cannot be combined with replace/);
});

test("a 200 WITHOUT create_only (an older Builder that ignored if_absent): a failure, never 'created'", async () => {
  uploadReply = () => [200, { ok: true, tools: 1 }];
  const r = await create();
  assert.equal(r.isError, true, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.code, "BUILDER_CANNOT_CREATE_SAFELY");
  assert.match(out.error, /This Builder cannot create safely yet/);
  assert.equal(out.files_created, undefined, "a create that may have overwritten reported its files as created");
  assert.equal(uploads().length, 1, "create retried with replace:true on an older Builder");
});

// AM50-R3: the old client-side check read GET …/source, and "any 404 = new"
// let a connector be replaced. There is no such read now; what remains of that
// rule is that NOTHING but 200 + create_only is "created", and nothing is sent a
// second time as a replace. Each answer below must be a refusal or an error and
// leave exactly ONE upload, with if_absent and without replace.
for (const [name, reply] of [
  ["404 with a code of its own", [404, { ok: false, code: "AUTHORED_SOURCE_MISSING", deployed_in_core: false }]],
  ["404 that is not JSON (a gateway page)", [404, "<html>Cannot POST</html>"]],
  ["404 JSON with no code", [404, { ok: false, error: "Connector 'walk-mcp' not found in mcp-store" }]],
  ["500 from the Builder (Core's read failed under it)", [500, { ok: false, error: "Core answered 500" }]],
  ["502 that is not the Builder's verdict (a gateway)", [502, "Bad gateway"]],
  ["409 with no known code (an older Builder's 'no existing base')", [409, { ok: false, error: "Partial-file upload with no existing base. Set replace:true." }]],
]) {
  test(`create on a ${name}: not created, no second upload, never replace:true`, async () => {
    uploadReply = () => reply;
    const r = await create();
    assert.equal(r.isError, true, `${name} was reported as a success: ${text(r)}`);
    assert.doesNotMatch(text(r), /"files_created"/);
    assert.equal(uploads().length, 1, `create sent ${uploads().length} uploads after a ${name}`);
    assert.equal(uploads()[0].body.if_absent, true);
    assert.ok(!("replace" in uploads()[0].body), "create sent replace");
    assert.equal(requests.filter((q) => q.method === "GET").length, 0, "create read something before or after the upload");
  });
}

// ── ateam_create_plugin ──────────────────────────────────────────────────────

test("create_plugin: { files, if_absent: { plugin }, async: true }; success carries create_only plugin", async () => {
  uploadReply = () => asJob({ status: "done", ok: true, http_status: 200, create_only: "plugin", tools: 1 }, "job_a");
  const r = await fast(() => createPlugin());
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.ok, true);
  assert.equal(out.plugin_id, "mcp:demo-mcp:walk");
  const sent = uploads()[0].body;
  assert.deepEqual(sent.if_absent, { plugin: "walk" });
  assert.equal(sent.async, true);
  assert.ok(!("replace" in sent));
  assert.equal(uploads().length, 1);
});

test("create_plugin, a job that finished WITHOUT create_only (older Builder): a failure", async () => {
  uploadReply = () => asJob({ status: "done", ok: true, http_status: 200, tools: 1 }, "job_b");
  const r = await fast(() => createPlugin());
  assert.equal(r.isError, true, text(r));
  assert.equal(JSON.parse(text(r)).code, "BUILDER_CANNOT_CREATE_SAFELY");
});

test("create_plugin, PLUGIN_EXISTS in the job's result: refused, names where, and offers another name", async () => {
  uploadReply = () => asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "walk", connector_id: "demo-mcp", found_in: [{ where: "github", branch: "dev", paths: ["ui-dist/walk/index.html"] }] }), "job_c");
  const r = await fast(() => createPlugin());
  assert.equal(r.isError, true, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.code, "PLUGIN_EXISTS");
  assert.equal(out.plugin, "walk");
  assert.match(out.error, /Plugin "walk" of connector "demo-mcp" already has files: the repo's dev branch \(ui-dist\/walk\/index\.html\)/);
  assert.ok(out.next.some((n) => /create the plugin under another name/.test(n)));
});

test("create_plugin, CONNECTOR_BASE_MISSING: tells the author to create the connector first", async () => {
  uploadReply = () => asJob(refusedJob(409, { code: "CONNECTOR_BASE_MISSING", connector_id: "demo-mcp" }), "job_d");
  const out = JSON.parse(text(await fast(() => createPlugin())));
  assert.equal(out.code, "CONNECTOR_BASE_MISSING");
  assert.match(out.next.join(" | "), /Create the connector first: ateam_create_connector\(.*\), then ateam_create_plugin again/);
});

test("create_plugin, UPLOAD_WOULD_DELETE: names the files Core runs that the Builder cannot read back, and says a create does not accept the loss", async () => {
  uploadReply = () => asJob(refusedJob(409, { code: "UPLOAD_WOULD_DELETE", connector_id: "demo-mcp", would_delete_unreadable: [{ path: "assets/icon.png", reason: "binary_not_round_trippable" }] }), "job_e");
  const out = JSON.parse(text(await fast(() => createPlugin())));
  assert.equal(out.code, "UPLOAD_WOULD_DELETE");
  assert.match(out.error, /would delete files Core runs and the Builder cannot read back \(assets\/icon\.png\): a create does not accept that loss\. Nothing was uploaded\./);
  const next = out.next.join(" | ");
  assert.match(next, /ateam_get_deployed_connector_source\(.*\) lists what Core runs/);
  assert.match(next, /commit each original under connectors\/demo-mcp\/ on the repo's working branch, then create the plugin again/);
  assert.match(next, /only the user can decide to lose them/);
});

// AM50-R10. The agent that gets a create_plugin refusal holds only the plugin's
// scaffold. "replace:true" with it would delete server.js and every other file
// of the connector from Core, the Builder's source and dev, so no create
// refusal offers it. (A refusal may say NEVER to use it; it may not say to.)
test("no create refusal offers replace:true as a way out", async () => {
  const bodies = {
    UPLOAD_WOULD_DELETE: [409, { code: "UPLOAD_WOULD_DELETE", would_delete_unreadable: [{ path: "assets/icon.png" }] }],
    PLUGIN_EXISTS: [409, { code: "PLUGIN_EXISTS", plugin: "walk", found_in: [{ where: "builder", paths: ["ui-dist/walk/index.html"] }] }],
    CONNECTOR_EXISTS: [409, { code: "CONNECTOR_EXISTS", found_in: [{ where: "core", paths: ["server.js"] }] }],
    CONNECTOR_BASE_MISSING: [409, { code: "CONNECTOR_BASE_MISSING" }],
    CONNECTOR_UNREADABLE: [502, { code: "CONNECTOR_UNREADABLE", retryable: true, unreadable: [{ where: "core", error: "x" }] }],
    INVALID_IF_ABSENT: [400, { code: "INVALID_IF_ABSENT", error: "if_absent is invalid" }],
  };
  const seen = [];
  for (const [code, reply] of Object.entries(bodies)) {
    for (const [what, run] of [["create_plugin", () => fast(() => createPlugin("offer-mcp", `offer-${code.toLowerCase().replace(/_/g, "-")}`))], ["create_connector", () => create(`offer-${code.toLowerCase().replace(/_/g, "-")}`)]]) {
      uploadReply = () => reply;
      const r = await run();
      let out;
      try { out = JSON.parse(text(r)); } catch { continue; }   // an error the tool rethrows as text
      if (out.code !== code) continue;   // a refusal only one of the two tools makes
      seen.push(`${what}:${code}`);
      const wholeReply = JSON.stringify(out);
      for (const m of wholeReply.matchAll(/replace:true/g)) {
        const before = wholeReply.slice(Math.max(0, m.index - 60), m.index);
        assert.match(before, /\b(never|not|n't)\b[^.]*$/i, `${what} ${code} offers replace:true: …${before}replace:true`);
      }
      assert.doesNotMatch(wholeReply, /ateam_upload_connector\([^)]*replace:true/, `${what} ${code} points at ateam_upload_connector with replace:true`);
    }
  }
  assert.ok(seen.includes("create_plugin:UPLOAD_WOULD_DELETE") && seen.includes("create_plugin:PLUGIN_EXISTS") && seen.includes("create_connector:CONNECTOR_EXISTS"), `the refusals checked: ${seen}`);
});

test("create_plugin, CONNECTOR_UNREADABLE in the job's result: retryable, nothing created", async () => {
  uploadReply = () => asJob(refusedJob(502, { code: "CONNECTOR_UNREADABLE", retryable: true, unreadable: [{ where: "builder", error: "ENOENT" }] }), "job_f");
  const out = JSON.parse(text(await fast(() => createPlugin())));
  assert.equal(out.code, "CONNECTOR_UNREADABLE");
  assert.equal(out.retryable, true);
});

test("create_plugin, INVALID_IF_ABSENT in the job's result", async () => {
  uploadReply = () => asJob(refusedJob(400, { code: "INVALID_IF_ABSENT", error: "if_absent needs the files to create. Nothing was read or written." }), "job_g");
  assert.equal(JSON.parse(text(await fast(() => createPlugin()))).code, "INVALID_IF_ABSENT");
});

test("create_plugin, a job that failed with none of these: a failure with its code and http_status, not a success", async () => {
  uploadReply = () => asJob(refusedJob(502, { code: "CORE_UPLOAD_FAILED", error: "Core refused the upload" }), "job_h");
  const r = await fast(() => createPlugin());
  assert.equal(r.isError, true, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.code, "CORE_UPLOAD_FAILED");
  assert.equal(out.http_status, 502);
  assert.equal(out.plugin_id, undefined, "a failed upload went on to verify and report a plugin");
});

// AM50-R12. The sync fallback happens only when the kick was provably NOT
// accepted (never sent, 404, 405), so no job of this call can be behind it: its
// PLUGIN_EXISTS is the plain refusal. (It used to say an earlier attempt of the
// same call "was accepted before this one, and may be what created it".)
test("create_plugin, the async door missing (405) falls back to ONE sync upload; its PLUGIN_EXISTS is the plain refusal, with no 'earlier attempt'", async () => {
  uploadReply = (body) => (body?.async === true ? [405, { ok: false, error: "method not allowed" }]
    : [409, { ok: false, code: "PLUGIN_EXISTS", plugin: "walk", found_in: [{ where: "builder", paths: ["ui-dist/walk/index.html"] }] }]);
  const out = JSON.parse(text(await fast(() => createPlugin("sync-mcp", "sync"))));
  assert.equal(out.code, "PLUGIN_EXISTS");
  assert.match(out.error, /^Plugin "walk" of connector "sync-mcp" already has files: the Builder's source \(ui-dist\/walk\/index\.html\)\. Create never replaces, so nothing was created or uploaded\./);
  assert.doesNotMatch(out.error, /earlier attempt|was accepted|may be what created it/, out.error);
  assert.equal(out.earlier_job_id, undefined);
  assert.equal(uploads().length, 2);
  assert.deepEqual(uploads()[1].body.if_absent, { plugin: "sync" });
  assert.ok(!("replace" in uploads()[1].body), "the sync fallback sent replace");
});

// PR160-R5. A PLUGIN_EXISTS after an async job THIS server already accepted for
// the same plugin may be that job's own work: read the job, say what it did.
test("create_plugin repeated after its job created the plugin: 'created by the earlier job', with the job id — not a refusal", async () => {
  uploadReply = (body, n) => (n === 1
    ? asJob({ status: "done", ok: true, http_status: 200, create_only: "plugin", tools: 1 }, "job_first")
    : asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "walk", found_in: [{ where: "core", paths: ["ui-dist/walk/index.html"] }] }), "job_second"));
  assert.ok(!(await fast(() => createPlugin("late-mcp", "later"))).isError);
  const r = await fast(() => createPlugin("late-mcp", "later"));
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.code, "PLUGIN_CREATED_BY_EARLIER_JOB");
  assert.equal(out.job_id, "job_first");
  assert.equal(out.created_now, false);
  assert.match(out.note, /The plugin was created by the earlier job job_first; nothing new was written by this call\. Check that job's result/);
  assert.equal(out.upload_result.create_only, "plugin");
});

test("create_plugin repeated while its first job still runs: 'in progress', with the job id", async () => {
  uploadReply = (body, n) => (n === 1
    ? asJob({ status: "done", ok: true, http_status: 200, create_only: "plugin" }, "job_run")
    : asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "walk", found_in: [{ where: "builder", paths: ["ui-dist/walk/index.html"] }] }), "job_two"));
  await fast(() => createPlugin("busy-mcp", "busy"));
  jobs.job_run = { status: "in_progress", job_id: "job_run" };   // the first job, read again: not finished
  const r = await fast(() => createPlugin("busy-mcp", "busy"));
  assert.equal(r.isError, true, text(r));
  const out = JSON.parse(text(r));
  assert.equal(out.code, "PLUGIN_CREATE_IN_PROGRESS");
  assert.equal(out.job_id, "job_run");
  assert.equal(out.retryable, true);
});

test("create_plugin repeated after a first job that FAILED: the plain PLUGIN_EXISTS refusal, naming that job", async () => {
  uploadReply = (body, n) => (n === 1
    ? asJob(refusedJob(502, { code: "CORE_UPLOAD_FAILED", error: "x" }), "job_bad")
    : asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "walk", found_in: [{ where: "builder", paths: ["ui-dist/walk/index.html"] }] }), "job_two"));
  await fast(() => createPlugin("bad-mcp", "bad"));
  const out = JSON.parse(text(await fast(() => createPlugin("bad-mcp", "bad"))));
  assert.equal(out.code, "PLUGIN_EXISTS");
  assert.equal(out.earlier_job_id, "job_bad");
  assert.match(out.error, /An earlier create of this plugin \(job job_bad\) was accepted by this server and failed\./);
  assert.doesNotMatch(out.error, /this session/, "the record is this server's, not a session's");
});

// AM50-R14. Jobs are remembered by THIS server, in memory: a create by another
// ateam-mcp process, or before a restart, is not known, and the refusal says so
// instead of telling the author the files are someone else's.
test("a PLUGIN_EXISTS with no earlier job known stays a refusal, and says a create elsewhere or before a restart is unknown here", async () => {
  uploadReply = () => asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "walk", found_in: [{ where: "builder", paths: ["ui-dist/walk/index.html"] }] }), "job_x");
  const out = JSON.parse(text(await fast(() => createPlugin("fresh-mcp", "fresh"))));
  assert.equal(out.code, "PLUGIN_EXISTS");
  assert.equal(out.earlier_job_id, undefined);
  assert.match(out.error, /A create by another ateam-mcp process or before a restart is unknown here, so these may be the files of one\./);
  assert.doesNotMatch(out.error, /this session/);
});

// AM50-R13. settleAgainstEarlierJob says "created by the earlier job" only for a
// job that is done AND ended with create_only "plugin". A job that is done
// without it (a Builder that ignored if_absent) made nothing it can vouch for.
test("an earlier job that is done but has no create_only is NOT 'created by the earlier job': the plain PLUGIN_EXISTS", async () => {
  uploadReply = (body, n) => (n === 1
    ? asJob(refusedJob(502, { code: "CORE_UPLOAD_FAILED", error: "x" }), "job_dn")   // failed some other way: stays remembered
    : asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "walk", found_in: [{ where: "builder", paths: ["ui-dist/walk/index.html"] }] }), "job_dn_two"));
  await fast(() => createPlugin("done-mcp", "donenot"));
  jobs.job_dn = { status: "done", ok: true, http_status: 200, job_id: "job_dn" };   // read again later: done, but no create_only
  const r = await fast(() => createPlugin("done-mcp", "donenot"));
  const out = JSON.parse(text(r));
  assert.equal(r.isError, true, text(r));
  assert.equal(out.code, "PLUGIN_EXISTS");
  assert.notEqual(out.ok, true);
  assert.equal(out.earlier_job_id, "job_dn");
  assert.match(out.error, /\(job job_dn\) was accepted by this server and finished without creating it\./);
});

// AM50-R11. The earlier job was found by the plugin's NAME only. iframe, then
// adaptive: the second call was answered ok:true "created by the earlier job",
// though rn-src and rn-bundle were never written, and its own refused job then
// replaced the record of the job that had written the plugin. The key is the
// scaffold now, and a refused job is never the record.
test("another kind of the same plugin is NOT 'created by the earlier job'; the first job's record stays", async () => {
  uploadReply = (body, n) => (n === 1
    ? asJob({ status: "done", ok: true, http_status: 200, create_only: "plugin" }, "job_iframe")
    : asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "kinds", found_in: [{ where: "core", paths: ["ui-dist/kinds/index.html"] }] }), `job_refused_${n}`));
  assert.ok(!(await fast(() => createPlugin("kind-mcp", "kinds", "iframe"))).isError);
  const other = await fast(() => createPlugin("kind-mcp", "kinds", "adaptive"));
  assert.equal(other.isError, true, text(other));
  const refused = JSON.parse(text(other));
  assert.equal(refused.code, "PLUGIN_EXISTS", text(other));
  assert.notEqual(refused.ok, true);
  assert.equal(refused.job_id, undefined);
  assert.equal(refused.earlier_job_id, undefined, "the iframe job was offered as the earlier job of an adaptive scaffold");
  // The same iframe scaffold again is still known to have been made by job_iframe.
  const again = JSON.parse(text(await fast(() => createPlugin("kind-mcp", "kinds", "iframe"))));
  assert.equal(again.code, "PLUGIN_CREATED_BY_EARLIER_JOB");
  assert.equal(again.job_id, "job_iframe");
});

test("a later job the Builder refused does not replace the record of the job that made the plugin", async () => {
  uploadReply = (body, n) => (n === 1
    ? asJob({ status: "done", ok: true, http_status: 200, create_only: "plugin" }, "job_made")
    : asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "kept", found_in: [{ where: "core", paths: ["ui-dist/kept/index.html"] }] }), `job_late_${n}`));
  await fast(() => createPlugin("keep-mcp", "kept"));
  for (let i = 0; i < 3; i++) {
    const out = JSON.parse(text(await fast(() => createPlugin("keep-mcp", "kept"))));
    assert.equal(out.code, "PLUGIN_CREATED_BY_EARLIER_JOB", `repeat ${i + 1}: ${JSON.stringify(out).slice(0, 300)}`);
    assert.equal(out.job_id, "job_made", `repeat ${i + 1} read ${out.job_id}: a refused job replaced the record`);
  }
});

test("a job the Builder refused is not remembered: the next refusal names no earlier job", async () => {
  uploadReply = (body, n) => asJob(refusedJob(409, { code: "PLUGIN_EXISTS", plugin: "p", found_in: [{ where: "builder", paths: ["ui-dist/p/index.html"] }] }), `job_ref_${n}`);
  await fast(() => createPlugin("refd-mcp", "refd"));
  const out = JSON.parse(text(await fast(() => createPlugin("refd-mcp", "refd"))));
  assert.equal(out.code, "PLUGIN_EXISTS");
  assert.equal(out.earlier_job_id, undefined, "a refused create wrote nothing and was remembered as the earlier job");
});

// ── The texts ────────────────────────────────────────────────────────────────

test("ateam_create_connector says it never replaces, where the Builder checks, and what it answers instead", () => {
  const d = tools.find((x) => x.name === "ateam_create_connector").description;
  assert.match(d, /Create never replaces: the Builder writes the scaffold only if the connector exists nowhere \(its source, the repo's working branch, Core\)/);
  assert.match(d, /CONNECTOR_EXISTS names where/);
  assert.match(d, /a retryable CONNECTOR_UNREADABLE/);
  assert.match(d, /Nothing is uploaded either way/);
  assert.ok(d.length <= CORE_DESCRIPTION_CUT, `${d.length} characters`);
  assert.doesNotMatch(d, /cannot be read, the create is refused too|authored source, or code Core runs/, "the client-side check is still described");
});

// AM50-R15. Core cuts every tool description at 1200 characters for an in-app
// agent; this sentence sat at character 1822, so that agent never read that a
// create is refused. It also says what create DOES, not that nothing can be
// lost: writers outside the Builder's upload route are not under its lock.
test("ateam_create_plugin says what a create does inside Core's cut: one create-only request, refused if it exists, no fallback to replace", () => {
  const d = tools.find((x) => x.name === "ateam_create_plugin").description;
  const seen = d.slice(0, CORE_DESCRIPTION_CUT);
  assert.match(seen, /ONE create-only request: refused with PLUGIN_EXISTS if this plugin's files exist anywhere, CONNECTOR_BASE_MISSING if the connector does not; never falls back to replace\./);
  assert.ok(d.indexOf("PLUGIN_EXISTS") < CORE_DESCRIPTION_CUT && d.indexOf("CONNECTOR_BASE_MISSING") < CORE_DESCRIPTION_CUT, "a refusal code sits past Core's cut");
  assert.doesNotMatch(d, /Create never replaces: a plugin file that exists anywhere/, "the old sentence, past the cut, is still served");
  // What the instruction to add a hardcoded plugin there says is still read.
  assert.match(seen, /you MUST add this plugin there \(copy the manifest\.json render block\)\./);
});

test("no create text promises that nothing can be lost", () => {
  for (const name of ["ateam_create_connector", "ateam_create_plugin"]) {
    const d = tools.find((x) => x.name === name).description;
    assert.doesNotMatch(d, /nothing (can|will|could) (ever )?be (lost|deleted|overwritten)|never (lose|loses|delete|deletes|overwrite)|cannot (lose|destroy)|cannot be lost/i, `${name} promises more than the Builder guarantees`);
  }
});

const upload = () => tools.find((x) => x.name === "ateam_upload_connector");

// AM50-R4, the middle path: what "a file you leave out is kept" is qualified by,
// inside the first 1200 characters an in-app agent reads. A merge goes through
// and WARNS; it is a CREATE that refuses, and that is the create's text.
test("ateam_upload_connector qualifies 'a file you leave out is kept' for files Core cannot hand back: dropped, and the reply says so — inside Core's cut", () => {
  const d = upload().description;
  const seen = d.slice(0, CORE_DESCRIPTION_CUT);
  assert.match(seen, /A file you leave out is kept, except a binary or a file over 512 KB that Core runs: it is dropped, and the reply's dropped\[\] and dropped_warning name it\./);
  assert.match(seen, /over the files Core ALREADY runs/);
  assert.doesNotMatch(d, /dropping it is refused|unless replace:true|UPLOAD_WOULD_DELETE/, "a merge is described as refused: the Builder lets it through and warns");
});

test("the files parameter says a merge or github:true upload drops such a file with a warning, and where Core's build output is listed", () => {
  const p = upload().inputSchema.properties.files.description;
  assert.match(p, /A merge or github:true upload that leaves out a binary or a file over 512 KB that Core runs goes through and drops it: the reply's dropped\[\] and dropped_warning name it\./);
  assert.match(p, /A built file under ui-dist\/ or rn-bundle\/ that a build script of the package\.json you send writes again on every upload is listed in regenerated\[\], not as lost; a binary never is\./);
});

// The reply is the Builder's, passed through whole: dropped[], dropped_warning
// and regenerated[] reach the author, which is what the two texts above promise.
test("an upload's dropped[], dropped_warning and regenerated[] reach the caller untouched", async () => {
  const entry = {
    status: "done", ok: true, http_status: 200,
    dropped: [{ path: "assets/icon.png", reason: "binary_not_round_trippable" }],
    dropped_warning: "1 deployed file(s) were REMOVED by this upload: assets/icon.png — see dropped[] for why.",
    regenerated: [{ path: "ui-dist/app.js", by: "Core's build script" }],
  };
  uploadReply = () => asJob(entry, "job_up");
  const r = await fast(() => handleToolCall("ateam_upload_connector", { solution_id: "walkmate", connector_id: "up-mcp", files: [{ path: "server.js", content: "x" }] }, SID));
  assert.ok(!r.isError, text(r));
  const out = JSON.parse(text(r));
  assert.deepEqual(out.dropped, entry.dropped);
  assert.equal(out.dropped_warning, entry.dropped_warning);
  assert.deepEqual(out.regenerated, entry.regenerated);
  assert.ok(!("replace" in uploads()[0].body), "a plain upload sent replace");
});

test("ateam_upload_connector says what replace:true deletes, and from where — inside Core's cut", () => {
  const d = upload().description;
  const seen = d.slice(0, CORE_DESCRIPTION_CUT);
  assert.match(seen, /Every other file is DELETED from Core, from the Builder's source and, when GitHub is connected, from the repo's working branch \(dev\), deployed or not — files written with ateam_github_patch included\./);
  assert.match(d, /Some files are kept — repo\.kept names each with its reason\./);
  assert.doesNotMatch(d, /Wipes connector dir \+ writes only the provided files/, "the old, incomplete claim is still served");
  assert.doesNotMatch(d, /WITHOUT redeploying skills/, "the old claim about skills is still served");
});

test("ateam_upload_connector names the refusals: CONNECTOR_BASE_MISSING points at create, a failed read is a retryable CONNECTOR_UNREADABLE", () => {
  const d = upload().description;
  assert.match(d, /Nothing is written with no base \(409 CONNECTOR_BASE_MISSING: a new connector is ateam_create_connector's\) or a failed read \(retryable 502 CONNECTOR_UNREADABLE\)\./);
  assert.doesNotMatch(d, /Refused when there is no base at all/, "the old no-base wording is still served");
});

// AM50-R8: the replace parameter (not cut by Core) names every field the reply
// uses for what was deleted and what was kept.
test("the replace parameter names repo.kept, dropped, authored.removed, repo.deleted and repo.branch_only", () => {
  const p = upload().inputSchema.properties.replace.description;
  assert.match(p, /from Core, from the Builder's source and, when GitHub is connected, from the repo's working branch \(dev\)/);
  assert.match(p, /deployed or not, files written with ateam_github_patch included/);
  assert.match(p, /some files are kept — repo\.kept names each with its reason/);
  assert.match(p, /The reply names each: dropped \(Core\), authored\.removed \(the Builder's source\), repo\.deleted \(the branch\), repo\.branch_only \(the branch files that were never deployed\), repo\.kept \(kept, with the reason\)\./);
  assert.match(p, /Main is never touched/);
  assert.match(p, /With github:true the repo is left as it is/);
  assert.doesNotMatch(JSON.stringify(upload()), /not known text is kept/, "the text says only not-known-text files are kept");
  assert.doesNotMatch(p, /only way to accept dropping|UPLOAD_WOULD_DELETE/, "replace:true is offered as the way past a refusal the Builder no longer makes for a merge");
});

test("no text names a dev host", () => {
  for (const name of ["ateam_upload_connector", "ateam_create_connector", "ateam_create_plugin"]) {
    const t = tools.find((x) => x.name === name);
    assert.doesNotMatch(JSON.stringify(t), /dev-api|dev-builder|adas_dev_/, name);
  }
});
