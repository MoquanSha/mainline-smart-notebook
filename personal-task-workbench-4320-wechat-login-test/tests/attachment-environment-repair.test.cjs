const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const cloudSync = require(path.join(ROOT, 'electron', 'cloud-sync.cjs'))

const TEST_ENV_ID = 'public-demo-env'
const LEGACY_ENV_ID = 'legacy-demo-env'
const CURRENT_ENDPOINT = `https://${TEST_ENV_ID}.ap-shanghai.app.tcloudbase.com/desktop-sync`
const OLD_FILE_ID = `cloud://${LEGACY_ENV_ID}.bucket/todo-comments/old/image.png`
const CURRENT_FILE_ID = `cloud://${TEST_ENV_ID}.bucket/todo-comments/current/image.png`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=', 'base64')

function localAttachmentFixture() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-attachment-'))
  const imageDirectory = path.join(userData, 'data', 'comment-images')
  fs.mkdirSync(imageDirectory, { recursive: true })
  const relativePath = 'todo-image-1786011686421-m9oabw.png'
  fs.writeFileSync(path.join(imageDirectory, relativePath), PNG)
  return { userData, relativePath }
}

function task(id, attachment) {
  return {
    id,
    entryKind: 'today_todo',
    date: '2026-09-01',
    status: 'done',
    comments: [{ id: `comment-${id}`, attachments: [{ ...attachment }] }]
  }
}

test('old-environment attachment is repaired only when its local file is available', () => {
  const fixture = localAttachmentFixture()
  try {
    const oldAttachment = { id: 'image-1', relativePath: fixture.relativePath, fileID: OLD_FILE_ID }
    const currentAttachment = { ...oldAttachment, fileID: CURRENT_FILE_ID }
    assert.equal(cloudSync.endpointCloudEnvironment(CURRENT_ENDPOINT), TEST_ENV_ID)
    assert.equal(cloudSync.fileCloudEnvironment(OLD_FILE_ID), LEGACY_ENV_ID)
    assert.equal(cloudSync.attachmentNeedsUpload({ endpoint: CURRENT_ENDPOINT }, fixture.userData, oldAttachment), true)
    assert.equal(cloudSync.attachmentNeedsUpload({ endpoint: CURRENT_ENDPOINT }, fixture.userData, currentAttachment), false)
    fs.rmSync(path.join(fixture.userData, 'data', 'comment-images', fixture.relativePath))
    assert.equal(cloudSync.attachmentNeedsUpload({ endpoint: CURRENT_ENDPOINT }, fixture.userData, oldAttachment), false)
  } finally {
    fs.rmSync(fixture.userData, { recursive: true, force: true })
  }
})

test('historical duplicate references upload once and reuse the new fileID', async () => {
  const fixture = localAttachmentFixture()
  const originalFetch = global.fetch
  const calls = []
  const attachment = { id: 'image-1', relativePath: fixture.relativePath, fileID: OLD_FILE_ID }
  const state = { dailyTasks: [task('todo-a', attachment), task('todo-b', attachment)] }
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/api/comment-images/')) {
      return { ok: true, async arrayBuffer() { return Uint8Array.from(PNG).buffer } }
    }
    if (String(url) === CURRENT_ENDPOINT) {
      const body = JSON.parse(options.body)
      assert.equal(body.action, 'attachment.uploadInfo')
      return { ok: true, async json() { return { ok: true, data: { uploadUrl: 'https://upload.test/image', fileID: CURRENT_FILE_ID, cloudPath: 'todo-comments/current/image.png', headers: {} } } } }
    }
    if (String(url) === 'https://upload.test/image') return { ok: true }
    if (String(url) === 'http://127.0.0.1:4320/api/action') {
      const body = JSON.parse(options.body)
      return { ok: true, async json() { return { ...state, dailyTasks: body.collections.dailyTasks } } }
    }
    throw new Error(`unexpected URL ${url}`)
  }
  try {
    const result = await cloudSync.prepareLocalAttachments(
      { endpoint: CURRENT_ENDPOINT, token: 'test' },
      fixture.userData,
      'http://127.0.0.1:4320',
      state
    )
    assert.equal(result.uploaded, 1)
    assert.equal(result.changedIds.length, 2)
    assert.equal(calls.filter((call) => call.url === CURRENT_ENDPOINT).length, 1)
    assert.equal(calls.filter((call) => call.url === 'https://upload.test/image').length, 1)
    for (const row of result.state.dailyTasks) {
      assert.equal(row.comments[0].attachments[0].fileID, CURRENT_FILE_ID)
    }
  } finally {
    global.fetch = originalFetch
    fs.rmSync(fixture.userData, { recursive: true, force: true })
  }
})


