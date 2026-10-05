import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("ordered index plan mirrors all four manifest query shapes and stays read-only", () => {
  const script = path.join(import.meta.dirname, "ordered-index-plan.mjs");
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mutation, false);
  assert.equal(plan.collections.length, 4);
  assert.deepEqual(plan.collections.map((item) => item.fields), [
    ["ownerOpenId", "_syncSequence", "_id"],
    ["ownerOpenId", "_syncSequence", "_id"],
    ["ownerOpenId", "_syncSequence", "_id"],
    ["ownerOpenId", "_syncSequence", "_id"],
  ]);
});
