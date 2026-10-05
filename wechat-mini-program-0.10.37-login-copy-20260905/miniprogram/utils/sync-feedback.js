// Upload acknowledgement and incoming history are independent facts. Never
// infer a peer receipt from a successful request or a currently healthy route.
function describe(result = {}, options = {}) {
  const transport = options.transport || result.transport || {}
  const queue = Array.isArray(options.queue) ? options.queue : null
  const blocked = queue ? queue.filter((item) => item.status === 'blocked') : []
  const pending = queue ? queue.length : Math.max(Number(result.flush?.remaining || 0), Number(transport.pendingLocal || 0))
  const history = result.history || options.history || {}
  const error = options.error || result.receiveError || history.error
  const offline = transport.mode === 'local'
  if (error && String(error.code || '').startsWith('LOCAL_STORAGE_')) {
    return { message: error.message || '本机保存未完成，请释放空间后重试', tone: 'error', offline, pending }
  }
  const messages = []
  let tone = 'idle'
  if (blocked.length) {
    messages.push(`${blocked.length} 项上传需要处理 · ${blocked[0].lastError || '请检查账号权限或记录冲突后重试'}`)
    tone = 'error'
  }
  const waiting = pending - blocked.length
  if (waiting > 0) {
    messages.push(`已保存在手机 · ${waiting} 项等待上传`)
    if (tone !== 'error') tone = offline ? 'offline' : 'syncing'
  } else if (!blocked.length && Number(result.flush?.sent || 0) > 0) {
    messages.push(transport.mode === 'home' ? '家庭服务器已确认保存，云端尚未确认' : transport.mode === 'cloud' ? '云端已确认保存' : '本机操作已处理，云端尚未确认')
  }
  if (error) {
    messages.push(history.error ? '历史接收中断，可点击同步继续' : '同步未完成')
    if (error.message) messages.push(error.message)
    if (tone !== 'error') tone = offline ? 'offline' : 'error'
  } else if (history.pending) {
    messages.push('历史仍在接收，已收到的内容可以查看')
    if (tone !== 'error') tone = offline ? 'offline' : 'syncing'
  } else if (result.remoteFresh === true) {
    messages.push(transport.mode === 'home' ? '本次家庭服务器内容已接收，云端尚未确认' : '本次云端内容已接收')
    if (!pending) tone = transport.mode === 'home' ? 'syncing' : 'ok'
  } else {
    messages.push('正在显示手机内容，云端接收尚未确认')
    if (offline && tone === 'idle') tone = 'offline'
  }
  return { message: messages.join(' · '), tone, offline, pending }
}

function fromCache(cache, transport, result = {}, error = null) {
  try {
    const progressKey = transport?.mode === 'home' ? cache.KEYS.homeHistoryTransfer : cache.KEYS.historyTransfer
    const progress = progressKey ? cache.read(progressKey, null) : null
    const history = progress ? { pending: progress.protocol === 2 ? progress.phase !== 'idle' : progress.complete === false, error: progress.error } : {}
    const queue = [...cache.read(cache.KEYS.queue, []),
      ...(cache.KEYS.mirrorQueue ? cache.read(cache.KEYS.mirrorQueue, []) : [])]
    return describe(result || {}, { transport, history, queue, error })
  } catch (failure) {
    return describe({}, { transport, error: failure })
  }
}

module.exports = { describe, fromCache }
