function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

export function describeDesktopCloudSync(result = {}, { initial = false } = {}) {
  const pushed = count(result.pushed)
  const pulled = count(result.pulled)
  const conflicts = count(result.conflicts)
  const parts = []
  parts.push(pushed ? `云端已确认保存 ${pushed} 项` : '没有新的上传')
  parts.push(pulled ? `电脑已接收 ${pulled} 项云端变化` : '没有新的云端变化')
  if (result.uploadPending) parts.push('仍有本机内容等待云端确认')
  if (result.receivePending) parts.push('仍有云端变化等待电脑接收')
  if (conflicts) parts.push(`${conflicts} 项存在冲突，需要处理`)
  const prefix = initial ? '连接已建立' : '同步请求已处理'
  return `${prefix}：${parts.join('；')}。`
}

