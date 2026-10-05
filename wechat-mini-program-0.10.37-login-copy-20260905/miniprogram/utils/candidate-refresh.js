const api = require('./api')
const cache = require('./cache')

const REFRESH_COOLDOWN_MS = 30 * 60 * 1000

function isDue(now = Date.now()) {
  const lastRefreshAt = Number(cache.read(cache.KEYS.codexCandidateRefreshAt, 0))
  return !lastRefreshAt || now - lastRefreshAt >= REFRESH_COOLDOWN_MS
}

async function refreshIfDue(options = {}) {
  if (api.isManualSyncOnly && api.isManualSyncOnly() && !options.force) {
    return { skipped: true, reason: 'manual-sync-only' }
  }
  if (!options.force && !isDue()) return { skipped: true }
  const result = await api.call('proposal.refreshCodexCandidates')
  cache.write(cache.KEYS.codexCandidateRefreshAt, Date.now())
  return result
}

module.exports = { REFRESH_COOLDOWN_MS, isDue, refreshIfDue }
