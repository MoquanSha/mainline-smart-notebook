const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

function cloudRuntime(seed = [], hooks = {}) {
  const rows = new Map(seed.map((item) => [`daily_tasks/${item.id}`, structuredClone(item)]))
  const metrics = { reads: 0, writes: 0, transactions: 0 }
  let chain = Promise.resolve()
  const compare = (actual, rule) => rule?.op === 'and' ? rule.rules.every((child) => compare(actual, child))
    : rule?.op === 'lt' ? actual < rule.value : rule?.op === 'lte' ? actual <= rule.value
    : rule?.op === 'gt' ? actual > rule.value : rule?.op === 'gte' ? actual >= rule.value : actual === rule
  const matches = (row, query) => Object.entries(query).every(([key, value]) => compare(row[key], value))
  const command = (op, value) => ({ op, value, and(other) { return { op: 'and', rules: [this, other] } } })
  const collection = (store, name) => ({
    doc: (id) => ({
      get: async () => { metrics.reads++; return { data: store.has(`${name}/${id}`) ? [structuredClone(store.get(`${name}/${id}`))] : [] } },
      set: async (value) => {
        if (hooks.beforeSet) await hooks.beforeSet(name, id, value)
        metrics.writes++; store.set(`${name}/${id}`, structuredClone(value)); return {}
      },
      update: async (patch) => {
        const old = store.get(`${name}/${id}`)
        if (!old) return { updated: 0 }
        metrics.writes++
        store.set(`${name}/${id}`, { ...old, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value?.op === 'inc' ? Number(old[key] || 0) + value.value : structuredClone(value)])) })
        return { updated: 1 }
      }
    }),
    where: (query) => {
      let order, size = 100, offset = 0
      return {
        orderBy(key, direction) { order = { key, direction }; return this },
        limit(n) { size = n; return this }, skip(n) { offset = n; return this },
        async get() {
          metrics.reads++
          let data = [...store].filter(([key]) => key.startsWith(`${name}/`)).map(([key, value]) => ({ ...structuredClone(value), _id: value._id || key.slice(name.length + 1) })).filter((value) => matches(value, query))
          if (order) data.sort((a, b) => (typeof a[order.key] === 'number' && typeof b[order.key] === 'number' ? a[order.key] - b[order.key] : String(a[order.key] || '').localeCompare(String(b[order.key] || ''))) * (order.direction === 'desc' ? -1 : 1))
          return { data: data.slice(offset, offset + size) }
        }
      }
    }
  })
  const db = {
    command: { inc: (value) => ({ op: 'inc', value }), lt: (value) => command('lt', value), lte: (value) => command('lte', value), gt: (value) => command('gt', value), gte: (value) => command('gte', value) },
    collection: (name) => collection(rows, name),
    runTransaction(callback) {
      const operation = chain.then(async () => {
        metrics.transactions++
        const snapshot = new Map(structuredClone([...rows]))
        const result = await callback({ collection: (name) => ({ doc: collection(snapshot, name).doc }) })
        rows.clear()
        for (const [key, value] of snapshot) rows.set(key, value)
        return result
      })
      chain = operation.catch(() => {})
      return operation
    }
  }
  function load(name) {
    const file = path.resolve(__dirname, `../../cloudfunctions/${name}/index.js`)
    const native = createRequire(file), module = { exports: {} }
    new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(
      (id) => id === '@cloudbase/node-sdk' ? { init: () => ({ database: () => db, getTempFileURL: hooks.getTempFileURL || (async () => ({ fileList: [] })),
        ...(hooks.getUploadMetadata ? { getUploadMetadata: hooks.getUploadMetadata } : {}),
        ...(hooks.generateText ? { ai: () => ({ createModel: () => ({ generateText: hooks.generateText }) }) } : {}) }) } : native(id), module, module.exports)
    return { ...module.exports.__test, main: module.exports.main }
  }
  return { rows, db, metrics, api: load('notebookApi'), desktop: load('desktopSync'), webhook: load('wechatWebhook'), reload: () => load('notebookApi') }
}
module.exports = { cloudRuntime }
