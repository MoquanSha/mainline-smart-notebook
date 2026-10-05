#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const projectRoot = path.resolve(import.meta.dirname, "..");
const miniRoot = path.join(projectRoot, "wechat-mini-program-0.10.37-login-copy-20260905");
const desktopRoot = path.join(projectRoot, "personal-task-workbench-4320-wechat-login-test");
const buildIdentityPath = path.join(desktopRoot, "shared", "build-identity.json");
const desktopPackagePath = path.join(desktopRoot, "package.json");
const desktopLockPath = path.join(desktopRoot, "package-lock.json");
const miniEnvPath = path.join(miniRoot, "miniprogram", "config", "env.js");
const backendIdentityPath = path.join(miniRoot, "cloudfunctions", "release-identity.json");
const manifestPath = path.join(miniRoot, "cloudfunctions", "ordered-sync-index-manifest.json");
const cloudbasePath = path.join(miniRoot, "cloudbaserc.json");
const allowLive = process.argv.includes("--allow-live");
const jsonOnly = process.argv.includes("--json");
const auditIndex = process.argv.indexOf("--audit");
const auditPath = auditIndex >= 0 ? process.argv[auditIndex + 1] : "";
const backupIndex = process.argv.indexOf("--backup-manifest");
const backupPath = backupIndex >= 0 ? process.argv[backupIndex + 1] : "";
const acceptanceIndex = process.argv.indexOf("--device-acceptance");
const acceptancePath = acceptanceIndex >= 0 ? process.argv[acceptanceIndex + 1] : "";
const usageIndex = process.argv.indexOf("--usage-evidence");
const usagePath = usageIndex >= 0 ? process.argv[usageIndex + 1] : "";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

const manifest = readJson(manifestPath);
const cloudbase = readJson(cloudbasePath);
const buildIdentity = readJson(buildIdentityPath);
const desktopPackage = readJson(desktopPackagePath);
const desktopLock = readJson(desktopLockPath);
const backendIdentity = readJson(backendIdentityPath);
const miniEnv = fs.readFileSync(miniEnvPath, "utf8");
const functions = new Map((cloudbase.functions || []).map((item) => [item.name, item]));
const ordered = functions.get("notebookApi")?.envVariables?.ENABLE_ORDERED_SYNC === "true"
  && functions.get("desktopSync")?.envVariables?.ENABLE_ORDERED_SYNC === "true";
const indexesVerified = functions.get("notebookApi")?.envVariables?.ORDERED_SYNC_INDEXES_VERIFIED === "true"
  && functions.get("desktopSync")?.envVariables?.ORDERED_SYNC_INDEXES_VERIFIED === "true";
const localReady = manifest.status === "ready"
  && manifest.enableFlags?.ENABLE_ORDERED_SYNC === "true"
  && manifest.enableFlags?.ORDERED_SYNC_INDEXES_VERIFIED === "true"
  && ordered
  && indexesVerified;
const releaseIdentityConsistent = desktopPackage.version === buildIdentity.version
  && desktopLock.version === buildIdentity.version
  && desktopLock.packages?.[""]?.version === buildIdentity.version
  && miniEnv.includes(`clientVersion: '${buildIdentity.miniVersion}'`)
  && backendIdentity.releaseSet === buildIdentity.releaseSet
  && backendIdentity.desktopVersion === buildIdentity.version
  && backendIdentity.miniVersion === buildIdentity.miniVersion
  && ["notebookApi", "desktopSync"].every(name => {
    try {
      const packaged = readJson(path.join(miniRoot, 'cloudfunctions', name, 'release-identity.json'));
      return JSON.stringify(packaged) === JSON.stringify(backendIdentity);
    } catch { return false; }
  });

const requiredCollections = ["tasks", "daily_tasks", "captures", "day_records"];
const requiredIndexFields = ["ownerOpenId", "_syncSequence", "_id"];
let liveIndexAuditVerified = false;
let liveIndexAuditError = "";
if (auditPath) {
  try {
    const audit = readJson(path.resolve(auditPath));
    const sameEnvironment = audit.envId === cloudbase.envId;
    const complete = requiredCollections.every((collection) => {
      const names = Array.isArray(audit.indexes?.[collection]) ? audit.indexes[collection] : [];
      const definitions = Array.isArray(audit.indexDefinitions?.[collection]) ? audit.indexDefinitions[collection] : [];
      return names.includes(requiredIndexFields.join(" + "))
        || names.includes(requiredIndexFields.join("_"))
        || [...names, ...definitions].some((item) => Array.isArray(item?.fields)
          && item.fields.join(" + ") === requiredIndexFields.join(" + "))
        || definitions.some((item) => item && item.key && Object.keys(item.key).join(" + ") === requiredIndexFields.join(" + "));
    });
    liveIndexAuditVerified = sameEnvironment && complete && audit.mutation === false;
    if (!sameEnvironment) liveIndexAuditError = "read-only index audit belongs to another environment";
    else if (!complete) liveIndexAuditError = "read-only index audit does not show all four required indexes";
    else if (audit.mutation !== false) liveIndexAuditError = "index audit is not marked read-only";
  } catch (error) {
    liveIndexAuditError = `cannot read read-only index audit: ${error.message}`;
  }
}

let backupVerified = false;
let backupError = "";
if (backupPath) {
  try {
    const backup = readJson(path.resolve(backupPath));
    const requiredFunctions = ["notebookApi", "desktopSync"];
    const complete = requiredFunctions.every((name) => {
      const item = (backup.functions || []).find((entry) => entry.function === name);
      if (!item || !/^[a-f0-9]{64}$/i.test(String(item.deployedBackupSha256 || "")) || !item.backupPath) return false;
      const file = path.resolve(path.dirname(path.resolve(backupPath)), item.backupPath);
      return fs.statSync(file).isFile()
        && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === item.deployedBackupSha256.toLowerCase();
    });
    backupVerified = backup.environmentId === cloudbase.envId
      && backup.scope === "read-only backup metadata; no live mutation"
      && complete;
    if (backup.environmentId !== cloudbase.envId) backupError = "backup manifest belongs to another environment";
    else if (!complete) backupError = "backup manifest does not match both function entry file digests";
    else if (backup.scope !== "read-only backup metadata; no live mutation") backupError = "backup manifest scope is not read-only";
  } catch (error) {
    backupError = `cannot read backup manifest: ${error.message}`;
  }
}

const requiredAcceptanceChecks = [
  "phone_to_desktop_add",
  "desktop_to_phone_add",
  "both_sides_delete",
  "history_and_photos",
  "offline_restart_retry",
  "concurrent_edit",
  "cross_midnight",
  "account_workspace_switch",
];

let deviceAcceptanceVerified = false;
let deviceAcceptanceError = "";
if (acceptancePath) {
  try {
    const acceptance = readJson(path.resolve(acceptancePath));
    const checks = acceptance.checks || {};
    const complete = requiredAcceptanceChecks.every((name) => checks[name]?.status === "passed"
      && String(checks[name]?.evidence || "").trim().length > 0);
    const sameRelease = acceptance.environmentId === cloudbase.envId
      && acceptance.releaseSet === buildIdentity.releaseSet
      && acceptance.desktopVersion === buildIdentity.version
      && acceptance.miniVersion === buildIdentity.miniVersion;
    const captured = Date.parse(String(acceptance.capturedAt || ""));
    deviceAcceptanceVerified = sameRelease && complete && Number.isFinite(captured);
    if (!sameRelease) deviceAcceptanceError = "device acceptance belongs to another environment or release";
    else if (!complete) deviceAcceptanceError = "device acceptance does not contain all required passed checks with evidence";
    else if (!Number.isFinite(captured)) deviceAcceptanceError = "device acceptance capturedAt is invalid";
  } catch (error) {
    deviceAcceptanceError = `cannot read device acceptance: ${error.message}`;
  }
}

let usageEvidenceVerified = false;
let usageEvidenceError = "";
if (usagePath) {
  try {
    const usage = readJson(path.resolve(usagePath));
    const windowHours = Number(usage.windowHours);
    const hasMetrics = usage.metrics && typeof usage.metrics === "object"
      && Number.isFinite(Number(usage.metrics.apiCalls))
      && Number.isFinite(Number(usage.metrics.noSqlReadRequests))
      && Number.isFinite(Number(usage.metrics.noSqlWriteRequests));
    const completeCoverage = usage.metricCoverage?.complete === true;
    const sameEnvironment = usage.environmentId === cloudbase.envId;
    const migrationOnly = usage.migrationOnly === true;
    usageEvidenceVerified = sameEnvironment && windowHours >= 24 && hasMetrics && completeCoverage && !migrationOnly;
    if (!sameEnvironment) usageEvidenceError = "quota evidence belongs to another environment";
    else if (windowHours < 24) usageEvidenceError = "quota evidence must cover at least 24 hours";
    else if (!hasMetrics) usageEvidenceError = "quota evidence is missing API and NoSQL metrics";
    else if (!completeCoverage) usageEvidenceError = "quota evidence has incomplete metric coverage";
    else if (migrationOnly) usageEvidenceError = "quota evidence is marked migration-only";
  } catch (error) {
    usageEvidenceError = `cannot read quota evidence: ${error.message}`;
  }
}

const reasons = [];
if (manifest.status !== "ready") reasons.push(`ordered-sync-index-manifest.status=${manifest.status}`);
if (!ordered) reasons.push("cloudbaserc ordered sync is not enabled for both writer functions");
if (!indexesVerified) reasons.push("cloudbaserc index verification is not enabled for both writer functions");
if (!localReady) reasons.push("CloudBase index creation, workspace backfill, and live verification are still required");
if (!releaseIdentityConsistent) reasons.push("desktop, mini-program, and cloud-function release identities are inconsistent");
if (!auditPath) reasons.push("a current read-only CloudBase index audit must be supplied before live deployment");
else if (!liveIndexAuditVerified) reasons.push(liveIndexAuditError || "read-only CloudBase index audit failed");
if (!backupPath) reasons.push("a same-environment function backup manifest must be supplied before live deployment");
else if (!backupVerified) reasons.push(backupError || "function backup manifest failed");
const liveReasons = [];
if (!acceptancePath) liveReasons.push("a current device acceptance report must be supplied before live deployment");
else if (!deviceAcceptanceVerified) liveReasons.push(deviceAcceptanceError || "device acceptance report failed");
if (!usagePath) liveReasons.push("a non-migration quota measurement covering at least 24 hours must be supplied before live deployment");
else if (!usageEvidenceVerified) liveReasons.push(usageEvidenceError || "quota evidence failed");
if (allowLive) reasons.push(...liveReasons);
if (allowLive && process.env.ALLOW_LIVE_DEPLOY !== "1") reasons.push("--allow-live requires ALLOW_LIVE_DEPLOY=1");

const localDeploymentReady = reasons.length === 0;
const liveDeploymentReady = localDeploymentReady && liveReasons.length === 0 && process.env.ALLOW_LIVE_DEPLOY === "1";

const result = {
  generatedAt: new Date().toISOString(),
  environmentId: cloudbase.envId,
  deploymentReady: localDeploymentReady,
  liveDeploymentReady,
  liveIndexAuditVerified,
  liveIndexAuditPath: auditPath ? path.resolve(auditPath) : "",
  backupVerified,
  backupManifestPath: backupPath ? path.resolve(backupPath) : "",
  deviceAcceptanceVerified,
  deviceAcceptancePath: acceptancePath ? path.resolve(acceptancePath) : "",
  usageEvidenceVerified,
  usageEvidencePath: usagePath ? path.resolve(usagePath) : "",
  liveDeploymentRequested: allowLive,
  liveReasons,
  releaseIdentity: {
    consistent: releaseIdentityConsistent,
    releaseSet: buildIdentity.releaseSet,
    desktopVersion: buildIdentity.version,
    miniVersion: buildIdentity.miniVersion,
  },
  reasons,
  requiredBeforeLive: [
    "backup the currently deployed functions",
    "verify the four ownerOpenId + _syncSequence + _id indexes",
    "supply a current read-only index audit for the exact target environment",
    "run bounded ordered-sync backfill for every workspace",
    "rehearse the writer rollout and record quota impact",
    "perform device acceptance on the exact desktop and mini-program release",
    "measure API, NoSQL, function, storage, traffic, and idle activity for at least 24 hours",
  ],
};

process.stdout.write(`${jsonOnly ? JSON.stringify(result, null, 2) : [
  `Environment: ${result.environmentId}`,
  `Deployment ready: ${result.deploymentReady ? "yes" : "no"}`,
  ...(result.reasons.length ? ["Reasons:", ...result.reasons.map((reason) => `- ${reason}`)] : []),
].join("\n")}\n`);

if (allowLive && !result.deploymentReady) process.exitCode = 2;
