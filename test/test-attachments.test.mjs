// ATTACHMENTS ON A TEST MESSAGE — what reaches the Builder, and what never leaves.
//
// ateam_conversation and ateam_test_skill take `attachments` so an agent can
// test an attachment-driven feature with no human in the browser. The file must
// arrive as dev-app sends one (InputDock.jsx → POST /api/chat
// { attachments: [{ data, mimeType, name }] }), and anything Core cannot use or
// cannot take must be refused HERE, with a named code and no request at all.
// See src/testAttachments.js.
//
// Driven through the real dispatcher (handleToolCall) against a local stand-in
// for the Builder that records every request. The transports (a url fetched on
// stdio, refused on the hosted server) are test/test-attachments-transport.test.mjs.
//
// Run: node --test test/test-attachments.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, tools } from "../src/tools.js";

const SID = "sess-test-attachments";
let server;
let hits = [];        // every request: { method, path, body }

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, job_id: "job_1", chain_id: "job_1", actor_id: "test_1_x", status: "running" }));
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

const call = (name, args) => { hits = []; return handleToolCall(name, args, SID); };
// ateam_test_skill with wait_for:"never" makes exactly the kickoff request.
const TOOLS = [
  ["ateam_conversation", { solution_id: "sol", message: "what is this?" }, "/deploy/solutions/sol/test"],
  ["ateam_test_skill", { solution_id: "sol", skill_id: "sk", message: "what is this?", wait_for: "never" }, "/deploy/solutions/sol/skills/sk/test"],
];

// A real 1x1 PNG, as FileReader.readAsDataURL would give it with the prefix cut.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF_B64 = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
const MB = 1024 * 1024;
const b64OfSize = (bytes) => Buffer.alloc(bytes, 7).toString("base64");

function refusedWith(res, code) {
  const text = res.content?.[0]?.text || "";
  assert.equal(res.isError, true, `not refused: ${text.slice(0, 300)}`);
  assert.equal(res.structuredContent?.code, code, text.slice(0, 300));
  assert.deepEqual(hits.map((h) => `${h.method} ${h.path}`), [], `a request left although the call was refused: ${text.slice(0, 200)}`);
  return text;
}

// ─── the wire ───────────────────────────────────────────────────────────────

for (const [name, args, path] of TOOLS) {
  test(`${name}: the Builder receives exactly [{ data, mimeType, name }], in order`, async () => {
    const attachments = [
      { data: PNG_B64, mimeType: "image/png", name: "pixel.png" },
      { data: PDF_B64, mimeType: "application/pdf", name: "invoice.pdf" },
    ];
    const res = await call(name, { ...args, attachments });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.equal(hits.length, 1, `expected one request, got ${hits.map((h) => h.path).join(", ")}`);
    assert.equal(hits[0].method, "POST");
    assert.equal(hits[0].path, path);
    assert.deepEqual(hits[0].body.attachments, [
      { data: PNG_B64, mimeType: "image/png", name: "pixel.png" },
      { data: PDF_B64, mimeType: "application/pdf", name: "invoice.pdf" },
    ]);
    assert.equal(hits[0].body.message, "what is this?");
  });

  test(`${name}: no attachments (absent, or an empty list) leaves the body as it was`, async () => {
    const expected = { message: "what is this?", async: true };
    for (const extra of [{}, { attachments: [] }, { attachments: null }]) {
      await call(name, { ...args, ...extra });
      assert.equal(hits.length, 1);
      assert.deepEqual(hits[0].body, expected, `body changed for ${JSON.stringify(extra)}`);
      assert.equal("attachments" in hits[0].body, false);
    }
  });

  test(`${name}: every type Core shows the skill is sent`, async () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/heic", "application/pdf", "text/plain", "text/csv", "application/json", "application/xml"]) {
      const res = await call(name, { ...args, attachments: [{ data: PNG_B64, mimeType, name: "f" }] });
      assert.notEqual(res.isError, true, `${mimeType}: ${res.content?.[0]?.text}`);
      assert.equal(hits[0].body.attachments[0].mimeType, mimeType);
    }
  });

  // ─── refused before anything is sent ──────────────────────────────────────

  test(`${name}: over 7 MB in total is ATTACHMENTS_TOO_LARGE, naming the cap and the size, and nothing is sent`, async () => {
    // Two files, each under the cap, together over it: the cap is per MESSAGE.
    const attachments = [
      { data: b64OfSize(4 * MB), mimeType: "image/jpeg", name: "a.jpg" },
      { data: b64OfSize(3 * MB + 1), mimeType: "application/pdf", name: "b.pdf" },
    ];
    const text = refusedWith(await call(name, { ...args, attachments }), "ATTACHMENTS_TOO_LARGE");
    assert.match(text, /7\.0 MB \(7340033 bytes\) decoded/);
    assert.match(text, /over the 7\.0 MB \(7340032 bytes\) cap/);
    assert.match(text, /Core accepts a request of at most 10 MB/);
  });

  test(`${name}: exactly 7 MB in total is sent`, async () => {
    const attachments = [
      { data: b64OfSize(4 * MB), mimeType: "image/jpeg", name: "a.jpg" },
      { data: b64OfSize(3 * MB), mimeType: "application/pdf", name: "b.pdf" },
    ];
    const res = await call(name, { ...args, attachments });
    assert.notEqual(res.isError, true, res.content?.[0]?.text?.slice(0, 300));
    assert.equal(hits[0].body.attachments.length, 2);
  });

  test(`${name}: a type Core would store and ignore is ATTACHMENT_TYPE_UNSUPPORTED, and nothing is sent`, async () => {
    for (const mimeType of ["application/zip", "application/octet-stream", "video/mp4", "audio/mpeg", "application/msword", "image", ""]) {
      const text = refusedWith(await call(name, { ...args, attachments: [{ data: PNG_B64, mimeType, name: "f" }] }), "ATTACHMENT_TYPE_UNSUPPORTED");
      assert.match(text, /image\/\*, application\/pdf, text\/\*, application\/json and application\/xml/);
    }
  });

  test(`${name}: a good file beside an unsupported one sends neither`, async () => {
    refusedWith(await call(name, { ...args, attachments: [
      { data: PNG_B64, mimeType: "image/png", name: "ok.png" },
      { data: PNG_B64, mimeType: "application/zip", name: "no.zip" },
    ] }), "ATTACHMENT_TYPE_UNSUPPORTED");
  });

  test(`${name}: more than 10 files is ATTACHMENTS_TOO_MANY, and nothing is sent`, async () => {
    const one = { data: PNG_B64, mimeType: "image/png", name: "p.png" };
    const text = refusedWith(await call(name, { ...args, attachments: Array(11).fill(one) }), "ATTACHMENTS_TOO_MANY");
    assert.match(text, /11 files; Core reads at most 10/);
    const ok = await call(name, { ...args, attachments: Array(10).fill(one) });
    assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
  });

  test(`${name}: a malformed item is ATTACHMENT_INVALID, and nothing is sent`, async () => {
    const bad = [
      [{ mimeType: "image/png" }, /exactly one of data \(base64\) or url/],
      [{ data: PNG_B64, url: "https://x.test/a.png", mimeType: "image/png" }, /exactly one of data \(base64\) or url/],
      [{ data: PNG_B64 }, /mimeType is required with data/],
      [{ data: `data:image/png;base64,${PNG_B64}`, mimeType: "image/png" }, /without the data:<type>;base64, prefix/],
      [{ data: "not base64!", mimeType: "image/png" }, /is not base64/],
      [{ data: PNG_B64, mimeType: "image/png", preview: "x" }, /unknown field\(s\) preview/],
      ["pixel.png", /must be an object/],
    ];
    for (const [item, rx] of bad) {
      const text = refusedWith(await call(name, { ...args, attachments: [item] }), "ATTACHMENT_INVALID");
      assert.match(text, rx);
    }
    refusedWith(await call(name, { ...args, attachments: { data: PNG_B64 } }), "ATTACHMENT_INVALID");
  });

  test(`${name}: a url is not fetched when the call did not come in over local stdio`, async () => {
    // handleToolCall with no server around it: no transport was stated, so it is
    // NOT local. Only a server built for stdio (src/index.js) fetches.
    const text = refusedWith(await call(name, { ...args, attachments: [{ url: "http://127.0.0.1:9/pixel.png" }] }), "ATTACHMENT_URL_NOT_FETCHED");
    assert.match(text, /send the file as base64 `data`; the hosted server does not fetch URLs/);
  });
}

test("both tools declare the same attachments parameter", () => {
  const schemaOf = (n) => tools.find((t) => t.name === n)?.inputSchema?.properties?.attachments;
  const conv = schemaOf("ateam_conversation");
  assert.ok(conv, "ateam_conversation declares no attachments");
  assert.equal(schemaOf("ateam_test_skill"), conv);
  assert.equal(conv.maxItems, 10);
  assert.deepEqual(Object.keys(conv.items.properties).sort(), ["data", "mimeType", "name", "url"]);
  assert.match(conv.description, /hosted server does not fetch URLs/);
  assert.match(conv.description, /7 MB in total/);
});
