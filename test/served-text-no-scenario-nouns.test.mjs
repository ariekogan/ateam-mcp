// THE TEST SCENARIO STAYS A TEST SCENARIO (CORE bias audit S8, ateam-mcp half).
//
// Arie, 2026-10-02: the invoice tracker is ONLY a test case. No tool text,
// schema, example or generated file ateam-mcp gives an agent may assume an
// invoice-like solution: every sentence must stay right, unchanged, for a
// fitness log, a CRM, a smart-home panel or a voice guide. The audit found the
// scenario's nouns, and money-only examples, served here: verify_surface's
// example values and plugin id (M7), ateam_connector_logs' real case and
// connector id (L5), the attachment file-name example (L5), and the comment
// block every scaffolded server.js carries.
//
// Two layers, as the Builder's guard (Builder #131, test/servedTextNoScenarioNouns):
//   (a) SERVED: what an agent is actually given, composed: the whole tool list,
//       ateam_bootstrap, the monitoring topic, the tenant CLAUDE.md header, and
//       the files ateam_create_connector / ateam_create_plugin generate. Every
//       string AND every object key.
//   (b) SOURCE: every string literal, template-literal chunk and object key in
//       src/*.js (tests excluded). That covers the refusals, hints and results
//       handlers emit, which (a) cannot reach offline. Comments are never read:
//       a comment is where an incident belongs.
//
// The words carry no \b: "\binvoice\b" misses invoice_id (an underscore is a
// word character), "\bsuppliers?\b" misses supplierName, "\bSEED_HELD\b"
// misses SEED_HELD_FIXTURE. vendor(?!ed|ing) leaves "vendored" alone; "held"
// alone is a generic state ("held for review"), not the scenario's word.
//
// What this cannot see: text built at runtime from data (a tenant's own
// connector names, an API answer passed through), and text other repos serve.
//
// Run: node --test test/served-text-no-scenario-nouns.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";
import { createOnlyAnswer } from "./create-only-stand-in.mjs";

export const SCENARIO_NOUNS = /(invoic|supplier|vendor(?!ed|ing)|ledger|SEED_HELD)/i;
const hit = (t) => SCENARIO_NOUNS.test(String(t));

/** Every string value AND every object key under a node, with where it sits. */
function stringsAndKeys(node, where, out = []) {
  if (typeof node === "string") out.push({ where, text: node });
  else if (Array.isArray(node)) node.forEach((v, i) => stringsAndKeys(v, `${where}[${i}]`, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      out.push({ where: `${where} key`, text: k });
      stringsAndKeys(v, `${where}.${k}`, out);
    }
  }
  return out;
}

const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Every string literal, template-literal chunk and object key in one JS source,
 * with its line. Comments are skipped. A small lexer, not a parser: ateam-mcp
 * has no parser dependency, and words in literals and keys are all this needs.
 * It throws on anything it cannot close (a string, a template, a regex, a
 * comment) or a template left open at the end, so a mis-read file fails loudly
 * instead of hiding what follows.
 */
export function literalsAndKeys(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let prev = null;            // last significant token: { type, value, line }
  const templateDepth = [];   // one entry per open ${ … }: its { depth
  const push = (tok) => { prev = tok; };
  const nextSignificant = (j) => { while (j < n && /\s/.test(src[j])) j++; return src[j]; };
  const fail = (what) => { throw new Error(`unterminated ${what} at line ${line}`); };

  const readTemplateChunk = () => {
    // i is just past a backtick or the closing } of a ${ … }.
    let text = "";
    const start = line;
    while (true) {
      if (i >= n) fail("template literal");
      const c = src[i];
      if (c === "\\") { text += src.slice(i, i + 2); if (src[i + 1] === "\n") line++; i += 2; continue; }
      if (c === "`") { i++; out.push({ line: start, text, kind: "template" }); push({ type: "tmpl" }); return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; out.push({ line: start, text, kind: "template" }); templateDepth.push(0); prev = { type: "punct", value: "{" }; return; }
      if (c === "\n") line++;
      text += c; i++;
    }
  };

  if (src.startsWith("#!")) { while (i < n && src[i] !== "\n") i++; }

  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) fail("comment");
      for (let j = i; j < end; j++) if (src[j] === "\n") line++;
      i = end + 2; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1; let text = "";
      while (true) {
        if (j >= n || src[j] === "\n") fail("string");
        if (src[j] === "\\") { if (src[j + 1] === "\n") line++; text += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === c) break;
        text += src[j]; j++;
      }
      out.push({ line, text, kind: "string" });
      i = j + 1;
      push({ type: "str", value: text, line });
      continue;
    }
    if (c === "`") { i++; readTemplateChunk(); continue; }
    if (c === "/") {
      const regexAllowed = !prev
        || (prev.type === "punct" && prev.value !== ")" && prev.value !== "]")
        || (prev.type === "ident" && REGEX_AFTER_WORD.has(prev.value));
      if (regexAllowed) {
        let j = i + 1; let inClass = false;
        while (true) {
          if (j >= n || src[j] === "\n") fail("regex");
          const r = src[j];
          if (r === "\\") { j += 2; continue; }
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        i = j;
        push({ type: "regex" });
        continue;
      }
      i++; push({ type: "punct", value: "/" }); continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      // An object key: after { or , and before : , } or ( (key: value,
      // shorthand, method). Destructuring patterns read the same way.
      const after = nextSignificant(j);
      if (prev && prev.type === "punct" && (prev.value === "{" || prev.value === ",") && [":", ",", "}", "("].includes(after)) {
        out.push({ line, text: word, kind: "key" });
      }
      i = j;
      push({ type: "ident", value: word, line });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      i = j; push({ type: "num" }); continue;
    }
    // Punctuation, one character at a time; braces drive the open ${ … }.
    if (c === "{" && templateDepth.length) templateDepth[templateDepth.length - 1]++;
    if (c === "}" && templateDepth.length) {
      if (templateDepth[templateDepth.length - 1] === 0) { templateDepth.pop(); i++; readTemplateChunk(); continue; }
      templateDepth[templateDepth.length - 1]--;
    }
    i++;
    push({ type: "punct", value: c });
  }
  if (templateDepth.length) fail("template expression");
  return out;
}

// ── (a) what is served ────────────────────────────────────────────────────────
const SID = "sess-scenario-nouns";
let server;
const uploads = [];
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let created = {};
      if (req.url.split("?")[0].endsWith("/upload")) {
        try { const sent = JSON.parse(body || "{}"); uploads.push(sent); created = createOnlyAnswer(sent); } catch { /* not JSON */ }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tools: 1, ...created }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_" + "0".repeat(32), apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

async function servedCorpus() {
  const out = stringsAndKeys(tools, "tools");
  const text = async (name, args, sid = SID) => (await handleToolCall(name, args, sid)).content[0].text;
  stringsAndKeys(JSON.parse(await text("ateam_bootstrap", {}, "sess-scenario-nouns-boot")), "ateam_bootstrap", out);
  stringsAndKeys(JSON.parse(await text("ateam_get_spec", { topic: "monitoring" })), "ateam_get_spec(monitoring)", out);
  out.push({ where: "tenant CLAUDE.md", text: renderAgentDocHeader({ solution: { id: "sol", name: "Sol" }, skills: [], connectors: [] }) });
  uploads.length = 0;
  await handleToolCall("ateam_create_connector", { solution_id: "sol", connector_id: "panel-mcp", ui_capable: true }, SID);
  await handleToolCall("ateam_create_plugin", { solution_id: "sol", connector_id: "panel-mcp", plugin_name: "room-panel", kind: "adaptive" }, SID);
  for (const u of uploads) for (const f of u.files || []) out.push({ where: `scaffold ${f.path}`, text: f.content });
  return out;
}

test("(a) nothing served — tool list, bootstrap, monitoring, CLAUDE.md, scaffolded files — names the scenario, in a string or a key", async () => {
  const served = await servedCorpus();
  // A guard over nothing is a label, not a check.
  assert.ok(served.length > 2000, `only ${served.length} served strings and keys were read`);
  assert.ok(served.some((s) => s.where.startsWith("scaffold ") && s.where.endsWith("server.js")), "the scaffolded server.js was not read");
  assert.ok(served.some((s) => s.where.startsWith("scaffold ") && /\.(tsx|html)$/.test(s.where)), "the scaffolded plugin was not read");
  assert.ok(served.some((s) => s.where.endsWith(" key")), "no object key was read");
  const hits = served.filter((s) => hit(s.text)).map((s) => `${s.where}: …${s.text.slice(Math.max(0, s.text.search(SCENARIO_NOUNS) - 50), s.text.search(SCENARIO_NOUNS) + 50)}…`);
  assert.deepEqual(hits, [], "a served string or key names the test scenario: write it without that domain");
});

// ── (b) every literal and key in the source ──────────────────────────────────
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("(b) no string literal, template chunk or object key in src/ names the scenario (comments excluded)", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  assert.ok(files.length >= 10, `only ${files.length} source files found`);
  const hits = [];
  let read = 0;
  for (const f of files) {
    const found = literalsAndKeys(readFileSync(join(SRC, f), "utf8"));
    read += found.length;
    for (const { line, text, kind } of found) if (hit(text)) hits.push(`src/${f}:${line} (${kind}): …${text.slice(Math.max(0, text.search(SCENARIO_NOUNS) - 50), text.search(SCENARIO_NOUNS) + 50)}…`);
  }
  assert.ok(read > 5000, `only ${read} literals and keys were read`);
  assert.deepEqual(hits, [], "a string or key in the source names the test scenario");
});

// ── the guard itself ─────────────────────────────────────────────────────────
test("the guard catches the scenario's words inside identifiers and keys, and only those", () => {
  for (const word of ["invoice", "Invoices", "invoice_id", "invoiced", "supplier", "supplierName", "vendor", "vendor_id", "ledger", "effectLedger", "SEED_HELD", "SEED_HELD_FIXTURE", "invoice-tracker"]) {
    assert.ok(hit(word), word);
  }
  for (const fine of ["held for review", "vendored dependency", "vendoring", "a logged reading", "a record", "7.2 km", "Living room"]) {
    assert.ok(!hit(fine), fine);
  }
});

test("the lexer reads literals, template chunks and keys, and never a comment", () => {
  const src = [
    "#!/usr/bin/env node",
    "// the 2026-09-28 invoice build — history, in a comment",
    "/* a supplier in a block comment */",
    "const a = { invoice_id: 1, 'supplierName': 2, nested: { SEED_HELD_FIXTURE } };",
    "const re = /['\"`]ledger\\/[/]/g, half = total / 2 / 3;",
    "const t = `row ${x ? `inner ${'vendor'}` : { k: 1 }.k} ledger tail`;",
    "if (/invoice/.test(s)) return /x/;",
    "const ok = 'every user saw everyone\\'s records'; // trailing invoice comment",
    "function f({ supplier }) { return { method() {}, ledger }; }",
  ].join("\n");
  const found = literalsAndKeys(src);
  const hits = found.filter((l) => hit(l.text)).map((l) => `${l.line}:${l.kind}:${l.text}`);
  assert.deepEqual(hits, [
    "4:key:invoice_id",
    "4:string:supplierName",
    "4:key:SEED_HELD_FIXTURE",
    "6:string:vendor",
    "6:template: ledger tail",
    "9:key:supplier",
    "9:key:ledger",
  ]);
  // Regex literals are code, not served text; a division is not a regex.
  assert.ok(!found.some((l) => /\[\/\]/.test(l.text)));
  assert.ok(found.some((l) => l.kind === "string" && l.text === "every user saw everyone\\'s records"));
  assert.throws(() => literalsAndKeys("const s = 'never closed\nnext"), /unterminated string at line 1/);
  assert.throws(() => literalsAndKeys("const t = `${a"), /unterminated template expression/);
});

// ── the audit's rewrites keep their varied examples ──────────────────────────
// The noun guard catches the scenario's words. These pin the rewrites
// themselves, so a later edit back to a single money example ("accounting",
// "0.00", "Groceries", none of them a scenario noun) is red too.
const tool = (name) => tools.find((t) => t.name === name);

test("M7: verify_surface's plugin id and values examples are not money-only", () => {
  const props = tool("ateam_verify_surface").inputSchema.properties;
  assert.equal(props.plugin_id.description, "The ui_plugin id to probe, in the form 'mcp:<connector-id>:<plugin-name>', e.g. 'mcp:home-mcp:room-panel'.");
  assert.ok(props.expect.description.includes("{ values: ['<a value from a row you created, exactly as the widget shows it, e.g. 7.2 km, Living room, Pasta carbonara>'] }"), props.expect.description);
  assert.doesNotMatch(JSON.stringify(props), /accounting|spending|Groceries|37\.50/);
});

test("L5: ateam_connector_logs tells its real case without the domain, and its connector id example is generic", () => {
  const t = tool("ateam_connector_logs");
  assert.ok(t.description.includes("a dashboard connector's data tool got 401 Authentication required from Core, swallowed it, returned an empty list, and showed zeros everywhere"), t.description);
  assert.equal(t.inputSchema.properties.connector_id.description, "The connector ID (e.g. 'my-connector-mcp')");
  assert.doesNotMatch(t.description + JSON.stringify(t.inputSchema), /accounting|0\.00/);
});

test("L5: the attachment name example names varied files", () => {
  const name = tool("ateam_conversation").inputSchema.properties.attachments.items.properties.name.description;
  assert.ok(name.startsWith("File name shown to the skill (e.g. photo.jpg, notes.pdf, recipe.png)."), name);
});

test("the scaffolded server.js tells NEVER SWALLOW without the domain", async () => {
  uploads.length = 0;
  await handleToolCall("ateam_create_connector", { solution_id: "sol", connector_id: "panel-mcp" }, SID);
  const serverJs = uploads.flatMap((u) => u.files || []).find((f) => f.path === "server.js")?.content || "";
  assert.ok(serverJs.includes("// renders zeros forever"), "the BAD example line changed");
  assert.ok(serverJs.includes("a connector caught a 401, returned an empty list, and\n// the dashboard showed zeros while every check reported success."), serverJs.slice(0, 400));
  assert.doesNotMatch(serverJs, /0\.00/);
});
