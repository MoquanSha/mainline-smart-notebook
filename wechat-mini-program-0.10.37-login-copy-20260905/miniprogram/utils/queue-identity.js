function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key])
    return result
  }
  return value
}

function sameInput(left, right) {
  return left.action === right.action &&
    JSON.stringify(canonical(left.payload)) === JSON.stringify(canonical(right.payload))
}

function sameScope(left, right) {
  return Boolean(left && right && left.userId && left.workspaceId &&
    left.userId === right.userId && left.workspaceId === right.workspaceId)
}

function assertSameInput(existing, action, payload) {
  if (!sameInput(existing, { action, payload })) {
    throw Object.assign(new Error('同一操作编号对应了不同内容，原有待传内容已保留，请重新提交新内容'), {
      code: 'INPUT_ID_CONFLICT', retryable: false
    })
  }
  return existing
}

module.exports = { sameInput, sameScope, assertSameInput }
