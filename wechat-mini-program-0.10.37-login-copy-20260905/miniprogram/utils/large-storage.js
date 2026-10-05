const FORMAT = 'mainline-chunks-v1'
const CHUNK_SIZE = 65536
const CACHE_BUDGET = 2 * 1024 * 1024
const memory = new Map()
let memorySize = 0
let generation = 0

function storageError(code, message, cause) {
  return Object.assign(new Error(message), { code, retryable: false, cause })
}
function checksum(text) {
  let value = 2166136261
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return (value >>> 0).toString(16)
}
function isManifest(value) { return value && value._mainlineStorage === FORMAT }
function fileSystem() {
  return wx.getFileSystemManager && wx.env && wx.env.USER_DATA_PATH
    ? { fs: wx.getFileSystemManager(), root: wx.env.USER_DATA_PATH + '/mainline-cache-v1' } : null
}
function validManifest(value, key) {
  return isManifest(value) && value.key === key && ['files', 'storage'].includes(value.backend) &&
    typeof value.generation === 'string' && /^[a-z0-9-]+$/.test(value.generation) &&
    Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every((part, index) =>
      part.name === value.generation + '-' + index + '.part' && Number.isInteger(part.length) && part.length > 0 && typeof part.hash === 'string')
}
function partKey(name) { return 'mainline.chunk.v1.' + name }
function forget(key) {
  if (memory.has(key)) memorySize -= memory.get(key).text.length
  memory.delete(key)
}
function remember(key, version, text) {
  forget(key)
  if (text.length > CACHE_BUDGET) return
  while (memory.size && memorySize + text.length > CACHE_BUDGET) forget(memory.keys().next().value)
  memory.set(key, { version, text }); memorySize += text.length
}
function discardParts(manifest, key) {
  if (!validManifest(manifest, key)) return
  const files = manifest.backend === 'files' ? fileSystem() : null
  for (const part of manifest.parts) {
    try {
      if (manifest.backend === 'files' && files) files.fs.unlinkSync(files.root + '/' + part.name)
      else if (manifest.backend === 'storage' && wx.removeStorageSync) wx.removeStorageSync(partKey(part.name))
    } catch (_) { /* Garbage collection cannot invalidate a committed value. */ }
  }
}
function read(key, fallback) {
  let raw
  try { raw = wx.getStorageSync(key) } catch (error) {
    throw storageError('LOCAL_STORAGE_READ_FAILED', '本机存储暂时无法读取，未覆盖原数据', error)
  }
  if (raw === '' || raw === undefined || raw === null) return fallback
  if (!isManifest(raw)) return raw
  if (!validManifest(raw, key)) throw storageError('LOCAL_STORAGE_CORRUPT', '本机记录索引异常，原文件已保留，请先恢复数据')
  const version = raw.generation
  const cached = memory.get(key)
  if (cached && cached.version === version) return JSON.parse(cached.text)
  try {
    const files = raw.backend === 'files' ? fileSystem() : null
    if (raw.backend === 'files' && !files) throw new Error('local file API unavailable')
    const text = raw.parts.map((part) => {
      const value = files ? files.fs.readFileSync(files.root + '/' + part.name, 'utf8') : wx.getStorageSync(partKey(part.name))
      if (typeof value !== 'string' || value.length !== part.length || checksum(value) !== part.hash) throw new Error('missing or invalid record part')
      return value
    }).join('')
    if (text.length !== raw.length) throw new Error('record length mismatch')
    const result = JSON.parse(text)
    remember(key, version, text)
    return result
  } catch (error) {
    throw storageError('LOCAL_STORAGE_CORRUPT', '本机记录未能完整读取，未清空数据或前移同步进度', error)
  }
}
function write(key, value) {
  let old, manifest, text
  try {
    old = wx.getStorageSync(key)
    // A corrupt index must never be silently replaced by a fallback empty list.
    if (isManifest(old) && !validManifest(old, key)) throw storageError('LOCAL_STORAGE_CORRUPT', '本机记录索引异常，未覆盖原数据')
    const oldValue = isManifest(old) ? read(key) : old
    text = JSON.stringify(value)
    if (text === undefined) throw new Error('value is not serializable')
    if (JSON.stringify(oldValue) === text) return value
    if (text.length <= CHUNK_SIZE) {
      wx.setStorageSync(key, value)
      forget(key)
      discardParts(old, key)
      return value
    }
    const files = fileSystem()
    if (files) {
      try { files.fs.accessSync(files.root) } catch (_) { files.fs.mkdirSync(files.root, true) }
    }
    const id = Date.now().toString(36) + '-' + (++generation).toString(36) + '-' + Math.random().toString(36).slice(2)
    manifest = { _mainlineStorage: FORMAT, key, generation: id, backend: files ? 'files' : 'storage', length: text.length, parts: [] }
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + CHUNK_SIZE)
      const last = text.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff && end < text.length) end++
      const chunk = text.slice(start, end)
      const part = { name: id + '-' + manifest.parts.length + '.part', length: chunk.length, hash: checksum(chunk) }
      let exists = false
      if (files) {
        try { files.fs.accessSync(files.root + '/' + part.name); exists = true } catch (_) {}
      } else exists = wx.getStorageSync(partKey(part.name)) !== undefined && wx.getStorageSync(partKey(part.name)) !== ''
      if (exists) throw new Error('storage generation collision')
      manifest.parts.push(part)
      if (files) files.fs.writeFileSync(files.root + '/' + part.name, chunk, 'utf8')
      else wx.setStorageSync(partKey(part.name), chunk)
      start = end
    }
    // Publish a single index only after every immutable part is durable through
    // the platform API. Any failed part/index write leaves the old index intact.
    wx.setStorageSync(key, manifest)
    remember(key, id, text)
    discardParts(old, key)
    return value
  } catch (error) {
    // If setStorageSync reported a failure after committing, preserve the new
    // parts rather than deleting the value its index might already reference.
    let current
    try { current = wx.getStorageSync(key) } catch (_) {}
    // Some storage implementations can commit before reporting an error. Treat
    // that as success only after verifying the complete published value.
    if (text !== undefined && (manifest ? current?.generation === manifest.generation : current !== undefined)) {
      try {
        if (JSON.stringify(read(key)) === text) {
          discardParts(old, key)
          return value
        }
      } catch (_) {}
    }
    if (manifest && current?.generation !== manifest.generation && current !== undefined) discardParts(manifest, key)
    if (error.code && error.code.startsWith('LOCAL_STORAGE_')) throw error
    throw storageError('LOCAL_STORAGE_WRITE_FAILED', '本机保存未获确认，可恢复的数据已保留；请检查存储空间后重试', error)
  }
}
module.exports = { read, write, __test: { checksum, isManifest, clearMemory: () => { memory.clear(); memorySize = 0 } } }
