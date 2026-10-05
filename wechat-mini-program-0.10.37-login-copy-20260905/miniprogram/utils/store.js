const KEYS = {
  captures: 'mainline.captures',
  tasks: 'mainline.tasks',
  proposals: 'mainline.proposals'
}

function read(key) {
  return wx.getStorageSync(key) || []
}

function write(key, value) {
  wx.setStorageSync(key, value)
  return value
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function addCapture(content) {
  const captures = read(KEYS.captures)
  const capture = {
    id: createId('capture'),
    content: content.trim(),
    occurredAt: new Date().toISOString(),
    status: 'unprocessed'
  }
  write(KEYS.captures, [capture, ...captures])
  return capture
}

function seedIfEmpty() {
  if (!read(KEYS.tasks).length) {
    write(KEYS.tasks, [
      {
        id: 'track_application',
        title: '导师联络与研究申请',
        nextAction: '核对一个目标与材料要求',
        owner: 'me',
        progress: 20,
        status: 'active'
      },
      {
        id: 'track_research',
        title: '具身智能系统学习',
        nextAction: '完成一个问题导向的阅读单元',
        owner: 'both',
        progress: 10,
        status: 'active'
      }
    ])
  }
}

module.exports = { KEYS, read, write, addCapture, seedIfEmpty }
