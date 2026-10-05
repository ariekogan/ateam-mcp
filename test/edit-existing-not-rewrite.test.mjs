// An existing connector file is edited by search/replace, never rewritten whole.
//
// On 2026-10-05 one in-app builder step took 948s; 563s were two model turns
// each streaming one huge file (~22,000 tokens). ateam_github_write called
// itself "the PRIMARY way to write connector code" and "replace existing
// ones", so agents (outside ones and the in-app builder, which gets this text
// through a pass-through) resent whole files for small changes.
//
// Run: node test/edit-existing-not-rewrite.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { handlers, tools } from "../src/tools.js";

const desc = (n) => tools.find((t) => t.name === n).description;

test("ateam_github_write is for NEW files and no longer 'the primary way' or 'replace existing'", () => {
  const d = desc("ateam_github_write");
  assert.doesNotMatch(d, /PRIMARY way/);
  assert.doesNotMatch(d, /replace existing ones/);
  assert.match(d, /NEW file/);
  assert.match(d, /ALREADY EXISTS is changed with ateam_github_patch search\/replace/);
});

test("ateam_github_patch says to always use search/replace for an existing file", () => {
  assert.match(desc("ateam_github_patch"), /Always use search\/replace/);
});

test("the developer-loop text agrees: write = NEW, patch = existing", async () => {
  const out = JSON.stringify(await handlers.ateam_bootstrap({}, "t"));
  assert.match(out, /Write NEW connector files/);
  assert.match(out, /Edit EXISTING files with search\/replace, always/);
});

// ── The tool checks for misuse: a whole-file overwrite that is mostly unchanged
// still saves, and the reply says to use search/replace next time.
// Threshold: old file over 3 KB AND at least 80% of its lines unchanged.
import { rewriteHint } from "../src/tools.js";
import { createServer as createHttpServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const lines = (n, tag = "a") => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i}; // padding to make the file big enough`).join("\n");

test("hint: a NEW file (nothing to compare) gets no hint", () => {
  assert.equal(rewriteHint(null, lines(200)), null);
});

test("hint: a big file overwritten with a small change gets the hint", () => {
  const old = lines(200);
  const next = old.replace("const a7 = 7;", "const a7 = 700;");
  const h = rewriteHint(old, next, "connectors/c/server.js");
  assert.match(h, /Saved\./);
  assert.match(h, /about 1 of 200 lines/);
  assert.match(h, /ateam_github_patch search\/replace/);
});

test("hint: a real rewrite gets no hint", () => {
  assert.equal(rewriteHint(lines(200, "a"), lines(200, "b")), null);
});

test("hint: a small file gets no hint, even if nearly identical", () => {
  assert.equal(rewriteHint("a\nb\nc", "a\nb\nd"), null);
});

test("handler: ateam_github_write on an existing big file saves AND carries the hint; a new file has none", async () => {
  const SID = "sess-edit-not-rewrite";
  const existing = lines(200);
  const writes = [];
  const api = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method === "GET") {
        const p = new URL(req.url, "http://x").searchParams.get("path");
        const found = p.endsWith("old.js");
        res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(found ? { ok: true, content: existing } : { error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      writes.push(JSON.parse(raw));
      res.end(JSON.stringify({ ok: true, commit_sha: "abc1234" }));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_00000000000000000000000000000000", apiUrl: `http://127.0.0.1:${api.address().port}`, explicit: true });
  try {
    const small = existing.replace("const a7 = 7;", "const a7 = 700;");
    const r1 = await handleToolCall("ateam_github_write", { solution_id: "s", path: "connectors/c/old.js", content: small }, SID);
    assert.equal(writes.length, 1, "the write must still be saved");
    assert.match(r1.content[0].text, /ateam_github_patch search\/replace/);
    const r2 = await handleToolCall("ateam_github_write", { solution_id: "s", path: "connectors/c/new.js", content: small }, SID);
    assert.equal(writes.length, 2);
    assert.doesNotMatch(r2.content[0].text, /search\/replace/);
  } finally {
    await new Promise((r) => api.close(r));
  }
});
