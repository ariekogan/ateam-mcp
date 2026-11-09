// Reading a big file in parts, finding lines across a connector's code, and the changed lines before a promote.
//
// A tool answer carries about 50 KB. A 183 KB connector file was cut there with no way to read the rest, nothing could
// find a line across a connector's files, and ateam_github_diff named the changed files without the changed lines.
// Now: ateam_github_read and ateam_get_connector_source take offset/limit (lines) and search; a big file comes back in
// parts with next_offset; ateam_github_diff takes lines:true and path.
//
// Run: node --test test/read-in-parts.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tools, handlers, formatResultForTest } from "../src/tools.js";
import { lineWindow, findLines, WINDOW_CHARS, MAX_MATCHES } from "../src/textWindow.js";

const byName = (n) => tools.find((t) => t.name === n);
const origFetch = global.fetch;
let asked = [];
function stub(route) {
  asked = [];
  global.fetch = async (url) => {
    asked.push(String(url));
    const r = route(String(url));
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => r, text: async () => JSON.stringify(r) };
  };
}
const unstub = () => { global.fetch = origFetch; };

// A 183 KB file: 3000 numbered lines of ~60 characters.
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}: ${"x".repeat(50)}${i === 2499 ? " findMe()" : ""}`).join("\n");

describe("lineWindow", () => {
  test("a file that fits, read whole, is left alone", () => {
    assert.equal(lineWindow("a\nb\nc"), null);
  });
  test("a line range", () => {
    const w = lineWindow("a\nb\nc\nd\ne", { offset: 2, limit: 2 });
    assert.equal(w.content, "b\nc");
    assert.deepEqual(w.lines, { from: 2, to: 3, total: 5 });
    assert.equal(w.next_offset, 4);
  });
  test("a big file comes back in parts that join up to the whole file", () => {
    assert.ok(BIG.length > 150_000);
    const parts = [];
    let offset = 1;
    for (let guard = 0; offset && guard < 20; guard++) {
      const w = lineWindow(BIG, { offset });
      assert.ok(w.content.length <= WINDOW_CHARS);
      parts.push(w.content);
      offset = w.next_offset;
    }
    assert.equal(offset, null);
    assert.equal(parts.join("\n"), BIG);
  });
  test("one line too long for an answer (a minified file) is read in pieces that join up to the line", () => {
    const longLine = "y".repeat(WINDOW_CHARS * 2 + 123);
    const text = `first\nsecond\n${longLine}\nlast`;
    const out = [];
    let at = { offset: 1 };
    for (let guard = 0; at && guard < 20; guard++) {
      const w = lineWindow(text, at);
      assert.ok(w.content.length <= WINDOW_CHARS);
      out.push({ line: w.lines.from, piece: !!w.chars, text: w.content });
      at = w.next_offset ? { offset: w.next_offset, ...(w.next_char_offset != null && { char_offset: w.next_char_offset }) } : null;
    }
    assert.deepEqual(out.map((o) => [o.line, o.piece]), [[1, false], [3, true], [3, true], [3, true], [4, false]]);
    assert.equal(out.filter((o) => o.line === 3).map((o) => o.text).join(""), longLine);
    assert.equal(out[0].text, "first\nsecond"); assert.equal(out[4].text, "last");
    const mid = lineWindow(text, { offset: 3, char_offset: WINDOW_CHARS });
    assert.deepEqual(mid.chars, { from: WINDOW_CHARS, to: WINDOW_CHARS * 2, of: longLine.length });
    assert.match(mid.note, new RegExp(`char_offset:${WINDOW_CHARS * 2}`));
  });
  test("a file that is one huge line, read through a tool, fits one answer and says where to read on", async () => {
    stub(() => ({ ok: true, branch: "dev", content: "z".repeat(120_000) }));
    try {
      const r = await handlers.ateam_github_read({ solution_id: "s", path: "dist/app.min.js" }, "sid");
      assert.equal(r.content.length, WINDOW_CHARS); assert.equal(r.next_offset, 1); assert.equal(r.next_char_offset, WINDOW_CHARS);
      assert.doesNotThrow(() => JSON.parse(formatResultForTest(r, "ateam_github_read")));
      const r2 = await handlers.ateam_github_read({ solution_id: "s", path: "dist/app.min.js", offset: 1, char_offset: 80_000 }, "sid");
      assert.equal(r2.content.length, 40_000); assert.equal(r2.next_offset, null); assert.equal(r2.next_char_offset, null);
    } finally { unstub(); }
  });
  test("past the end says so", () => {
    const w = lineWindow("a\nb", { offset: 9 });
    assert.equal(w.content, ""); assert.equal(w.next_offset, null); assert.match(w.note, /past the end/);
  });
});

describe("findLines", () => {
  test("finds lines in several files, letter case ignored, skips binary files", () => {
    const r = findLines([
      { path: "server.js", content: "const a = 1;\nfunction Invite() {}\n" },
      { path: "lib/x.js", content: "// invite here\n" },
      { path: "logo.png", content: "aW52aXRl", encoding: "base64" },
    ], "invite");
    assert.deepEqual(r.matches, [{ path: "server.js", line: 2, text: "function Invite() {}" }, { path: "lib/x.js", line: 1, text: "// invite here" }]);
    assert.equal(r.files_searched, 2); assert.equal(r.truncated, false);
  });
  test("many long matching lines: only as many as fit one answer, and the answer stays whole", () => {
    const content = Array.from({ length: 300 }, (_, i) => `hit ${i} ${"w".repeat(400)}`).join("\n");
    const r = findLines([{ path: "connectors/some-connector/dist/bundle.js", content }], "hit");
    assert.ok(r.matches.length < MAX_MATCHES); assert.equal(r.total_matches, 300); assert.equal(r.truncated, true);
    const out = formatResultForTest({ ok: true, ...r }, "ateam_get_connector_source");
    assert.equal(JSON.parse(out).total_matches, 300, "the count and the note are not cut off");
    assert.match(JSON.parse(out).note, /search for something narrower/);
  });
  test("too many matches are capped and say so", () => {
    const r = findLines([{ path: "a", content: Array(MAX_MATCHES + 5).fill("hit").join("\n") }], "hit");
    assert.equal(r.matches.length, MAX_MATCHES); assert.equal(r.total_matches, MAX_MATCHES + 5); assert.equal(r.truncated, true);
  });
});

describe("ateam_github_read", () => {
  test("declares offset, limit and search (an undeclared argument is stripped by MCP)", () => {
    const p = byName("ateam_github_read").inputSchema.properties;
    for (const k of ["offset", "limit", "char_offset", "search"]) assert.ok(p[k], k);
    assert.match(byName("ateam_github_read").description, /offset/);
  });
  test("a big file read without a range comes back in parts, the first part first", async () => {
    stub(() => ({ ok: true, branch: "dev", path: "connectors/c/server.js", content: BIG }));
    try {
      const r = await handlers.ateam_github_read({ solution_id: "s", path: "connectors/c/server.js" }, "sid");
      assert.equal(r.lines.from, 1); assert.ok(r.next_offset > 1); assert.ok(r.content.startsWith("line 1:"));
      assert.equal(r.branch, "dev");
      const r2 = await handlers.ateam_github_read({ solution_id: "s", path: "connectors/c/server.js", offset: 2400, limit: 200 }, "sid");
      assert.deepEqual(r2.lines, { from: 2400, to: 2599, total: 3000 });
      assert.ok(r2.content.includes("findMe()"));
    } finally { unstub(); }
  });
  test("search returns matching lines with numbers, not the file", async () => {
    stub(() => ({ ok: true, branch: "dev", content: BIG }));
    try {
      const r = await handlers.ateam_github_read({ solution_id: "s", path: "x.js", search: "FINDME" }, "sid");
      assert.equal(r.content, undefined);
      assert.deepEqual(r.matches.map((m) => [m.path, m.line]), [["x.js", 2500]]);
    } finally { unstub(); }
  });
  test("a small file read whole is returned exactly as before", async () => {
    stub(() => ({ ok: true, branch: "dev", content: "hello" }));
    try {
      const r = await handlers.ateam_github_read({ solution_id: "s", path: "README.md" }, "sid");
      assert.equal(r.content, "hello"); assert.equal(r.lines, undefined);
    } finally { unstub(); }
  });
});

describe("ateam_get_connector_source", () => {
  const source = { ok: true, provenance: "github", authored_source_of_record: true, files: [
    { path: "server.js", content: BIG },
    { path: "lib/db.js", content: "export function findMe() {}\n" },
  ] };
  test("search across ALL the connector's files", async () => {
    stub(() => source);
    try {
      const r = await handlers.ateam_get_connector_source({ solution_id: "s", connector_id: "c", search: "findme" }, "sid");
      assert.deepEqual(r.matches.map((m) => [m.path, m.line]), [["server.js", 2500], ["lib/db.js", 1]]);
      assert.equal(r.provenance, "github", "provenance still rides on the answer");
    } finally { unstub(); }
  });
  test("one file by line range", async () => {
    stub(() => source);
    try {
      const r = await handlers.ateam_get_connector_source({ solution_id: "s", connector_id: "c", path: "server.js", offset: 10, limit: 5 }, "sid");
      assert.deepEqual(r.lines, { from: 10, to: 14, total: 3000 }); assert.ok(r.content.startsWith("line 10:"));
    } finally { unstub(); }
  });
});

describe("ateam_github_diff: the changed lines before a promote", () => {
  test("declares lines and path", () => {
    const p = byName("ateam_github_diff").inputSchema.properties;
    assert.equal(p.lines.type, "boolean"); assert.equal(p.path.type, "string");
  });
  test("lines:true and path are sent to the Builder; without them, nothing changes", async () => {
    stub(() => ({ ok: true, files: [{ path: "a.js", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" }] }));
    try {
      await handlers.ateam_github_diff({ solution_id: "s" }, "sid");
      assert.equal(new URL(asked[0]).searchParams.get("lines"), null);
      await handlers.ateam_github_diff({ solution_id: "s", lines: true }, "sid");
      assert.equal(new URL(asked[1]).searchParams.get("lines"), "1");
      const r = await handlers.ateam_github_diff({ solution_id: "s", path: "a.js" }, "sid");
      const q = new URL(asked[2]).searchParams;
      assert.equal(q.get("lines"), "1"); assert.equal(q.get("path"), "a.js");
      assert.equal(r.files[0].patch, "@@ -1 +1 @@\n-a\n+b");
    } finally { unstub(); }
  });
  test("an older Builder that sends no lines is named, not taken for 'nothing changed'", async () => {
    stub(() => ({ ok: true, files: [{ path: "a.js", status: "modified", additions: 3, deletions: 1 }] }));
    try {
      const r = await handlers.ateam_github_diff({ solution_id: "s", lines: true }, "sid");
      assert.match(r._lines, /does not send changed lines/);
    } finally { unstub(); }
  });
});
