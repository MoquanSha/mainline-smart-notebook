import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname)
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')

test('both Windows launchers forward verification arguments', () => {
  assert.match(read('open-reliability-test.cmd'), /-File .* %\*/) 
  assert.match(read('open-packaged-reliability.cmd'), /-File .* %\*/) 
})

test('packaged launcher checks identity and keeps an isolated data root', () => {
  const source = read('open-packaged-reliability.ps1')
  assert.match(source, /shared\\build-identity\.json/)
  assert.match(source, /package\.version -ne \$identity\.version/)
  assert.match(source, /MAINLINE_RELIABILITY_DATA_ROOT/)
  assert.match(source, /VerifyOnly/)
  assert.match(source, /LocalPort 4420/)
  assert.match(source, /旧版主线笔记仍在 4420 端口运行/)
})

test('running-release checker fails closed when a legacy instance answers on the old port', () => {
  const source = read('check-running-release.ps1')
  assert.match(source, /STALE_MAINLINE_INSTANCE_DETECTED/)
  assert.match(source, /exit 2/)
  assert.match(source, /4430, 4420/)
})

test('quota capture is read-only and emits the release-gate metrics', () => {
  const source = read('capture-cloudbase-usage.ps1')
  assert.match(source, /P:\\APP_下载汇总\\Nodejs\\Node\.exe/)
  assert.match(source, /env', 'usage/)
  assert.match(source, /env', 'info/)
  for (const metric of ['apiCalls', 'noSqlReadRequests', 'noSqlWriteRequests', 'cloudFunctionInvocations', 'idleActivity']) {
    assert.match(source, new RegExp(`\\b${metric}\\s*=`))
  }
  assert.match(source, /metricCoverage/)
  assert.match(source, /billingUsageFlexdbCredits/)
  assert.doesNotMatch(source, /fn\s+deploy|db\s+import|storage\s+upload/)
})

test('quota snapshot comparison emits a 24-hour-compatible delta', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-quota-'))
  const baselinePath = path.join(directory, 'baseline.json')
  const finalPath = path.join(directory, 'final.json')
  const outputPath = path.join(directory, 'evidence.json')
  const metrics = { apiCalls: 10, noSqlReadRequests: 20, noSqlWriteRequests: 3, cloudFunctionInvocations: 4, storageReadRequests: 5, storageWriteRequests: 6, trafficBytes: 7, idleActivity: 0 }
  const later = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, value + 1]))
  const metricCoverage = { complete: true, warnings: [] }
  fs.writeFileSync(baselinePath, JSON.stringify({ capturedAt: '2026-09-25T00:00:00.000Z', environmentId: 'env-test', migrationOnly: false, metricCoverage, metrics }))
  fs.writeFileSync(finalPath, JSON.stringify({ capturedAt: '2026-09-26T01:00:00.000Z', environmentId: 'env-test', migrationOnly: false, metricCoverage, metrics: later }))
  const result = JSON.parse(execFileSync(process.execPath, [path.join(root, 'compare-cloudbase-usage.mjs'), '--baseline', baselinePath, '--final', finalPath, '--output', outputPath], { encoding: 'utf8' }))
  assert.equal(result.windowHours, 25)
  assert.equal(result.metrics.apiCalls, 1)
  assert.equal(result.metrics.noSqlWriteRequests, 1)
  assert.equal(result.migrationOnly, false)
  assert.equal(result.metricCoverage.complete, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), result)
})

test('quota comparison rejects snapshots whose NoSQL coverage is ambiguous', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-quota-incomplete-'))
  const baselinePath = path.join(directory, 'baseline.json')
  const finalPath = path.join(directory, 'final.json')
  const outputPath = path.join(directory, 'evidence.json')
  const base = { apiCalls: 1, noSqlReadRequests: 0, noSqlWriteRequests: 0, cloudFunctionInvocations: 0, storageReadRequests: 0, storageWriteRequests: 0, trafficBytes: 0, idleActivity: 0 }
  const snapshot = { capturedAt: '2026-09-25T00:00:00.000Z', environmentId: 'env-test', migrationOnly: false, metricCoverage: { complete: false, warnings: ['ambiguous'] }, metrics: base }
  fs.writeFileSync(baselinePath, JSON.stringify(snapshot))
  fs.writeFileSync(finalPath, JSON.stringify({ ...snapshot, capturedAt: '2026-09-26T01:00:00.000Z' }))
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'compare-cloudbase-usage.mjs'), '--baseline', baselinePath, '--final', finalPath, '--output', outputPath], { encoding: 'utf8' }), /incomplete metric coverage/)
})

test('quota comparison accepts PowerShell UTF-8 BOM snapshots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-quota-bom-'))
  const baselinePath = path.join(directory, 'baseline.json')
  const finalPath = path.join(directory, 'final.json')
  const outputPath = path.join(directory, 'evidence.json')
  const metrics = { apiCalls: 10, noSqlReadRequests: 20, noSqlWriteRequests: 3, cloudFunctionInvocations: 4, storageReadRequests: 5, storageWriteRequests: 6, trafficBytes: 7, idleActivity: 0 }
  const coverage = { complete: true, warnings: [] }
  fs.writeFileSync(baselinePath, `\uFEFF${JSON.stringify({ capturedAt: '2026-09-25T00:00:00.000Z', environmentId: 'env-test', migrationOnly: false, metricCoverage: coverage, metrics })}`, 'utf8')
  fs.writeFileSync(finalPath, `\uFEFF${JSON.stringify({ capturedAt: '2026-09-26T01:00:00.000Z', environmentId: 'env-test', migrationOnly: false, metricCoverage: coverage, metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, value + 1])) })}`, 'utf8')
  const result = JSON.parse(execFileSync(process.execPath, [path.join(root, 'compare-cloudbase-usage.mjs'), '--baseline', baselinePath, '--final', finalPath, '--output', outputPath], { encoding: 'utf8' }))
  assert.equal(result.windowHours, 25)
  assert.equal(result.metrics.apiCalls, 1)
})
