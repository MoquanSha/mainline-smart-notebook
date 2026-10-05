const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function shanghaiParts(value = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value || Date.now())
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const weekdayIndex = date.getUTCDay()
  return {
    year,
    month,
    day,
    weekday: WEEKDAYS[weekdayIndex],
    todayKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    dateLabel: `${month}月${day}日`,
    fullDateLabel: `${year}年${month}月${day}日`
  }
}

module.exports = { shanghaiParts }
