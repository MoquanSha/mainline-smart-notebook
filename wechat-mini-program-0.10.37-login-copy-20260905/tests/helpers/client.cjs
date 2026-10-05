const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const MINI_ROOT = path.join(__dirname, '..', '..', 'miniprogram')

function compileCommonJs(file, dependencyMap = {}) {
  const source = fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  const localRequire = (request) => Object.prototype.hasOwnProperty.call(dependencyMap, request)
    ? dependencyMap[request]
    : require('node:module').createRequire(file)(request)
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source)
  factory(localRequire, module, module.exports, file, path.dirname(file))
  return module.exports
}

function success(data) {
  return Promise.resolve({ result: { ok: true, data } })
}

function baseSnapshot(overrides = {}) {
  const data = { todos: [], scheduled: [], history: [], ...(overrides.data || {}) }
  return {
    notModified: false,
    revision: overrides.revision || 'matrix-revision',
    bootstrap: { onboardingRequired: false, storagePrefix: 'users/test/todo-comments' },
    data,
    tasks: [],
    journal: { entries: [], favorites: [], hidden: [], history: [] },
    journalArchive: [],
    diaryDays: [],
    ...overrides,
    data
  }
}

function loadClient(handler) {
  let queue = []
  let requestSequence = 0
  const storage = new Map()
  global.wx = { cloud: { callFunction: handler } }
  global.getApp = () => ({ startRealtimeSync() {}, notifySyncListeners() {} })
  const cache = {
    KEYS: {
      queue: 'queue', bootstrap: 'bootstrap', todayTodos: 'todayTodos',
      journal: 'journal', journalArchive: 'journalArchive', trash: 'trash',
      proposals: 'proposals', tasks: 'tasks', mirrorQueue: 'mirrorQueue',
      diaryDays: 'diaryDays',
      homeConnection: 'homeConnection', hybridState: 'hybridState',
      syncRevision: 'syncRevision', syncSnapshotReady: 'syncSnapshotReady',
      confirmedSnapshot: 'confirmedSnapshot'
    },
    read(key, fallback) { return key === 'queue' ? queue : (storage.has(key) ? storage.get(key) : fallback) },
    write(key, value) { if (key === 'queue') queue = value; else storage.set(key, value); return value },
    requestId(prefix = 'req') { requestSequence += 1; return `${prefix}_matrix_${requestSequence}` },
    enqueue(action, payload, options = {}) {
      const id = options.id || payload.requestId || `${action}_queued`
      const existing = queue.find((item) => item.id === id)
      if (existing) return existing
      const coalesceKey = String(options.coalesceKey || '')
      const item = { id, action, payload, coalesceKey, attempts: 0, createdAt: '2026-08-20T01:00:00.000Z' }
      queue = coalesceKey
        ? [...queue.filter((queued) => queued.coalesceKey !== coalesceKey), item]
        : [...queue, item]
      return item
    },
    dequeue(id) { queue = queue.filter((item) => item.id !== id); return queue },
    readConnection() { return { serverBaseUrl: '', token: '' } },
    writeConnection(value) { storage.set('homeConnection', value); return value },
    readHybridState() {
      return storage.get('hybridState') || {
        mode: 'cloud', quotaBlocked: false, homeReachable: null,
        lastCloudError: '', lastCloudSuccessAt: '', lastHomeSuccessAt: '', cloudProbeAfter: 0
      }
    },
    writeHybridState(patch) {
      const next = { ...this.readHybridState(), ...patch }
      storage.set('hybridState', next)
      return next
    },
    enqueueMirror() { throw new Error('manual sync must not enqueue mirror work') }
  }
  const syncPolicy = compileCommonJs(path.join(MINI_ROOT, 'utils', 'sync-policy.js'))
  const hybridPolicy = compileCommonJs(path.join(MINI_ROOT, 'utils', 'hybrid-policy.js'))
  const home = {
    configured() { return false },
    connection() { return { serverBaseUrl: '', token: '' } },
    rpc() { return Promise.reject(new Error('home unavailable')) },
    testConnection() { return Promise.reject(new Error('home unavailable')) },
    uploadImage() { return Promise.reject(new Error('home unavailable')) }
  }
  const api = compileCommonJs(path.join(MINI_ROOT, 'utils', 'api.js'), {
    '../config/env': {
      apiFunction: 'notebookApi', clientVersion: 'matrix-test', cloudSyncEnabled: true,
      syncMode: 'cloud-manual', manualSyncOnly: true
    },
    './cache': cache,
    './home-transport': home,
    './hybrid-policy': hybridPolicy,
    './sync-policy': syncPolicy
  })
  return { api, cache, queue: () => queue, storage }
}


module.exports = { loadClient, baseSnapshot, compileCommonJs }
