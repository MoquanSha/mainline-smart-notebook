function parseHomeConnectionText(value) {
  const text = String(value || '').trim()
  const urlMatch = text.match(/https:\/\/[^\s]+/i)
  const labeledToken = text.match(/(?:设备连接凭证|连接凭证|token)[：:]\s*([A-Za-z0-9_-]{32,})/i)
  const fallbackToken = text.match(/(?:^|\s)([A-Za-z0-9_-]{40,})(?:\s|$)/)

  return {
    serverBaseUrl: urlMatch ? urlMatch[0].replace(/[，,；;。]+$/, '').replace(/\/$/, '') : '',
    token: labeledToken ? labeledToken[1] : (fallbackToken ? fallbackToken[1] : '')
  }
}

module.exports = { parseHomeConnectionText }
