const QUOTA_MARKERS = [
  'INSUFFICIENTBALANCE',
  'INSUFFICIENT_BALANCE',
  'QUOTAEXCEEDED',
  'QUOTA_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'OUT_OF_QUOTA',
  '余额不足',
  '额度不足',
  '配额不足',
  '超出配额'
]

const CLOUD_ONLY_PREFIXES = ['workspace.', 'identity.', 'login.mini.', 'data.', 'device.createPairCode', 'diary.refresh', 'diary.organizationStep']
const READ_ACTIONS = new Set([
  'sync.snapshot', 'sync.historyPage', 'sync.changes',
  'bootstrap', 'todayTodo.list', 'todayTodo.history', 'todayTodo.completedByDate', 'journal.overview',
  'journal.listToday', 'journal.listArchive', 'trash.list', 'proposal.list',
  'task.list', 'source.list', 'device.status', 'login.mini.preview'
])

function errorText(error) {
  const values = []
  const visit = (value, depth = 0) => {
    if (depth > 4 || value === null || value === undefined) return
    if (typeof value === 'string' || typeof value === 'number') {
      values.push(String(value))
      return
    }
    if (typeof value !== 'object') return
    for (const key of ['code', 'errCode', 'errno', 'message', 'errMsg', 'errorCode', 'errorMessage', 'statusCode']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key], depth + 1)
    }
    if (value.error) visit(value.error, depth + 1)
    if (value.result) visit(value.result, depth + 1)
    if (value.cause) visit(value.cause, depth + 1)
  }
  visit(error)
  return values.join(' ').toUpperCase().replace(/[\s-]+/g, '_')
}

function isQuotaError(error) {
  const text = errorText(error)
  return QUOTA_MARKERS.some((marker) => text.includes(marker.toUpperCase().replace(/[\s-]+/g, '_')))
}

function isCloudOnlyAction(action) {
  return CLOUD_ONLY_PREFIXES.some((prefix) => String(action || '').startsWith(prefix))
}

function isReadAction(action) {
  return READ_ACTIONS.has(String(action || ''))
}

function isBusinessMutation(action) {
  const value = String(action || '')
  return !isReadAction(value) && !isCloudOnlyAction(value) && value !== 'device.requestSync'
}

function fallbackMode(homeConfigured, homeReachable) {
  if (!homeConfigured) return 'local'
  return homeReachable === false ? 'local' : 'home'
}

module.exports = {
  QUOTA_MARKERS,
  errorText,
  isQuotaError,
  isCloudOnlyAction,
  isReadAction,
  isBusinessMutation,
  fallbackMode
}
