const { sameScope } = require('./queue-identity')
const TARGET_ERRORS = new Set(['HOME_TARGET_CHANGED', 'HOME_TARGET_REQUIRED', 'HOME_CONNECTION_CHANGED'])
const failure = (code, message) => Object.assign(new Error(message), { code, retryable: false })

// A preview is local and contains the exact operations the user is reviewing.
// Unknown owners are counted separately and are never assigned to this account.
function createHomeQueueRecovery({ cache, home }) {
  function preview() {
    const scope = cache.currentScope(), target = cache.currentHomeTarget()
    const items = []
    let unscoped = 0
    for (const key of [cache.KEYS.queue, cache.KEYS.mirrorQueue]) {
      for (const operation of cache.read(key, [])) {
        if (key === cache.KEYS.mirrorQueue && !operation.pendingHome) continue
        if (!sameScope(operation.scope, scope)) { unscoped++; continue }
        if (!operation.homeTarget || operation.homeTarget !== target) {
          items.push({ key, id: operation.id, snapshot: JSON.stringify(operation) })
        }
      }
    }
    return { scope, scopeToken: cache.scopeToken(), target, items, unscoped }
  }

  async function confirm(review) {
    const check = () => {
      if (!review || review.scopeToken !== cache.scopeToken() || !sameScope(review.scope, cache.currentScope())) {
        throw failure('STALE_SCOPE', '账号或空间已切换，请重新查看待传内容')
      }
      if (review.target !== cache.currentHomeTarget()) {
        throw failure('HOME_CONNECTION_CHANGED', '电脑连接已更换，请重新查看待传目标')
      }
    }
    check()
    if (!review.items.length) return { rebound: 0, skipped: 0, unscoped: review.unscoped }
    if (!review.target) throw failure('HOME_TARGET_REQUIRED', '请先连接同一微信账号的电脑')
    const identity = await home.testConnection(home.connection())
    check()
    if (identity?.scopeProtocol !== 1 || !sameScope(identity.principal, review.scope)) {
      throw failure('HOME_IDENTITY_UNVERIFIED', '电脑尚不能核验账号归属，请更新并登录同一微信账号后重试')
    }
    let rebound = 0, skipped = 0
    for (const key of [cache.KEYS.queue, cache.KEYS.mirrorQueue]) {
      check()
      const selected = new Map(review.items.filter(item => item.key === key).map(item => [item.id, item.snapshot]))
      if (!selected.size) continue
      let changed = 0
      const next = cache.read(key, []).map(operation => {
        const snapshot = selected.get(operation.id)
        if (!snapshot) return operation
        selected.delete(operation.id)
        if (JSON.stringify(operation) !== snapshot || !sameScope(operation.scope, review.scope)) { skipped++; return operation }
        const updated = { ...operation, homeTarget: review.target }
        if (key === cache.KEYS.queue) {
          if (TARGET_ERRORS.has(updated.lastErrorCode)) {
            updated.status = 'pending'; updated.lastError = ''; updated.lastErrorCode = ''
          }
        } else {
          if (TARGET_ERRORS.has(updated.homeFailure?.lastErrorCode)) {
            updated.homeFailure = null; updated.homeStatus = 'pending'
          }
          const failures = ['cloud', 'home'].filter(dest => updated[dest === 'cloud' ? 'pendingCloud' : 'pendingHome'])
            .map(dest => updated[`${dest}Failure`]).filter(Boolean)
          const problem = failures.find(item => item.status === 'blocked') || failures[0]
          updated.status = problem?.status === 'blocked' ? 'blocked' : 'pending'
          updated.lastError = problem?.lastError || ''; updated.lastErrorCode = problem?.lastErrorCode || ''
        }
        changed++
        return updated
      })
      skipped += selected.size
      if (changed) { cache.write(key, next); rebound += changed }
    }
    // No upload is started here. The user can inspect the count before syncing.
    return { rebound, skipped, unscoped: review.unscoped }
  }
  return { preview, confirm }
}
module.exports = { createHomeQueueRecovery }
