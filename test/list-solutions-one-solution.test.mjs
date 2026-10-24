import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

test("ateam_list_solutions says a workspace holds one solution and none can be added", () => {
  const t = tools.find((x) => x.name === "ateam_list_solutions");
  assert.match(t.description, /exactly ONE solution/);
  assert.match(t.description, /no way to create additional/);
});
