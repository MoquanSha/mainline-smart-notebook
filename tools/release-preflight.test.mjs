import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";

// Exercise each gate with all other preconditions satisfied. A permanently
// pending repository manifest must not hide a missing boolean in the gate.
function readyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.copyFileSync(path.join(import.meta.dirname, 'release-preflight.mjs'), path.join(root, 'tools/release-preflight.mjs'));
  const desktop = 'personal-task-workbench-4320-wechat-login-test';
  const mini = 'wechat-mini-program-0.10.37-login-copy-20260905';
  const write = (file, data) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), JSON.stringify(data)); };
  const writeRaw = (file, data) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), data); };
  const build = { releaseSet: 'test-release', version: '1.0.0', miniVersion: '0.1.0' };
  const backend = { releaseSet: build.releaseSet, desktopVersion: build.version, miniVersion: build.miniVersion };
  write(desktop + '/shared/build-identity.json', build);
  write(desktop + '/package.json', { version: build.version });
  write(desktop + '/package-lock.json', { version: build.version, packages: { '': { version: build.version } } });
  write(mini + '/miniprogram/config/env.js', {});
  fs.writeFileSync(path.join(root, mini, 'miniprogram/config/env.js'), "module.exports = { clientVersion: '0.1.0' }");
  write(mini + '/cloudfunctions/release-identity.json', backend);
  const names = ['notebookApi', 'desktopSync'];
  for (const name of names) write(`${mini}/cloudfunctions/${name}/release-identity.json`, backend);
  const flags = { ENABLE_ORDERED_SYNC: 'true', ORDERED_SYNC_INDEXES_VERIFIED: 'true' };
  write(mini + '/cloudfunctions/ordered-sync-index-manifest.json', { status: 'ready', enableFlags: flags });
  write(mini + '/cloudbaserc.json', { envId: 'isolated-test', functions: names.map(name => ({ name, envVariables: flags })) });
  write('audit.json', { envId: 'isolated-test', mutation: false, checkedAt: new Date().toISOString(),
    indexDefinitions: Object.fromEntries(['tasks', 'daily_tasks', 'captures', 'day_records'].map(name => [name, [{ key: { ownerOpenId: 1, _syncSequence: 1, _id: 1 } }]])) });
  write('backup.json', { environmentId: 'isolated-test', scope: 'read-only backup metadata; no live mutation', functions: names.map(name => {
    const backupPath = path.join(root, name + '.js');
    fs.writeFileSync(backupPath, 'exports.main = async () => ({ ok: true });');
      return { function: name, backupPath, deployedBackupSha256: createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex') };
  }) });
  const checks = Object.fromEntries([
    'phone_to_desktop_add', 'desktop_to_phone_add', 'both_sides_delete', 'history_and_photos',
    'offline_restart_retry', 'concurrent_edit', 'cross_midnight', 'account_workspace_switch',
  ].map(name => [name, { status: 'passed', evidence: `${name} verified on the exact test release` }]));
  write('device-acceptance.json', {
    capturedAt: new Date().toISOString(), environmentId: 'isolated-test', releaseSet: build.releaseSet,
    desktopVersion: build.version, miniVersion: build.miniVersion, checks,
  });
  write('usage.json', {
    capturedAt: new Date().toISOString(), environmentId: 'isolated-test', windowHours: 24,
    migrationOnly: false, metricCoverage: { complete: true, warnings: [] }, metrics: { apiCalls: 8, noSqlReadRequests: 12, noSqlWriteRequests: 4 },
  });
  const run = (withBackup = true) => {
    const result = spawnSync(process.execPath, [path.join(root, 'tools/release-preflight.mjs'), '--json', '--allow-live', '--audit', path.join(root, 'audit.json'),
      ...(withBackup ? ['--backup-manifest', path.join(root, 'backup.json')] : []),
      '--device-acceptance', path.join(root, 'device-acceptance.json'), '--usage-evidence', path.join(root, 'usage.json')], { encoding: 'utf8', env: { ...process.env, ALLOW_LIVE_DEPLOY: '1' } });
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  return { root, run, write, writeRaw, desktop, mini };
}

test('otherwise ready release is rejected when backup is missing', t => {
  const f = readyFixture(t);
  assert.equal(f.run().report.deploymentReady, true, 'fixture must exercise the ready path');
  const result = f.run(false);
  assert.equal(result.report.deploymentReady, false);
  assert.equal(result.status, 2);
});

test('otherwise ready release is rejected on version drift', t => {
  const f = readyFixture(t);
  f.write(f.desktop + '/package.json', { version: 'old-version' });
  const result = f.run();
  assert.equal(result.report.releaseIdentity.consistent, false);
  assert.equal(result.report.deploymentReady, false);
  assert.equal(result.status, 2);
});

test('backup digest is checked against bytes, not just its format', t => {
  const f = readyFixture(t);
  fs.appendFileSync(path.join(f.root, 'notebookApi.js'), '\n// changed after backup');
  const result = f.run();
  assert.equal(result.report.backupVerified, false);
  assert.equal(result.report.deploymentReady, false);
});

test('live preflight rejects missing real-device acceptance evidence', t => {
  const f = readyFixture(t);
  fs.rmSync(path.join(f.root, 'device-acceptance.json'));
  const result = f.run();
  assert.equal(result.report.deviceAcceptanceVerified, false);
  assert.equal(result.report.deploymentReady, false);
  assert.ok(result.report.reasons.some((reason) => reason.includes('device acceptance')));
});

test('live preflight rejects migration-only quota evidence', t => {
  const f = readyFixture(t);
  f.write('usage.json', {
    capturedAt: new Date().toISOString(), environmentId: 'isolated-test', windowHours: 24,
    migrationOnly: true, metricCoverage: { complete: true, warnings: [] }, metrics: { apiCalls: 8, noSqlReadRequests: 12, noSqlWriteRequests: 4 },
  });
  const result = f.run();
  assert.equal(result.report.usageEvidenceVerified, false);
  assert.equal(result.report.deploymentReady, false);
  assert.ok(result.report.reasons.some((reason) => reason.includes('migration-only')));
});

test('live preflight rejects ambiguous quota coverage even with non-zero counters', t => {
  const f = readyFixture(t);
  f.write('usage.json', {
    capturedAt: new Date().toISOString(), environmentId: 'isolated-test', windowHours: 24,
    migrationOnly: false, metricCoverage: { complete: false, warnings: ['ambiguous'] }, metrics: { apiCalls: 8, noSqlReadRequests: 12, noSqlWriteRequests: 4 },
  });
  const result = f.run();
  assert.equal(result.report.usageEvidenceVerified, false);
  assert.equal(result.report.deploymentReady, false);
  assert.ok(result.report.reasons.some((reason) => reason.includes('incomplete metric coverage')));
});

test('live preflight accepts quota evidence written by Windows PowerShell with a BOM', t => {
  const f = readyFixture(t);
  f.writeRaw('usage.json', `\uFEFF${JSON.stringify({
    capturedAt: new Date().toISOString(), environmentId: 'isolated-test', windowHours: 24,
    migrationOnly: false, metricCoverage: { complete: true, warnings: [] }, metrics: { apiCalls: 8, noSqlReadRequests: 12, noSqlWriteRequests: 4 },
  })}`);
  const result = f.run();
  assert.equal(result.report.usageEvidenceVerified, true);
  assert.equal(result.report.deploymentReady, true);
});

test("release preflight fails closed without a current same-environment index audit", () => {
  const script = path.join(import.meta.dirname, "release-preflight.mjs");
  const result = spawnSync(process.execPath, [script, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deploymentReady, false);
  assert.equal(report.liveIndexAuditVerified, false);
  assert.ok(report.reasons.some((reason) => reason.includes("read-only CloudBase index audit")));
});

test("local preflight exposes the live gate instead of implying device and quota readiness", t => {
  const f = readyFixture(t);
  const script = path.join(f.root, "tools/release-preflight.mjs");
  const result = spawnSync(process.execPath, [script, "--json", "--audit", path.join(f.root, "audit.json"), "--backup-manifest", path.join(f.root, "backup.json")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deploymentReady, true, "local source and backup gates should be ready");
  assert.equal(report.liveDeploymentReady, false, "real-device and quota gates are still pending");
  assert.ok(report.liveReasons.some(reason => reason.includes("device acceptance")));
  assert.ok(report.liveReasons.some(reason => reason.includes("24 hours")));
});

test("live preflight requires a same-environment backup manifest", () => {
  const script = path.join(import.meta.dirname, "release-preflight.mjs");
  const result = spawnSync(process.execPath, [script, "--json", "--allow-live"], {
    encoding: "utf8", env: { ...process.env, ALLOW_LIVE_DEPLOY: "1" }
  });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deploymentReady, false);
  assert.equal(report.backupVerified, false);
  assert.ok(report.reasons.some((reason) => reason.includes("backup manifest")));
});
