'use strict'

function cleanText(value, max = 5000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function dayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  if (!Number.isFinite(value.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value)
}

function clockFromMinutes(value) {
  const minutes = ((Number(value) % 1440) + 1440) % 1440
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

function timeToMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):([0-5]\d)$/)
  if (!match) return null
  const result = Number(match[1]) * 60 + Number(match[2])
  return result >= 0 && result < 1440 ? result : null
}

function chineseNumber(value) {
  const text = cleanText(value, 8)
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  if (Object.prototype.hasOwnProperty.call(map, text)) return map[text]
  if (text.length === 2 && map[text[0]] !== undefined && map[text[1]] !== undefined) {
    if (text[0] === '十') return 10 + map[text[1]]
    if (text[1] === '十') return map[text[0]] * 10
    return (map[text[0]] + map[text[1]]) / 2
  }
  return 0
}

function parseDate(text, base = new Date()) {
  const iso = cleanText(text).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`
  const md = cleanText(text).match(/(\d{1,2})月(\d{1,2})日/)
  if (md) return `${base.getFullYear()}-${pad(md[1])}-${pad(md[2])}`
  if (/明天|明晚/.test(text)) return dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 12))
  return dayKey(base)
}

function parseClock(text) {
  const source = cleanText(text)
  const colon = source.match(/(?:^|\D)([01]?\d|2[0-3])[:：]([0-5]\d)(?:\D|$)/)
  if (colon) {
    const minutes = Number(colon[1]) * 60 + Number(colon[2])
    return { time: clockFromMinutes(minutes), minutes }
  }
  const match = source.match(/(凌晨|早上|上午|中午|下午|晚上|今晚)?\s*([一二两三四五六七八九十]+|\d{1,2})\s*点\s*(半|一刻|三刻|([0-5]?\d)\s*分?)?/)
  if (!match) return null
  const period = match[1] || (/晚上|今晚/.test(source) ? '晚上' : /下午/.test(source) ? '下午' : '')
  let hour = /^\d+$/.test(match[2]) ? Number(match[2]) : chineseNumber(match[2])
  const minute = match[3] === '半' ? 30 : match[3] === '一刻' ? 15 : match[3] === '三刻' ? 45 : Number(match[4] || 0)
  if (/下午|晚上|今晚/.test(period) && hour < 12) hour += 12
  if (period === '中午' && hour < 11) hour += 12
  if (/凌晨|早上|上午/.test(period) && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  const minutes = hour * 60 + minute
  return { time: clockFromMinutes(minutes), minutes }
}

function parseDuration(text) {
  const match = cleanText(text, 1200).match(/(?:(?:持续|大约|大概|约|差不多|应该(?:也)?要)\s*)?([一二两三四五六七八九十\d]+)\s*(?:到|至|[-~～])?\s*([一二两三四五六七八九十\d]+)?\s*(?:个)?(?:小时|钟头)/)
  if (!match) return null
  const first = chineseNumber(match[1])
  const second = chineseNumber(match[2] || '')
  const hours = second ? (first + second) / 2 : first
  if (!hours || hours > 12) return null
  return { minutes: Math.round(hours * 60), estimated: Boolean(second || /[一二两三四五六七八九十]{2}/.test(match[1])) }
}

function activityName(text) {
  if (/剧本杀/.test(text)) return '剧本杀'
  if (/密室/.test(text)) return '密室'
  if (/桌游/.test(text)) return '桌游'
  if (/KTV|唱K|唱歌/i.test(text)) return 'KTV'
  if (/聚餐|吃饭|晚饭|午饭/.test(text)) return '吃饭'
  return '固定安排'
}

function eventAction(event, captureId) {
  return {
    type: 'calendar_event',
    title: event.title,
    detail: event.detail,
    taskId: '',
    project: '个人安排',
    owner: 'me',
    priority: 'high',
    importance: 'important',
    urgency: 'urgent',
    progress: 0,
    dueDate: event.eventDate,
    startDate: event.eventDate,
    estimatedMinutes: event.eventDurationMinutes,
    nextAction: event.nextAction,
    steps: [],
    why: '原文包含明确的活动时间，应作为当天固定安排保留。',
    confidence: event.needsConfirmation ? 0.78 : 0.98,
    needsConfirmation: Boolean(event.needsConfirmation),
    uncertaintyReason: event.uncertaintyReason || '',
    eventDate: event.eventDate,
    eventTime: event.eventTime,
    eventEndTime: event.eventEndTime || '',
    departureTime: event.departureTime || '',
    preparationMinutes: event.preparationMinutes || 0,
    eventDurationMinutes: event.eventDurationMinutes || 0,
    captureIds: captureId ? [captureId] : []
  }
}

function parseSequentialChain(text, base = new Date(), captureId = '') {
  const source = cleanText(text, 1600)
  const start = parseClock(source)
  const duration = parseDuration(source)
  if (!start || !duration || !/(之后|然后|接着|吃完)/.test(source)) return []
  let startMinutes = start.minutes
  if (startMinutes < 7 * 60 && /晚饭|吃完|KTV|唱K|晚上/i.test(source)) startMinutes += 12 * 60
  const date = parseDate(source, base)
  const main = activityName(source)
  let cursor = startMinutes + duration.minutes
  const events = [eventAction({
    title: `${clockFromMinutes(startMinutes)} ${main}`,
    detail: `${main}从 ${clockFromMinutes(startMinutes)} 开始，按原文时长暂排。`,
    eventDate: date,
    eventTime: clockFromMinutes(startMinutes),
    eventEndTime: clockFromMinutes(cursor),
    eventDurationMinutes: duration.minutes,
    nextAction: `${clockFromMinutes(startMinutes)} 开始${main}`,
    needsConfirmation: duration.estimated,
    uncertaintyReason: duration.estimated ? '原文使用约数，已按中间值暂排，请确认实际结束时间。' : ''
  }, captureId)]
  if (/聚餐|吃饭|晚饭|午饭/.test(source)) {
    events.push(eventAction({
      title: `${clockFromMinutes(cursor)} 吃饭`,
      detail: `安排在${main}之后，暂按 1 小时预留。`,
      eventDate: date,
      eventTime: clockFromMinutes(cursor),
      eventEndTime: clockFromMinutes(cursor + 60),
      eventDurationMinutes: 60,
      nextAction: `${clockFromMinutes(cursor)} 开始吃饭`,
      needsConfirmation: true,
      uncertaintyReason: '用餐时长未明确，暂按 1 小时排入。'
    }, captureId))
    cursor += 60
  }
  if (/KTV|唱K|唱歌/i.test(source)) {
    const mention = source.search(/KTV|唱K|唱歌/i)
    const ktvDuration = mention >= 0 ? parseDuration(source.slice(mention)) : null
    const minutes = ktvDuration ? ktvDuration.minutes : 120
    events.push(eventAction({
      title: `${clockFromMinutes(cursor)} KTV`,
      detail: `安排在前一项活动后，暂按 ${minutes / 60} 小时预留。`,
      eventDate: date,
      eventTime: clockFromMinutes(cursor),
      eventEndTime: clockFromMinutes(cursor + minutes),
      eventDurationMinutes: minutes,
      nextAction: `${clockFromMinutes(cursor)} 前往 KTV`,
      needsConfirmation: true,
      uncertaintyReason: ktvDuration ? 'KTV 使用原文约数时长，请确认实际结束时间。' : 'KTV 时长未明确，暂按 2 小时排入。'
    }, captureId))
  }
  return events.length > 1 ? events : []
}

function conciseTitle(value) {
  return cleanText(value, 160)
    .replace(/^(我(?:今天|最近|这周|之后)?(?:要|想|得|会|准备|需要)|就是|然后|还有|目前|大概|可能|应该|请你)\s*/u, '')
    .replace(/[，,。；;！!？?].*$/u, '')
    .slice(0, 32) || '新的待办'
}

const personalActionPattern = /(?:我|本人|自己)(?:今天|明天|这周|之后|接下来|最近)?(?:要|得|需要|计划|打算|准备|会|必须|应该)(?:亲自|自己)?|(?:报名|提交|联系|发送|阅读|学习|核对|整理|完成|复习|练习|参加)/u
const questionPattern = /[？?]|(?:怎么|如何|为什么|是什么|能不能|可不可以|有没有|是否可以)/u
const productInstructionPattern = /(?:网页|页面|网站|按钮|界面|UI|代码|接口|部署|版本|小程序|软件|提示词|时间线|排版|功能|测试|同步)/iu
const delegatedInstructionPattern = /(?:你|Codex|AI)(?:可以|能|先|继续|帮我|给我|去|来)?(?:改|做|加|写|实现|部署|检查|测试|隐藏|删除|更新)/iu
const cancelledPattern = /(?:不用|不需要|取消|先不|暂时不|不要再|已经放弃|移除)/u

function inferIntent(action, capture = {}) {
  const text = cleanText(`${action.title || ''} ${action.detail || ''} ${capture.content || ''}`, 4000)
  if (cancelledPattern.test(text)) return 'cancelled'
  if (questionPattern.test(text) && !personalActionPattern.test(text)) return 'question'
  if (productInstructionPattern.test(text) && delegatedInstructionPattern.test(text) && !personalActionPattern.test(text)) return 'product_instruction'
  if (action.type === 'calendar_event') return 'fixed_event'
  if (action.type === 'task_update') return Number(action.progress) >= 100 ? 'completed_result' : 'explicit_update'
  if (action.type === 'task_create') return 'explicit_action'
  if (action.type === 'achievement') return 'completed_result'
  if (action.type === 'decision') return 'decision'
  if (action.type === 'blocker') return 'blocker'
  return 'background'
}

function reviewDecision(action, capture = {}) {
  const text = cleanText(`${action.title || ''} ${action.detail || ''} ${capture.content || ''}`, 4000)
  const intent = action.userIntent || inferIntent(action, capture)
  let usefulness = Number.isFinite(Number(action.usefulness))
    ? Math.max(0, Math.min(1, Number(action.usefulness)))
    : ['task_create', 'task_update'].includes(action.type) ? 0.72 : action.type === 'calendar_event' ? 0.82 : 0.55
  if (personalActionPattern.test(text)) usefulness += 0.12
  if (action.dueDate || action.eventDate || action.eventTime) usefulness += 0.08
  if (action.nextAction && cleanText(action.nextAction).length >= 6) usefulness += 0.05
  if (questionPattern.test(text) && !personalActionPattern.test(text)) usefulness -= 0.45
  if (capture.source === 'codex' && productInstructionPattern.test(text) && delegatedInstructionPattern.test(text) && !personalActionPattern.test(text)) usefulness -= 0.6
  usefulness = Math.max(0, Math.min(1, usefulness))

  let handling = ['ask_user', 'auto_apply', 'record_only', 'ignore'].includes(action.suggestedHandling) ? action.suggestedHandling : ''
  let filterReason = ''
  if (['question', 'product_instruction', 'cancelled'].includes(intent)) {
    handling = 'ignore'
    filterReason = intent === 'question' ? '这是问题，不是用户承诺执行的任务' : intent === 'product_instruction' ? '这是给 AI 或产品的工作指令，不是个人任务' : '原文表达了取消或暂不处理'
  } else if (['decision', 'achievement', 'blocker', 'note'].includes(action.type)) {
    handling = usefulness >= 0.4 ? 'record_only' : 'ignore'
    filterReason = handling === 'ignore' ? '记录价值不足，原文已保留' : '明确事实自动进入历史，不需要审批'
  } else if (action.type === 'calendar_event') {
    const exact = Boolean(action.eventDate && action.eventTime) && !action.needsConfirmation && Number(action.confidence) >= 0.88
    handling = exact ? 'auto_apply' : usefulness >= 0.65 ? 'ask_user' : 'ignore'
    if (handling === 'ignore') filterReason = '活动信息不足以形成可靠安排'
  } else if (['task_create', 'task_update'].includes(action.type)) {
    handling = usefulness >= 0.65 && Number(action.confidence) >= 0.5 ? 'ask_user' : 'ignore'
    if (handling === 'ignore') filterReason = '不像值得写入正式任务系统的明确行动'
  } else {
    handling = 'ignore'
    filterReason = '未识别为可用的工作信息'
  }
  return {
    userIntent: intent,
    suggestedHandling: handling,
    usefulness,
    needsConfirmation: handling === 'ask_user',
    confirmationQuestion: handling === 'ask_user' ? cleanText(action.confirmationQuestion || action.uncertaintyReason || '是否把这项高价值变化写入正式任务？', 240) : '',
    filterReason
  }
}

function localOrganize(capture, tasks = []) {
  const chain = parseSequentialChain(capture.content, new Date(capture.occurredAt || Date.now()), capture.id)
  if (chain.length) return { summary: `已识别 ${chain.length} 项连续时间安排。`, actions: chain }
  const chunks = String(capture.content || '').split(/\r?\n+|[。！？；]+/).map((item) => item.trim()).filter((item) => item.length >= 4).slice(0, 6)
  const actions = chunks.flatMap((chunk) => {
    const matched = tasks.find((task) => chunk.includes(String(task.title || '').slice(0, 6)))
    const done = /已经完成|做完了|已完成|完成了/.test(chunk)
    const blocked = /卡住|阻塞|做不了|无法|失败/.test(chunk)
    const decided = /决定|确定|采用|改成|不再/.test(chunk)
    const explicitAction = personalActionPattern.test(chunk) || ['long_term', 'update_task'].includes(capture.intent)
    if ((questionPattern.test(chunk) || (productInstructionPattern.test(chunk) && delegatedInstructionPattern.test(chunk))) && !explicitAction) return []
    if (cancelledPattern.test(chunk) && !matched) return []
    const title = matched ? matched.title : conciseTitle(chunk)
    const type = matched && !blocked ? 'task_update' : blocked ? 'blocker' : done ? 'achievement' : decided ? 'decision' : explicitAction ? 'task_create' : 'note'
    const action = {
      type,
      title,
      detail: chunk,
      taskId: matched ? matched.id : '',
      project: matched ? matched.project : '未分类',
      owner: /AI/i.test(chunk) && /(我|自己)/.test(chunk) ? 'both' : /交给\s*AI|让\s*AI|AI\s*(准备|整理|搜索|生成)/i.test(chunk) ? 'ai' : 'me',
      priority: /必须|重要|优先|截止/.test(chunk) ? 'high' : 'normal',
      importance: /重要|申请|截止|学习/.test(chunk) ? 'important' : 'not_important',
      urgency: /今天|明天|截止|马上/.test(chunk) ? 'urgent' : 'not_urgent',
      progress: done ? 100 : matched ? Number(matched.progress || 0) : 0,
      dueDate: '', startDate: '', estimatedMinutes: 30,
      nextAction: blocked ? '先明确卡住的具体一步' : title,
      steps: matched ? [] : [{ title, owner: 'me', startDate: '', dueDate: '', estimatedMinutes: 30 }],
      why: matched ? '这段输入更新了已有任务。' : explicitAction ? '这是用户本人需要推进的可执行事项。' : '这是值得保留的上下文记录。',
      confidence: matched || explicitAction ? 0.72 : 0.82,
      needsConfirmation: matched || explicitAction,
      uncertaintyReason: matched || explicitAction ? '由本地规则整理，请确认标题、负责人和任务归属。' : '',
      eventDate: '', eventTime: '', eventEndTime: '', departureTime: '', preparationMinutes: 0, eventDurationMinutes: 0,
      captureIds: [capture.id]
    }
    return [{ ...action, ...reviewDecision(action, capture) }]
  })
  const reviewCount = actions.filter((item) => item.suggestedHandling === 'ask_user').length
  return { summary: actions.length ? `已整理有效内容；${reviewCount ? `${reviewCount} 项重要变化需要确认。` : '没有需要你确认的变化。'}` : '已保存原文，暂未识别出值得进入任务系统的内容。', actions }
}

function chooseToday(tasks, dailyTasks, sessions, now = new Date(), capacityMinutes = 360) {
  const date = dayKey(now)
  const cutoff = now.getHours() * 60 + now.getMinutes()
  const protectedSessions = (sessions || []).filter((item) => item.fixed || item.status !== 'planned' || item.startMinutes < cutoff)
  const excluded = new Set(protectedSessions
    .filter((item) => !(item.status === 'postponed' && item.deferredTo === 'later_today'))
    .map((item) => item.taskId)
    .filter(Boolean))
  const priorityScore = (task) => {
    const due = task.dueDate ? new Date(`${task.dueDate}T23:59:59`).getTime() : Infinity
    const daysLeft = Number.isFinite(due) ? Math.ceil((due - now.getTime()) / 86400000) : Infinity
    return Number(task.planningScore || 0) + (task.owner === 'me' ? 100 : 60) + (task.importance === 'important' ? 40 : 0) +
      (task.urgency === 'urgent' ? 30 : 0) + (task.priority === 'high' ? 20 : 0) +
      (daysLeft <= 1 ? 35 : daysLeft <= 7 ? 15 : 0)
  }
  const eligible = (tasks || []).filter((item) => ['active', 'planned', 'verifying'].includes(item.status) && !excluded.has(item.id) && item.owner !== 'ai')
    .sort((a, b) => priorityScore(b) - priorityScore(a) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const resultTasks = []
  const resultSessions = protectedSessions.slice()
  let cursor = Math.max(cutoff, 8 * 60)
  let used = protectedSessions.reduce((sum, item) => sum + Number(item.durationMinutes || 0), 0)
  const findOpenSlot = (from, minutes) => {
    let candidate = Math.ceil(from / 15) * 15
    const occupied = resultSessions
      .filter((item) => item.status !== 'skipped')
      .map((item) => ({ start: Number(item.startMinutes || 0), end: Number(item.startMinutes || 0) + Number(item.durationMinutes || 0) }))
      .sort((a, b) => a.start - b.start)
    for (const block of occupied) {
      if (candidate + minutes <= block.start) break
      if (candidate < block.end && candidate + minutes > block.start) candidate = Math.ceil((block.end + 15) / 15) * 15
    }
    return candidate
  }
  for (const task of eligible.slice(0, 3)) {
    const minutes = Math.min(Math.max(Number(task.estimatedMinutes || 30), 30), 90)
    if (used + minutes > capacityMinutes) break
    const startMinutes = findOpenSlot(cursor, minutes)
    if (startMinutes + minutes > 22 * 60 + 30) continue
    const daily = {
      id: `daily_${date}_${task.id}`,
      date,
      title: task.nextAction || task.title,
      description: task.description || task.why || '',
      source: 'long_term', relatedTaskId: task.id, estimatedMinutes: minutes,
      tier: resultTasks.length ? 'normal' : 'core', priority: task.priority || 'normal', status: 'planned',
      completionCriteria: task.completionCriteria || `完成：${task.nextAction || task.title}`,
      suggestedStartTime: clockFromMinutes(startMinutes), requiresConfirmation: true, sourceCaptureIds: task.sourceCaptureIds || []
    }
    resultTasks.push(daily)
    resultSessions.push({
      id: `session_${date}_${task.id}_${startMinutes}`,
      taskId: task.id, title: daily.title, startMinutes, durationMinutes: minutes,
      owner: task.owner || 'me', status: 'planned', fixed: false, scheduleType: 'flexible', sourceCaptureIds: daily.sourceCaptureIds
    })
    cursor = startMinutes + minutes + 15
    used += minutes
  }
  return { date, dailyTasks: [...(dailyTasks || []).filter((item) => item.status !== 'planned'), ...resultTasks], sessions: resultSessions.sort((a, b) => a.startMinutes - b.startMinutes) }
}

module.exports = {
  cleanText, dayKey, clockFromMinutes, timeToMinutes, parseClock, parseDuration,
  parseSequentialChain, localOrganize, chooseToday, reviewDecision
}
