const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = path.join(__dirname, '..', '..', 'miniprogram')
function scopedClient(handler, storage = new Map(), platform = {}, configOverrides = {}) {
  global.wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    cloud: { callFunction: handler },
    ...platform
  }
  global.getApp = () => ({ startRealtimeSync() {}, notifySyncListeners() {}, rememberLocalSyncRevision() {} })
  const loaded = new Map()
  function load(file) {
    if (loaded.has(file)) return loaded.get(file).exports
    const mod = { exports: {} }
    loaded.set(file, mod)
    const realRequire = createRequire(file)
    const localRequire = (request) => {
      if (request === '../config/env') return {
        apiFunction: 'notebookApi', clientVersion: 'reliability-test', cloudSyncEnabled: true, manualSyncOnly: true,
        ...configOverrides
      }
      if (request.startsWith('.')) return load(realRequire.resolve(request))
      return realRequire(request)
    }
    new Function('require', 'module', 'exports', '__filename', '__dirname', fs.readFileSync(file, 'utf8'))(
      localRequire, mod, mod.exports, file, path.dirname(file))
    return mod.exports
  }
  return { api: load(path.join(root, 'utils/api.js')), cache: load(path.join(root, 'utils/cache.js')),
    home: load(path.join(root, 'utils/home-transport.js')), storage }
}
module.exports = { scopedClient }
