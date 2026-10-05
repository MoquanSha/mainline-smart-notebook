import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("migration preview reports bound, unresolved and sequence gaps without writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mainline-migration-preview-"));
  try {
    for (const collection of ["tasks", "daily_tasks", "captures", "day_records"]) {
      const rows = collection === "tasks"
        ? [{ _id: "a", ownerOpenId: "workspace-a" }, { _id: "b", ownerOpenId: "migration_pending_cross_account" }]
        : [];
      fs.writeFileSync(path.join(root, `${collection}.json`), JSON.stringify(rows));
    }
    const script = path.join(import.meta.dirname, "migration-preview.mjs");
    const result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mutation, false);
    assert.deepEqual(report.collections.tasks, {
      total: 2,
      bound: 1,
      unresolvedOwnership: 1,
      missingSyncSequence: 2,
      boundMissingSyncSequence: 1,
      deletedOrTrashed: 0,
      attachmentReferences: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
