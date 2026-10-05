function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
}

function monthKey(value) {
  return validDateKey(value) ? String(value).slice(0, 7) : /^\d{4}-\d{2}$/.test(String(value || '')) ? String(value) : ''
}

function shiftMonth(value, offset) {
  const safe = monthKey(value)
  if (!safe) return ''
  const [year, month] = safe.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1 + Number(offset || 0), 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthLabel(value) {
  const safe = monthKey(value)
  if (!safe) return ''
  const [year, month] = safe.split('-').map(Number)
  return `${year}年${month}月`
}

function buildCalendarCells(value, availableDates = [], selectedDate = '') {
  const safe = monthKey(value)
  if (!safe) return []
  const [year, month] = safe.split('-').map(Number)
  const available = new Set(availableDates)
  const leading = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells = Array.from({ length: leading }, (_, index) => ({
    key: `empty-${safe}-${index}`,
    empty: true,
    date: '',
    day: ''
  }))
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${safe}-${String(day).padStart(2, '0')}`
    const enabled = available.has(date)
    cells.push({
      key: date,
      empty: false,
      date,
      day,
      enabled,
      selected: enabled && selectedDate === date
    })
  }
  return cells
}

function completionDate(row = {}) {
  if (validDateKey(row.completedDate)) return row.completedDate
  const timestamp = Date.parse(row.completedAt)
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function buildCompletionView(rows = [], selectedDate = '', requestedMonth = '', todayDate = '') {
  const history = [...rows].sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')))
  const dates = [...new Set(history.map(completionDate).filter(validDateKey))].sort()
  const selected = dates.includes(selectedDate) ? selectedDate : ''
  const firstMonth = monthKey(dates[0])
  const lastMonth = monthKey(dates[dates.length - 1])
  let visibleMonth = monthKey(requestedMonth) || lastMonth || monthKey(todayDate)
  if (firstMonth && visibleMonth < firstMonth) visibleMonth = firstMonth
  if (lastMonth && visibleMonth > lastMonth) visibleMonth = lastMonth
  return {
    completionHistory: history,
    completionDates: dates,
    completedQueryDate: selected,
    completedResults: selected ? history.filter((row) => completionDate(row) === selected) : history,
    completionMonth: visibleMonth,
    completionMonthLabel: monthLabel(visibleMonth),
    completionCalendar: buildCalendarCells(visibleMonth, dates, selected),
    completionCanPrevious: Boolean(firstMonth && visibleMonth > firstMonth),
    completionCanNext: Boolean(lastMonth && visibleMonth < lastMonth)
  }
}

module.exports = {
  buildCalendarCells,
  buildCompletionView,
  completionDate,
  monthKey,
  monthLabel,
  shiftMonth,
  validDateKey
}
