const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const sync = require('../electron/cloud-sync.cjs');
const evidence = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mainline-image-cache-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=', 'base64');
function fixture() {
  const root = fs.mkdtempSync(path.join(evidence, 'image-cache-'));
  const directory = path.join(root, 'data', 'comment-images'); fs.mkdirSync(directory, { recursive: true });
  const relativePath = 'todo-image-0-abcdef.png';
  return { root, directory, relativePath, file: path.join(directory, relativePath), cleanup() {
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(evidence) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test('empty and truncated image caches are not treated as usable local photos', () => {
  const f = fixture();
  try {
    for (const bytes of [Buffer.alloc(0), PNG.subarray(0, 24), Buffer.from('not a photo')]) {
      fs.writeFileSync(f.file, bytes);
      assert.equal(sync.attachmentHasLocalFile(f.root, { relativePath: f.relativePath }), false);
    }
    fs.writeFileSync(f.file, PNG);
    assert.equal(sync.attachmentHasLocalFile(f.root, { relativePath: f.relativePath, size: PNG.length }), true);
    assert.equal(sync.attachmentHasLocalFile(f.root, { relativePath: f.relativePath, size: PNG.length + 3 }), false);
  } finally { f.cleanup(); }
});

test('a truncated historical cache is downloaded again and relinked to the intact photo', async () => {
  const f = fixture(), before = global.fetch; let downloads = 0;
  const attachment = { id: 'p', fileID: 'cloud://env/old', relativePath: f.relativePath, previewUrl: 'https://files.test/photo', size: PNG.length };
  const state = { dailyTasks: [{ id: 'old', date: '2026-08-06', entryKind: 'today_todo', comments: [{ id: 'c', attachments: [attachment] }] }] };
  global.fetch = async (url, options) => {
    if (url === attachment.previewUrl) { downloads++; return new Response(PNG, { headers: { 'content-length': String(PNG.length) } }); }
    assert.equal(url, 'http://127.0.0.1:4420/api/action');
    return { ok: true, json: async () => ({ ...state, ...JSON.parse(options.body).collections }) };
  };
  try {
    fs.writeFileSync(f.file, PNG.subarray(0, 24));
    const result = await sync.cacheCloudAttachmentsLocally(f.root, 'http://127.0.0.1:4420', state);
    assert.equal(downloads, 1); assert.equal(result.downloaded, 1);
    const received = result.state.dailyTasks[0].comments[0].attachments[0];
    assert.equal(sync.attachmentHasLocalFile(f.root, received), true);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, received.relativePath)), PNG);
  } finally { global.fetch = before; f.cleanup(); }
});

test('failed disk write and account cancellation cannot replace an existing good cache', async () => {
  const { writeImage } = require('../electron/comment-image-cache.cjs'), io = require('node:fs/promises');
  const f = fixture();
  try {
    fs.writeFileSync(f.file, PNG);
    const failing = { ...io, async open(file, flags) {
      const handle = await io.open(file, flags);
      return { async writeFile(bytes) { await handle.write(bytes.subarray(0, 24)); throw new Error('磁盘已满'); }, sync: () => handle.sync(), close: () => handle.close() };
    } };
    await assert.rejects(writeImage(f.directory, f.relativePath, PNG, () => {}, failing), /磁盘已满/);
    assert.deepEqual(fs.readFileSync(f.file), PNG);
    assert.deepEqual(fs.readdirSync(f.directory), [f.relativePath]);
    let checks = 0;
    await assert.rejects(writeImage(f.directory, f.relativePath, PNG, () => { if (++checks === 2) throw new Error('空间已切换'); }), /空间已切换/);
    assert.deepEqual(fs.readFileSync(f.file), PNG);
    assert.deepEqual(fs.readdirSync(f.directory), [f.relativePath]);
  } finally { f.cleanup(); }
});

test('a truncated download never creates a final cache or publishes a local attachment path', async () => {
  const f = fixture(), before = global.fetch;
  const state = { dailyTasks: [{ id: 't', entryKind: 'today_todo', comments: [{ id: 'c', attachments: [
    { id: 'p', fileID: 'cloud://env/truncated', previewUrl: 'https://files.test/truncated', size: PNG.length }
  ] }] }] };
  global.fetch = async () => new Response(PNG.subarray(0, 24), { headers: { 'content-length': String(PNG.length) } });
  try {
    const result = await sync.cacheCloudAttachmentsLocally(f.root, 'http://127.0.0.1:4420', state);
    assert.equal(result.failed, 1); assert.equal(result.downloaded, 0);
    assert.equal(result.state.dailyTasks[0].comments[0].attachments[0].relativePath, undefined);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { global.fetch = before; f.cleanup(); }
});

test('URL hydration sends record references, preserves expiry, and ignores deleted photo sources', async () => {
  const f = fixture(), before = global.fetch, calls = [];
  const attachment = { id: 'p', fileID: 'cloud://env/photo' };
  const state = { dailyTasks: [
    { id: 't', entryKind: 'today_todo', comments: [{ id: 'c', attachments: [attachment] }] },
    { id: 'deleted', entryKind: 'today_todo', deletedAt: 'now', comments: [{ id: 'c', attachments: [{ id: 'q', fileID: 'cloud://env/deleted' }] }] }
  ] };
  const expiresAt = new Date(Date.now() + 600000).toISOString();
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (url === 'https://cloud.test/sync') return { ok: true, json: async () => ({ ok: true, data: { files: [{ fileID: attachment.fileID, url: 'https://files.test/p', expiresAt }] } }) };
    assert.equal(url, 'http://127.0.0.1:4420/api/action');
    return { ok: true, json: async () => ({ ...state, ...body.collections }) };
  };
  try {
    const result = await sync.hydrateAttachmentUrls({ endpoint: 'https://cloud.test/sync', token: 'fixture' }, f.root, 'http://127.0.0.1:4420', state);
    assert.deepEqual(calls[0].payload.references, [{ todoId: 't', attachmentId: 'p', fileID: attachment.fileID }]);
    assert.equal(result.state.dailyTasks[0].comments[0].attachments[0].previewUrlExpiresAt, expiresAt);
    const warm = await sync.hydrateAttachmentUrls({ endpoint: 'https://cloud.test/sync', token: 'fixture' }, f.root, 'http://127.0.0.1:4420', result.state);
    assert.equal(warm.functionCalls, 0);
    const sanitized = sync.sanitizeDailyTask(result.state.dailyTasks[0]);
    assert.equal(sanitized.comments[0].attachments[0].previewUrlExpiresAt, undefined);
  } finally { global.fetch = before; f.cleanup(); }
});

test('structural validation accepts JPEG scan markers and WebP length boundaries, rejecting truncation', () => {
  const { imageExtension } = require('../electron/comment-image-cache.cjs');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0,
    0xff, 0xda, 0, 2, 13, 0xff, 0, 14, 0xff, 0xd0, 15, 0xff, 0xd9]);
  assert.equal(imageExtension(jpeg), '.jpg');
  assert.equal(imageExtension(Buffer.concat([jpeg, Buffer.from('motion-photo-tail')])), '.jpg');
  assert.equal(imageExtension(jpeg.subarray(0, -1)), '');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([16, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([4, 0, 0, 0, 1, 2, 3, 4])]);
  assert.equal(imageExtension(webp), '.webp');
  assert.equal(imageExtension(webp.subarray(0, -1)), '');
});

test('an explicit unavailable photo response clears stale URLs and prevents an obsolete download', async () => {
  const f = fixture(), before = global.fetch; let downloads = 0;
  const attachment = { id: 'p', fileID: 'cloud://env/gone', previewUrl: 'https://files.test/stale', previewUrlExpiresAt: '2020-01-01T00:00:00.000Z' };
  const state = { dailyTasks: [{ id: 't', entryKind: 'today_todo', comments: [{ id: 'c', attachments: [attachment] }] }] };
  global.fetch = async (url, options) => {
    if (url === attachment.previewUrl) { downloads++; return new Response(PNG); }
    const body = JSON.parse(options.body);
    if (url === 'https://cloud.test/sync') return { ok: true, json: async () => ({ ok: true, data: { files: [{ fileID: attachment.fileID, url: '', expiresAt: '', error: 'PHOTO_UNAVAILABLE' }] } }) };
    return { ok: true, json: async () => ({ ...state, ...body.collections }) };
  };
  try {
    const hydrated = await sync.hydrateAttachmentUrls({ endpoint: 'https://cloud.test/sync', token: 'fixture' }, f.root, 'http://127.0.0.1:4420', state);
    assert.equal(hydrated.state.dailyTasks[0].comments[0].attachments[0].previewUrl, '');
    const cached = await sync.cacheCloudAttachmentsLocally(f.root, 'http://127.0.0.1:4420', hydrated.state);
    assert.equal(downloads, 0); assert.equal(cached.failed, 1);
    assert.equal(cached.state.dailyTasks[0].comments[0].attachments[0].fileID, attachment.fileID);
  } finally { global.fetch = before; f.cleanup(); }
});

test('replacing a cloud file invalidates every local preview field even after record merge', () => {
  const { mergeRecord } = require('../electron/record-merge.cjs');
  const local = { id: 't', comments: [{ id: 'c', attachments: [{ id: 'p', fileID: 'cloud://env/old',
    relativePath: 'todo-image-0-aaaa.png', previewUrl: 'https://files.test/old', previewUrlFetchedAt: 'old', previewUrlExpiresAt: 'old' }] }] };
  const incoming = { id: 't', comments: [{ id: 'c', attachments: [{ id: 'p', fileID: 'cloud://env/new' }] }] };
  const prepared = sync.preserveLocalAttachmentPaths([incoming], [local])[0];
  const result = mergeRecord(local, prepared).comments[0].attachments[0];
  assert.equal(result.fileID, 'cloud://env/new');
  for (const key of ['relativePath', 'previewUrl', 'previewUrlFetchedAt', 'previewUrlExpiresAt']) assert.equal(result[key], '');
});

test('preview preservation is keyed by todo and comment as well as photo identity', () => {
  const local = ['a', 'b'].map((id) => ({ id, comments: [{ id: 'c', attachments: [{ id: 'p', fileID: 'cloud://env/' + id,
    relativePath: 'todo-image-0-' + id + '.png', previewUrl: 'https://files.test/' + id }] }] }));
  const incoming = [{ id: 'a', comments: [{ id: 'c', attachments: [{ id: 'p', fileID: 'cloud://env/a' }] }] }];
  const result = sync.preserveLocalAttachmentPaths(incoming, local)[0].comments[0].attachments[0];
  assert.equal(result.relativePath, 'todo-image-0-a.png');
  assert.equal(result.previewUrl, 'https://files.test/a');
});
