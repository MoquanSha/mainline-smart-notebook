#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(projectRoot, "wechat-mini-program-0.10.37-login-copy-20260905", "cloudfunctions", "ordered-sync-index-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const collections = (manifest.requiredQueryShapes || []).map((shape) => ({
  collection: shape.collection,
  fields: [...shape.fields],
  indexName: `${shape.collection}_ownerOpenId_syncSequence_id_v1`,
  equalityFields: [shape.fields[0]],
  rangeField: shape.fields[1],
  tieBreaker: shape.fields[2],
  mutationRequired: true,
}));

process.stdout.write(`${JSON.stringify({
  generatedAt: new Date().toISOString(),
  protocol: manifest.protocol,
  status: manifest.status,
  enableFlags: manifest.enableFlags,
  mutation: false,
  releaseRule: "Create and verify every listed index, run bounded backfill, then enable both flags together.",
  collections,
}, null, 2)}\n`);
