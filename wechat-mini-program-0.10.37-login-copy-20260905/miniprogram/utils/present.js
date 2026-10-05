const { shanghaiParts } = require('./date')

function clock(minutes) {
  const value = Math.max(0, Number(minutes || 0))
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

function ownerLabel(owner) {
  return owner === 'ai' ? 'AI 准备' : owner === 'both' ? '共同完成' : '我来完成'
}

function sessionView(item) {
  const isFixed = Boolean(item.fixed || item.scheduleType === 'event')
  return {
    ...item,
    kind: 'session',
    timeLabel: item.startMinutes >= 0 && item.durationMinutes
      ? `${clock(item.startMinutes)}–${clock(item.startMinutes + item.durationMinutes)}`
      : '待安排',
    ownerLabel: ownerLabel(item.owner),
    typeLabel: isFixed ? '固定活动' : '长期主线',
    isFixed,
    isOpen: item.status === 'planned' || (item.status === 'postponed' && item.deferredTo === 'later_today')
  }
}

function dayLabel(key) {
  const date = new Date(`${key}T12:00:00+08:00`)
  return Number.isNaN(date.getTime()) ? key : `${date.getMonth() + 1}月${date.getDate()}日`
}

function todayMeta() {
  const today = shanghaiParts()
  return { ...today, headline: `${today.fullDateLabel} ${today.weekday}` }
}

module.exports = { clock, ownerLabel, sessionView, dayLabel, todayMeta }
