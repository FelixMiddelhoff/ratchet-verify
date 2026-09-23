import { test } from "node:test";
import assert from "node:assert/strict";
import { name } from "../src/index.js";

test("package exports its name", () => {
  assert.equal(name, "ratchet");
});
