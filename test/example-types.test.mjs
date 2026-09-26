// ateam_get_examples — ONE list of example types, and every surface reads it.
//
// There were three lists, edited separately, and they drifted each time a type
// was added:
//
//   the schema enum      — the types a caller may send
//   EXAMPLE_PATHS        — the Builder route each type is fetched from
//   the tenant CLAUDE.md — the types an agent working in the repo is told exist
//
//   ui-plugin-iframe  — served by the Builder for months, absent from the enum
//                       and the map, so no agent could ever fetch it
//   device-tools      — the worked pattern for runtime:"device", added to the
//                       Builder on 2026-09-07 and unreachable through this tool
//                       until 04c24ce
//   the CLAUDE.md     — still named the four types it was written with in
//                       e75feac: no script-cache-skill, ui-plugin-native,
//                       ui-plugin-iframe or device-tools. It is the doc an agent
//                       in the tenant's repo reads first, and 04c24ce's guard
//                       never read it (ateam-mcp #15, f72be159ae).
//
// All three now come from src/exampleTypes.js. This file used to check the enum
// against the map by regex over tools.js — two strings in one file. It now
// drives the real handler against a local stand-in for the Builder and renders
// the real CLAUDE.md.
//
// Run: node --test test/example-types.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";

const SID = "sess-example-types";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const seen = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, served: req.url }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

const def = tools.find((t) => t.name === "ateam_get_examples");
const accepted = def?.inputSchema?.properties?.type?.enum || [];

async function fetchExample(type) {
  seen.length = 0;
  const r = await handleToolCall("ateam_get_examples", { type }, SID);
  return { r, text: r.content?.[0]?.text || "", requested: [...seen] };
}

test("the schema accepts a non-empty list of types", () => {
  assert.ok(accepted.length > 0, "ateam_get_examples has no type enum");
});

test("every accepted type is fetched from its own /spec/examples route", async () => {
  const routes = new Map();
  for (const type of accepted) {
    const { r, requested } = await fetchExample(type);
    assert.ok(!r.isError, `"${type}" is accepted by the schema but the handler refused it: ${r.content?.[0]?.text}`);
    assert.equal(requested.length, 1, `"${type}" made ${requested.length} requests`);
    assert.match(requested[0], /^\/spec\/examples(\/|$)/, `"${type}" fetched ${requested[0]}, not an example route`);
    routes.set(type, requested[0]);
  }
  // Two types resolving to one route means one of them fetches the wrong thing.
  assert.equal(new Set(routes.values()).size, routes.size, `two types share a route: ${JSON.stringify([...routes])}`);
});

// Named, not just covered by the loop above: deleting them would keep every
// other check green and reopen the exact gap this file records.
for (const t of ["device-tools", "ui-plugin-iframe"]) {
  test(`"${t}" is reachable through the tool`, async () => {
    assert.ok(accepted.includes(t), `"${t}" is not in the schema enum`);
    const { r } = await fetchExample(t);
    assert.ok(!r.isError);
  });
}

test('"device-tools" is fetched from the Builder route that serves it', async () => {
  const { requested } = await fetchExample("device-tools");
  assert.deepEqual(requested, ["/spec/examples/device-tools"]);
});

// An unknown type used to reach get(undefined), which resolves to the API root,
// so a typo answered with a plausible payload instead of an error.
test("an unknown type fails by name and fetches nothing", async () => {
  for (const bad of ["no-such-type", "toString", "constructor"]) {
    const { r, text, requested } = await fetchExample(bad);
    assert.ok(r.isError, `"${bad}" did not fail`);
    assert.match(text, /Unknown example type/, `"${bad}" failed without naming the problem: ${text}`);
    assert.deepEqual(requested, [], `"${bad}" still fetched ${requested}`);
    for (const t of accepted) assert.ok(text.includes(t), `the refusal for "${bad}" does not list "${t}"`);
  }
});

// An entry nobody can find is worth the same as an entry that is not there.
test("the schema description mentions device-tools", () => {
  assert.match(def.inputSchema.properties.type.description, /device-tools/);
});

// THE THIRD LIST. The CLAUDE.md written into every tenant repo.
test("the tenant CLAUDE.md names every type the tool accepts", () => {
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [] });
  const line = doc.split("\n").find((l) => l.includes("ateam_get_examples("));
  assert.ok(line, "the CLAUDE.md no longer mentions ateam_get_examples at all");
  const named = [...line.matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  const missing = accepted.filter((t) => !named.includes(t));
  const invented = named.filter((t) => !accepted.includes(t));
  assert.deepEqual(missing, [], `the CLAUDE.md does not name: ${missing.join(", ")}`);
  assert.deepEqual(invented, [], `the CLAUDE.md names types the tool refuses: ${invented.join(", ")}`);
});

test("the enum, the routes and the CLAUDE.md are one list (src/exampleTypes.js)", async () => {
  const { EXAMPLE_PATHS, EXAMPLE_TYPES } = await import("../src/exampleTypes.js");
  assert.deepEqual(accepted, [...EXAMPLE_TYPES], "the schema enum is not the owner's list");
  for (const type of EXAMPLE_TYPES) {
    const { requested } = await fetchExample(type);
    assert.deepEqual(requested, [EXAMPLE_PATHS[type]], `"${type}" did not fetch the owner's route`);
  }
  // A drift guard, beside the behaviour above rather than instead of it: the
  // renderer must not carry a second literal list that happens to agree today.
  const agentDocSrc = readFileSync(new URL("../src/agentDoc.js", import.meta.url), "utf8");
  assert.match(agentDocSrc, /import \{[^}]*\bEXAMPLE_TYPES\b[^}]*\} from ['"]\.\/exampleTypes\.js['"]/);
  assert.doesNotMatch(agentDocSrc, /"connector-ui"/, "agentDoc.js spells out a type list of its own again");
});
