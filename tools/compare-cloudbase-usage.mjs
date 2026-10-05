#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
function value(name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`)
  return args[index + 1]
}

const baselinePath = path.resolve(value('--baseline'))
const finalPath = path.resolve(value('--final'))
const outputPath = path.resolve(value('--output'))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const baseline = readJson(baselinePath)
const final = readJson(finalPath)
if (baseline.environmentId !== final.environmentId) throw new Error('quota snapshots belong to different environments')
if (baseline.metricCoverage?.complete !== true || final.metricCoverage?.complete !== true) {
  throw new Error('quota snapshots have incomplete metric coverage; repeat with a complete CloudBase billing-cycle range')
}
const start = Date.parse(String(baseline.capturedAt || ''))
const end = Date.parse(String(final.capturedAt || ''))
if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('snapshot timestamps are invalid or out of order')

const metricNames = [
  'apiCalls', 'noSqlReadRequests', 'noSqlWriteRequests',
  'cloudFunctionInvocations', 'storageReadRequests', 'storageWriteRequests',
  'trafficBytes', 'idleActivity',
]
const metrics = {}
for (const name of metricNames) {
  const before = Number(baseline.metrics?.[name])
  const after = Number(final.metrics?.[name])
  if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) throw new Error(`invalid cumulative metric: ${name}`)
  metrics[name] = after - before
}

const result = {
  capturedAt: new Date(end).toISOString(),
  environmentId: final.environmentId,
  windowStart: new Date(start).toISOString(),
  windowEnd: new Date(end).toISOString(),
  windowHours: (end - start) / 3600000,
  migrationOnly: Boolean(baseline.migrationOnly || final.migrationOnly),
  metrics,
  metricCoverage: {
    baseline: baseline.metricCoverage,
    final: final.metricCoverage,
    complete: true,
  },
  source: 'difference of two read-only CloudBase usage snapshots',
  baselineSnapshot: baselinePath,
  finalSnapshot: finalPath,
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
