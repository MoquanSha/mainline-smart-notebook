import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-release-test-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
process.env.SMART_NOTEBOOK_INSTANCE_ID = 'synthetic-instance';
const { server } = await import('../server.mjs');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('packaged test build never includes a project notebook as new-account seed', () => {
  assert.ok(!(pkg.build.extraResources || []).some(row => /data[\\/]notebook\.json/.test(row.from)));
  const source = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('seedNotebookIfNeeded'), 'missing personal data must reach recovery rather than receive an embedded seed');
});
test('server health identifies the build, source, data directory and exact child instance', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const data = await fetch(`http://127.0.0.1:${server.address().port}/api/health`).then(response => response.json());
    assert.equal(data.build?.version, pkg.version);
    assert.equal(data.runtime?.instanceId, 'synthetic-instance');
    assert.equal(data.runtime?.pid, process.pid);
    assert.equal(path.resolve(data.runtime?.dataPath || '.'), path.join(directory, 'notebook.json'));
    assert.notEqual(data.homeSyncPort, 4317);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test.after(() => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('mainline-release-test-'));
  fs.rmSync(directory, { recursive: true, force: true });
});
