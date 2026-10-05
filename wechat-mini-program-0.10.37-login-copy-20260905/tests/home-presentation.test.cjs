const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const presentation = require(path.join(__dirname, '..', 'miniprogram', 'pages', 'home', 'presentation.js'))

test('历史笔记保留缺少临时链接的照片，只排除已删除附件', () => {
  const comments = presentation.presentComments([
    {
      id: 'comment-a',
      createdAt: '2026-08-06T11:00:00.000Z',
      attachments: [
        { id: 'photo-a', previewUrl: 'https://example.test/a.webp' },
        { id: 'photo-deleted', previewUrl: 'https://example.test/deleted.webp', deletedAt: '2026-08-07T00:00:00.000Z' },
        { id: 'photo-missing-url', fileID: 'cloud://missing' }
      ]
    },
    {
      id: 'comment-b',
      attachments: [{ id: 'photo-b', previewUrl: 'https://example.test/b.webp' }]
    },
    { id: 'comment-deleted', deletedAt: '2026-08-07T00:00:00.000Z', attachments: [{ id: 'photo-hidden', previewUrl: 'https://example.test/hidden.webp' }] }
  ])

  assert.equal(comments.length, 2)
  assert.deepEqual(comments.map((comment) => comment.attachments.map((attachment) => attachment.id)), [['photo-a', 'photo-missing-url'], ['photo-b']])
  assert.deepEqual(presentation.collectPhotoAttachments(comments).map((attachment) => attachment.id), ['photo-a', 'photo-missing-url', 'photo-b'])
})

test('同一张历史照片被重复引用时缩略图只显示一次', () => {
  const attachment = { id: 'shared-photo', previewUrl: 'https://example.test/shared.webp' }
  const photos = presentation.collectPhotoAttachments([{ attachments: [attachment] }, { attachments: [attachment] }])
  assert.equal(photos.length, 1)
})
