function statusTier(todo) {
  return todo && todo.status === 'planned' ? 0 : 1
}

function currentShanghaiDateKey(value = Date.now()) {
  const date = new Date(Number(value) + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function pinTier(todo) {
  if (todo && todo.pinned && todo.priorityPinned) return 0
  if (todo && todo.pinned) return 1
  return 2
}

function sortRankValue(todo) {
  const explicit = Number(todo && todo.sortRank)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const created = Date.parse(todo && todo.createdAt || '')
  return Number.isFinite(created) ? created : 0
}

function compareTodayTodos(left, right) {
  if (left && left.status === 'planned' && (!right || right.status !== 'planned')) return -1
  if (right && right.status === 'planned' && (!left || left.status !== 'planned')) return 1

  const tierDelta = pinTier(left) - pinTier(right)
  if (tierDelta) return tierDelta

  const sortRankDelta = sortRankValue(right) - sortRankValue(left)
  if (sortRankDelta) return sortRankDelta

  return String(right && right.createdAt || '').localeCompare(String(left && left.createdAt || ''))
    || String(left && left.id || '').localeCompare(String(right && right.id || ''))
}

function sortTodayTodos(rows = []) {
  return [...rows].sort(compareTodayTodos)
}

function nextSortRank(rows = []) {
  const highest = rows.reduce((maximum, todo) => Math.max(maximum, sortRankValue(todo)), 0)
  return Math.max(Date.now(), highest) + 1
}

function applyOrderedIds(rows = [], orderedIds = []) {
  const planned = rows.filter((todo) => todo && todo.status === 'planned')
  const plannedIds = new Set(planned.map((todo) => todo.id))
  const requested = orderedIds.filter((id, index) => plannedIds.has(id) && orderedIds.indexOf(id) === index)
  const requestedSet = new Set(requested)
  const current = sortTodayTodos(planned)
  const ordered = []

  for (const tier of [0, 1, 2]) {
    const tierIds = new Set(current.filter((todo) => pinTier(todo) === tier).map((todo) => todo.id))
    for (const id of requested) if (tierIds.has(id)) ordered.push(id)
    for (const todo of current) {
      if (pinTier(todo) === tier && !requestedSet.has(todo.id)) ordered.push(todo.id)
    }
  }

  const position = new Map(ordered.map((id, index) => [id, index]))
  const topRank = Math.max(nextSortRank(rows), ordered.length + 1)
  return rows.map((todo) => position.has(todo.id)
    ? { ...todo, sortRank: topRank - position.get(todo.id) }
    : todo)
}

function rebaseOrderedIds(rows = [], orderedIds = []) {
  const current = sortTodayTodos(rows.filter((todo) => todo && todo.status === 'planned'))
  const currentIds = new Set(current.map((todo) => todo.id))
  const requested = orderedIds.filter((id, index) => currentIds.has(id) && orderedIds.indexOf(id) === index)
  const rebased = []

  for (const tier of [0, 1, 2]) {
    const currentTier = current.filter((todo) => pinTier(todo) === tier).map((todo) => todo.id)
    const tierIds = new Set(currentTier)
    const requestedTier = requested.filter((id) => tierIds.has(id))
    const requestedSet = new Set(requestedTier)
    let cursor = 0
    for (const id of currentTier) {
      rebased.push(requestedSet.has(id) ? requestedTier[cursor++] : id)
    }
  }

  return rebased
}

function samePinTier(left, right) {
  return pinTier(left) === pinTier(right)
}

const TODO_ACTIONS = new Set([
  'todayTodo.add',
  'todayTodo.complete',
  'todayTodo.reopen',
  'todayTodo.defer',
  'todayTodo.delete',
  'todayTodo.setPin',
  'todayTodo.reorder',
  'todayTodo.commentAdd',
  'todayTodo.commentDelete'
])

function rowsOf(bundle) {
  return Array.isArray(bundle && bundle.todos) ? bundle.todos : []
}

function todoById(rows, id) {
  return (rows || []).find((item) => item && item.id === id)
}

function cloneQueueItem(item, payload) {
  return { ...item, payload: { ...(item.payload || {}), ...payload } }
}

function rebaseTodoQueueItem(item, latestRows) {
  if (!item || !TODO_ACTIONS.has(item.action)) return { item, satisfied: false, discarded: false }
  const payload = item.payload || {}

  if (item.action === 'todayTodo.add') {
    const ids = (payload.clientItems || []).map((entry) => entry && entry.id).filter(Boolean)
    const existingIds = new Set((latestRows || []).map((entry) => entry && entry.id))
    if (ids.length && ids.every((id) => existingIds.has(id))) return { item, satisfied: true, discarded: false }
    return { item, satisfied: false, discarded: false }
  }

  if (item.action === 'todayTodo.reorder') {
    const planned = sortTodayTodos((latestRows || []).filter((todo) => todo.status === 'planned'))
    const orderedIds = rebaseOrderedIds(planned, payload.orderedIds || [])
    if (orderedIds.length < 2) return { item, satisfied: true, discarded: false }
    if (planned.map((todo) => todo.id).join('|') === orderedIds.join('|')) {
      return { item, satisfied: true, discarded: false }
    }
    return {
      item: cloneQueueItem(item, {
        orderedIds,
        versions: Object.fromEntries(planned.map((todo) => [todo.id, todo.version]))
      }),
      satisfied: false,
      discarded: false
    }
  }

  const latest = todoById(latestRows, payload.todoId)
  if (!latest) return { item, satisfied: false, discarded: false }
  if (latest.deletedAt || latest.trashedAt || latest.status === 'removed') {
    // A comment contains user text. Keep it until the server can return an
    // explicit blocked result; never discard that text as an obsolete toggle.
    if (item.action === 'todayTodo.commentAdd') return { item, satisfied: false, discarded: false }
    return { item, satisfied: item.action === 'todayTodo.delete', discarded: item.action !== 'todayTodo.delete' }
  }

  if (item.action === 'todayTodo.complete') {
    if (latest.status === 'done') return { item, satisfied: true, discarded: false }
    if (latest.status !== 'planned') return { item, satisfied: false, discarded: true }
  }
  if (item.action === 'todayTodo.reopen') {
    if (latest.status === 'planned') return { item, satisfied: true, discarded: false }
    if (latest.status !== 'done') return { item, satisfied: false, discarded: true }
  }
  if (item.action === 'todayTodo.defer') {
    if (latest.status === 'postponed' && latest.deferredTo === 'tomorrow') return { item, satisfied: true, discarded: false }
    if (latest.status !== 'planned') return { item, satisfied: false, discarded: true }
  }
  if (item.action === 'todayTodo.delete') {
    if (latest.status === 'removed' || latest.deletedAt || latest.trashedAt) return { item, satisfied: true, discarded: false }
  }
  if (item.action === 'todayTodo.setPin') {
    if (latest.status !== 'planned') return { item, satisfied: false, discarded: true }
    const expectedPriorityPin = Boolean(payload.pinned)
      && latest.priority === 'high'
      && payload.autoPinHighPriorityTodos !== false
    if (Boolean(latest.pinned) === Boolean(payload.pinned) && Boolean(latest.priorityPinned) === expectedPriorityPin) {
      return { item, satisfied: true, discarded: false }
    }
  }
  if (item.action === 'todayTodo.commentDelete') {
    const comment = (latest.comments || []).find((entry) => entry.id === payload.commentId)
    if (!comment || comment.deletedAt) return { item, satisfied: true, discarded: false }
  }

  return {
    item: cloneQueueItem(item, { baseVersion: latest.version }),
    satisfied: false,
    discarded: false
  }
}

function overlayQueuedTodoIntents(bundle, queue) {
  const output = {
    ...(bundle || {}),
    todos: sortTodayTodos(rowsOf(bundle).map((todo) => ({ ...todo }))),
    scheduled: (bundle && bundle.scheduled || []).map((todo) => ({ ...todo }))
      .sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')) || String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
  }
  for (const queued of queue || []) {
    if (!queued || !TODO_ACTIONS.has(queued.action)) continue
    const payload = queued.payload || {}

    if (queued.action === 'todayTodo.add') {
      const parts = String(payload.content || '').replace(/\r\n?/g, '\n').split(/\n+|[；;]+/).map((item) => item.trim()).filter(Boolean)
      const titles = parts.length ? parts : [String(payload.content || '').trim()].filter(Boolean)
      const firstRank = nextSortRank(output.todos) + Math.max(0, Math.min(titles.length, 30) - 1)
      titles.slice(0, 30).forEach((title, index) => {
        const id = payload.clientItems && payload.clientItems[index] && payload.clientItems[index].id
        if (!id || output.todos.some((todo) => todo.id === id) || output.scheduled.some((todo) => todo.id === id)) return
        const optimistic = {
          id, entryKind: 'today_todo', date: payload.date || '', title, rawInput: title,
          source: payload.date > currentShanghaiDateKey() ? 'scheduled' : 'manual', priority: 'normal', status: 'planned', pinned: false,
          priorityPinned: false, sortRank: firstRank - index,
          comments: [], version: 1, createdAt: queued.createdAt || new Date().toISOString(),
          pending: true
        }
        if (optimistic.date > currentShanghaiDateKey()) output.scheduled.push(optimistic)
        else output.todos.unshift(optimistic)
      })
      output.scheduled.sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')) || String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      continue
    }
    const index = output.todos.findIndex((todo) => todo.id === payload.todoId)

    if (queued.action === 'todayTodo.reorder') {
      output.todos = sortTodayTodos(applyOrderedIds(output.todos, payload.orderedIds || []))
      continue
    }
    if (index < 0) continue

    const current = output.todos[index]
    if (current.deletedAt || current.trashedAt || current.status === 'removed') continue
    if (queued.action === 'todayTodo.complete') {
      output.todos[index] = { ...current, status: 'done', completedAt: queued.createdAt || new Date().toISOString(), pinned: false, priorityPinned: false, pinnedAt: '' }
    } else if (queued.action === 'todayTodo.reopen') {
      output.todos[index] = { ...current, status: 'planned', completedAt: '', sortRank: nextSortRank(output.todos) }
    } else if (queued.action === 'todayTodo.defer') {
      output.todos[index] = { ...current, status: 'postponed', deferredTo: 'tomorrow', pinned: false, priorityPinned: false, pinnedAt: '' }
    } else if (queued.action === 'todayTodo.delete') {
      output.todos[index] = { ...current, status: 'removed', pinned: false, priorityPinned: false, pinnedAt: '' }
    } else if (queued.action === 'todayTodo.setPin') {
      const willPin = Boolean(payload.pinned)
      output.todos[index] = {
        ...current,
        pinned: willPin,
        priorityPinned: willPin && current.priority === 'high' && payload.autoPinHighPriorityTodos !== false,
        pinnedAt: willPin ? (queued.createdAt || new Date().toISOString()) : '',
        sortRank: nextSortRank(output.todos)
      }
    } else if (queued.action === 'todayTodo.commentAdd') {
      const comments = (current.comments || []).map((comment) => ({ ...comment }))
      if (!comments.some((comment) => comment.id === payload.commentId)) {
        comments.push({
          id: payload.commentId,
          content: payload.content || '',
          rawContent: payload.content || '',
          createdAt: queued.createdAt || new Date().toISOString(),
          pending: true,
          attachments: (payload.attachments || []).map((attachment) => ({
            ...attachment,
            previewUrl: attachment.previewUrl || attachment.localFilePath || attachment.fileID || ''
          }))
        })
      }
      output.todos[index] = { ...current, comments }
    } else if (queued.action === 'todayTodo.commentDelete') {
      output.todos[index] = {
        ...current,
        comments: (current.comments || []).filter((comment) => comment.id !== payload.commentId)
      }
    }
  }
  output.todos = sortTodayTodos(output.todos)
  return output
}

module.exports = {
  TODO_ACTIONS,
  statusTier,
  pinTier,
  sortRankValue,
  compareTodayTodos,
  sortTodayTodos,
  nextSortRank,
  applyOrderedIds,
  rebaseOrderedIds,
  samePinTier,
  rebaseTodoQueueItem,
  overlayQueuedTodoIntents
}
