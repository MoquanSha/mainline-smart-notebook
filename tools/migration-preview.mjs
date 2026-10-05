#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const inputRoot = path.resolve(process.argv[2] || path.join(process.cwd(), "cloudbase-data-backup-20260925"));
const collections = ["tasks", "daily_tasks", "captures", "day_records"];
const unresolvedOwner = "migration_pending_cross_account";

function readRows(collection) {
  const file = path.join(inputRoot, `${collection}.json`);
  if (!fs.existsSync(file)) throw new Error(`missing backup file: ${file}`);
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`backup file is not an array: ${file}`);
  return rows;
}

function countAttachmentReferences(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countAttachmentReferences(item), 0);
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "fileID" || key === "fileId") && String(item || "").trim()) count += 1;
    else count += countAttachmentReferences(item);
  }
  return count;
}

const report = {
  generatedAt: new Date().toISOString(),
  inputRoot,
  mutation: false,
  restorePolicy: "Rows with migration_pending_cross_account remain excluded until source-owner evidence is reviewed.",
  collections: {},
};

for (const collection of collections) {
  const rows = readRows(collection);
  const unresolved = rows.filter((row) => row.ownerOpenId === unresolvedOwner);
  const bound = rows.filter((row) => row.ownerOpenId && row.ownerOpenId !== unresolvedOwner);
  const missingSyncSequence = rows.filter((row) => !Number.isSafeInteger(row._syncSequence) || row._syncSequence < 0);
  const boundMissingSyncSequence = bound.filter((row) => !Number.isSafeInteger(row._syncSequence) || row._syncSequence < 0);
  const deleted = rows.filter((row) => Boolean(row.deletedAt || row.trashedAt));
  const dates = collection === "captures"
    ? rows.filter((row) => row.journalDate === "2026-09-20").length
    : undefined;
  report.collections[collection] = {
    total: rows.length,
    bound: bound.length,
    unresolvedOwnership: unresolved.length,
    missingSyncSequence: missingSyncSequence.length,
    boundMissingSyncSequence: boundMissingSyncSequence.length,
    deletedOrTrashed: deleted.length,
    attachmentReferences: rows.reduce((sum, row) => sum + countAttachmentReferences(row), 0),
    ...(dates === undefined ? {} : { journalDate20260920: dates }),
  };
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
