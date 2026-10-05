import test from 'node:test'
import assert from 'node:assert/strict'
import { describeDesktopCloudSync } from '../src/sync-status.mjs'

test('电脑端把云端保存和本机接收分开显示', () => {
  const message = describeDesktopCloudSync({ pushed: 2, pulled: 3, conflicts: 0 }, { initial: true })
  assert.equal(message, '连接已建立：云端已确认保存 2 项；电脑已接收 3 项云端变化。')
  assert.doesNotMatch(message, /同步完成/)
})

test('上传或接收未完成时不会伪装成同步完成', () => {
  const message = describeDesktopCloudSync({ pushed: 1, pulled: 0, uploadPending: true, receivePending: true })
  assert.match(message, /云端已确认保存 1 项/)
  assert.match(message, /仍有本机内容等待云端确认/)
  assert.match(message, /仍有云端变化等待电脑接收/)
  assert.doesNotMatch(message, /同步完成/)
})
