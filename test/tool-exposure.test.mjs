// Every tool says who may see it (git plan B4): `_meta.agent_exposure` is "all" or
// "outside_only". Core hides the outside_only ones from the in-product Builder when
// it works in a development workspace; outside agents keep the whole server.
//
// The labels come from one table (AGENT_EXPOSURE in src/tools.js). This file checks
// it where a client sees it (tools/list over the real MCP server) and fails when a
// tool is unlabeled (a NEW source-writing tool cannot ship unnoticed), labeled twice,
// or named in the table without existing.
//
// Run: node --test test/tool-exposure.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tools, AGENT_EXPOSURE } from "../src/tools.js";
import { createServer } from "../src/server.js";

const SOURCE_WRITING = ["ateam_github_write", "ateam_github_patch", "ateam_patch", "ateam_upload_connector", "ateam_upload_connector_files"];

test("every tool is labeled exactly once, and the table names only real tools", () => {
  const names = new Set(tools.map((t) => t.name));
  const seen = new Map();
  for (const [cls, list] of Object.entries(AGENT_EXPOSURE)) {
    for (const n of list) {
      assert.ok(names.has(n), `${n} is in AGENT_EXPOSURE.${cls} but is not a tool`);
      assert.ok(!seen.has(n), `${n} is in both ${seen.get(n)} and ${cls}`);
      seen.set(n, cls);
    }
  }
  const unlabeled = tools.filter((t) => !seen.has(t.name)).map((t) => t.name);
  assert.deepEqual(unlabeled, [], `tools with no agent_exposure label (decide: all or outside_only): ${unlabeled.join(", ")}`);
});

test("each tool carries its label in _meta.agent_exposure, and only the two known values", () => {
  for (const t of tools) {
    assert.ok(["all", "outside_only"].includes(t._meta?.agent_exposure), `${t.name}: ${JSON.stringify(t._meta)}`);
  }
});

test("the source-writing tools are outside_only; spec, validate, deploy, tests, status stay visible", () => {
  assert.deepEqual([...AGENT_EXPOSURE.outside_only].sort(), [...SOURCE_WRITING].sort());
  const label = (n) => tools.find((t) => t.name === n)._meta.agent_exposure;
  for (const n of SOURCE_WRITING) assert.equal(label(n), "outside_only", n);
  for (const n of ["ateam_get_spec", "ateam_get_examples", "ateam_validate_skill", "ateam_build_and_run",
    "ateam_test_skill", "ateam_conversation", "ateam_github_status", "ateam_github_promote"]) {
    assert.equal(label(n), "all", n);
  }
});

test("tools/list over the real server shows the label on every advertised tool", async () => {
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools: listed } = await client.listTools();
  assert.ok(listed.length > 40);
  for (const t of listed) assert.ok(["all", "outside_only"].includes(t._meta?.agent_exposure), t.name);
  const hidden = listed.filter((t) => t._meta.agent_exposure === "outside_only").map((t) => t.name).sort();
  // A tool the server does not advertise (e.g. the raw connector file upload) is labeled in the table but absent here.
  const advertised = new Set(listed.map((t) => t.name));
  assert.deepEqual(hidden, SOURCE_WRITING.filter((n) => advertised.has(n)).sort());
  await client.close();
});
