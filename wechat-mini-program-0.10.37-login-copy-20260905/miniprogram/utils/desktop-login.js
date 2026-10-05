function parseDesktopLoginPayload(value) {
  const input = String(value || '').trim()
  const match = /^mainline-login:v1:(login_[a-f0-9]{32}):([A-Za-z0-9_-]{32,160}):(.{1,240})$/.exec(input)
  if (!match) throw Object.assign(new Error('这不是主线随行笔记的电脑登录二维码'), { code: 'INVALID_LOGIN_QR' })
  let deviceName = 'Windows 电脑'
  try {
    deviceName = decodeURIComponent(match[3]).trim().slice(0, 80) || deviceName
  } catch {
    throw Object.assign(new Error('二维码中的设备名称无效'), { code: 'INVALID_LOGIN_QR' })
  }
  return { sessionId: match[1], qrToken: match[2], deviceName }
}

module.exports = { parseDesktopLoginPayload }
