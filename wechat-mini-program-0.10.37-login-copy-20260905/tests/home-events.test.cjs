const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const MINI_ROOT = path.join(__dirname, '..', 'miniprogram')

function compile(file, dependencies = {}) {
  const source = fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  const localRequire = (request) => Object.prototype.hasOwnProperty.call(dependencies, request)
    ? dependencies[request]
    : require('node:module').createRequire(file)(request)
  new Function('require', 'module', 'exports', '__filename', '__dirname', source)(localRequire, module, module.exports, file, path.dirname(file))
  return module.exports
}

test('小程序通过 HTTPS 长轮询接收电脑变化，不依赖 CloudBase', async () => {
  const requests = []
  let aborted = false
  global.wx = {
    getStorageSync() { return '' },
    setStorageSync() {},
    request(options) {
      requests.push(options)
      return { abort() { aborted = true } }
    }
  }
  const cache = {
    requestId() { return 'request-id' },
    readConnection() { return { serverBaseUrl: 'https://home.example.com', token: 'x'.repeat(43) } },
    writeConnection(value) { return value }
  }
  const transport = compile(path.join(MINI_ROOT, 'utils', 'home-transport.js'), {
    '../config/env': { clientVersion: 'home-events-test' },
    './cache': cache
  })
  const changes = []
  const statuses = []
  const watcher = transport.watch((event) => changes.push(event), (connected) => statuses.push(connected))
  requests[0].success({ statusCode: 200, data: { ok: true, data: { type: 'connected', revision: 'r0' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(requests.length, 2)
  requests[1].success({ statusCode: 200, data: { ok: true, data: { type: 'changed', changed: true, revision: 'r1' } } })

  assert.equal(requests[0].url, 'https://home.example.com/api/home/changes')
  assert.equal(requests[1].url, 'https://home.example.com/api/home/changes?since=r0')
  assert.equal(requests[1].header.Authorization, `Bearer ${'x'.repeat(43)}`)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].revision, 'r1')
  assert.deepEqual(statuses, [true, true])
  watcher.close()
  assert.equal(aborted, true)
})

test('connection check uses a lightweight authenticated ping', async () => {
  let saved = null
  global.wx = {
    request(options) {
      assert.equal(options.url, 'https://home.example.com/api/home/ping')
      assert.equal(options.timeout, 6000)
      options.success({ statusCode: 200, data: { ok: true, data: { connected: true, protocolVersion: 2 } } })
      return { abort() {} }
    }
  }
  const cache = {
    requestId() { return 'request-id' },
    readConnection() { return { serverBaseUrl: '', token: '' } },
    writeConnection(value) { saved = value; return value }
  }
  const transport = compile(path.join(MINI_ROOT, 'utils', 'home-transport.js'), {
    '../config/env': { clientVersion: 'home-ping-test' },
    './cache': cache
  })
  const result = await transport.testConnection({ serverBaseUrl: 'https://home.example.com/', token: 'x'.repeat(43) })
  assert.equal(result.connected, true)
  assert.equal(saved.serverBaseUrl, 'https://home.example.com')
})

test('seven offline todos use one batch request', async () => {
  const requests = []
  global.wx = {
    request(options) {
      requests.push(options)
      options.success({
        statusCode: 200,
        data: { ok: true, data: { results: options.data.operations.map((item) => ({ requestId: item.requestId, ok: true })) } }
      })
      return { abort() {} }
    }
  }
  const cache = {
    requestId() { return 'request-id' },
    readConnection() { return { serverBaseUrl: 'https://home.example.com', token: 'x'.repeat(43) } },
    writeConnection(value) { return value }
  }
  const transport = compile(path.join(MINI_ROOT, 'utils', 'home-transport.js'), {
    '../config/env': { clientVersion: 'home-batch-test' },
    './cache': cache
  })
  const operations = Array.from({ length: 7 }, (_, index) => ({
    id: `offline-${index}`,
    action: 'todayTodo.add',
    payload: { content: `test-${index}` }
  }))
  const result = await transport.batch(operations)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://home.example.com/api/home/batch')
  assert.equal(requests[0].data.operations.length, 7)
  assert.equal(result.results.length, 7)
})
