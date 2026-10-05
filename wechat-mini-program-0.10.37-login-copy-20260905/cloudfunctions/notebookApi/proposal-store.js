'use strict'

const crypto = require('crypto')
const ledger = require('./operation-ledger')
const dataOf = (value) => Array.isArray(value?.data) ? value.data[0] : value?.data
const deleted = (row) => row && (row.deletedAt || row.trashedAt || row.permanentlyPurgedAt)
const fail = (code, message, latest) => Object.assign(new Error(message), { code, retryable: false, ...(latest ? { latest } : {}) })
const stableId = (owner, proposal, kind) => `${kind}_proposal_${crypto.createHash('sha256').update(JSON.stringify([owner, proposal, kind])).digest('hex').slice(0, 36)}`
const planningJobId = (owner) => stableId(owner, 'planning', 'job')

function createProposalStore({ db, now, dayKey, scopedDayId, timeToMinutes, entityMeta, assertRecordCapacity }) {
  async function apply(owner, payload, operation) {
    const id = String(payload.id || '')
    if (!id) throw fail('VALIDATION', '请选择要采用的建议')
    return db.runTransaction(async (tx) => {
      const replay = await ledger.read(tx, operation)
      if (replay) return { data: replay.result, replayed: true }
      // Reserve ten operations for the receipt and sequence adapter. Never split
      // one proposal into partial commits to evade the native transaction limit.
      let operations = 0
      const seen = new Map()
      const count = () => { if (++operations > 90) throw fail('PROPOSAL_CAPACITY', '这条建议涉及的记录过多，尚未采用，请拆分后重试') }
      const get = async (collection, key) => {
        const name = collection + '/' + key
        if (!seen.has(name)) { count(); seen.set(name, dataOf(await tx.collection(collection).doc(key).get()) || null) }
        return seen.get(name)
      }
      const put = async (collection, key, document) => {
        const { _id, ...fields } = document
        const value = JSON.parse(JSON.stringify(fields))
        assertRecordCapacity(value); count()
        await tx.collection(collection).doc(key).set(value); seen.set(collection + '/' + key, value)
        return value
      }
      const owned = (row, label) => {
        if (!row) throw fail('NOT_FOUND', `${label}不存在`)
        if (row.ownerOpenId !== owner) throw fail('FORBIDDEN', `${label}不属于当前工作区`)
        if (deleted(row)) throw fail('RECORD_DELETED', `${label}已删除，不能由旧建议恢复`)
        return row
      }
      const proposal = owned(await get('proposals', id), '建议')
      if (proposal.status !== 'pending') {
        if (proposal.status !== 'applied') throw fail('CONFLICT', '这条建议已被忽略或推迟，请查看最新状态后重新确认', proposal)
        const result = { proposal, entity: null, alreadyHandled: true }
        await ledger.write(tx, operation, result)
        return { data: result, replayed: false }
      }
      if (payload.baseVersion !== undefined && (!Number.isSafeInteger(Number(payload.baseVersion)) || Number(payload.baseVersion) !== Number(proposal.version || 1))) {
        throw fail('CONFLICT', '建议已在另一端修改，请查看最新内容后重新确认', proposal)
      }
      const at = now(), sources = proposal.captureIds || []
      const meta = () => ({ ...entityMeta(owner, 'ai', sources), createdAt: at, updatedAt: at, sourceProposalId: id })
      const fresh = async (collection, key, document) => {
        if (await get(collection, key)) throw fail('CONFLICT', '建议对应的记录已经存在，已停止覆盖，请先核对')
        return put(collection, key, document)
      }
      const step = (value, index, taskId, offset = 0) => ({
        ...meta(), id: stableId(owner, id, 'step' + index), taskId, title: value.title,
        owner: value.owner || proposal.owner || 'me', order: offset + index,
        status: index === 0 ? 'current' : 'pending', startDate: value.startDate || '', dueDate: value.dueDate || '',
        estimatedMinutes: value.estimatedMinutes || 0, completedAt: ''
      })
      let entity, collection
      if (proposal.type === 'today_todo') {
        collection = 'daily_tasks'; const todoId = stableId(owner, id, 'today_todo')
        entity = await fresh(collection, todoId, {
          ...meta(), id: todoId, lineageId: todoId, entryKind: 'today_todo', date: dayKey(), title: proposal.title,
          description: proposal.detail || '', rawInput: proposal.detail || proposal.title, relatedTaskId: '',
          estimatedMinutes: Number(proposal.estimatedMinutes || 0), tier: proposal.priority === 'high' ? 'core' : 'normal', priority: proposal.priority || 'normal',
          status: 'planned', completionCriteria: proposal.title, comments: [], pinned: false, pinnedAt: '',
          sourceCaptureIds: sources, sourceSuggestionId: proposal.sourceSuggestionId || '', planRationale: '由原始输入识别，经你确认后加入今日待办。'
        })
      } else if (proposal.type === 'task_create') {
        collection = 'tasks'; const taskId = stableId(owner, id, 'task')
        const steps = (proposal.steps || []).map((value, index) => step(value, index, taskId))
        entity = await fresh(collection, taskId, {
          ...meta(), id: taskId, title: proposal.title, description: proposal.detail || '', project: proposal.project || '未分类',
          owner: proposal.owner || 'me', priority: proposal.priority || 'normal', importance: proposal.importance, urgency: proposal.urgency,
          status: 'active', progress: proposal.progress || 0, startDate: proposal.startDate || '', dueDate: proposal.dueDate || '',
          estimatedMinutes: proposal.estimatedMinutes || 30, nextAction: proposal.nextAction || steps[0]?.title || proposal.title,
          steps, currentStepId: steps[0]?.id || '', why: proposal.why || '', completedAt: '', sourceCaptureIds: sources
        })
        for (const row of steps) await fresh('task_steps', row.id, row)
      } else if (proposal.type === 'task_update') {
        collection = 'tasks'; const task = owned(await get(collection, proposal.taskId), '目标任务')
        const base = payload.taskBaseVersion ?? proposal.taskBaseVersion
        if (base !== undefined && Number(base) !== Number(task.version || 1)) throw fail('CONFLICT', '目标任务已更新，请查看最新任务后重新确认', task)
        const oldSteps = []
        for (const embedded of task.steps || []) {
          const stored = embedded.id ? await get('task_steps', embedded.id) : null
          if (stored && (stored.ownerOpenId !== owner || stored.taskId !== task.id)) throw fail('FORBIDDEN', '步骤不属于当前任务')
          if (!deleted(stored) && !deleted(embedded)) oldSteps.push(stored ? { ...embedded, ...stored } : embedded)
        }
        const done = oldSteps.filter((row) => row.status === 'done')
        let steps = oldSteps
        if (proposal.steps?.length) {
          for (const row of oldSteps.filter((item) => item.status !== 'done')) {
            const stored = row.id && await get('task_steps', row.id)
            if (stored && !deleted(stored)) await put('task_steps', row.id, { ...stored, status: 'archived', deletedAt: at, updatedAt: at, version: Number(stored.version || 1) + 1 })
          }
          const suggested = proposal.steps.map((value, index) => step(value, index, task.id, done.length))
          for (const row of suggested) await fresh('task_steps', row.id, row)
          steps = [...done, ...suggested]
        }
        const patch = Object.fromEntries(['title', 'detail', 'nextAction', 'dueDate', 'startDate'].filter((field) => proposal[field] !== undefined)
          .map((field) => [field === 'detail' ? 'description' : field, proposal[field]]))
        entity = await put(collection, task.id, { ...task, ...patch, steps, currentStepId: steps.find((row) => row.status !== 'done')?.id || '',
          progress: steps.length ? Math.round(done.length / steps.length * 100) : Number(proposal.progress ?? task.progress ?? 0),
          sourceCaptureIds: [...new Set([...(task.sourceCaptureIds || []), ...sources])], version: Number(task.version || 1) + 1, updatedAt: at })
      } else if (proposal.type === 'calendar_event') {
        collection = 'day_records'; const date = proposal.eventDate || dayKey(), dayId = scopedDayId(owner, date)
        const old = await get(collection, dayId)
        if (old) owned(old, '日记与日程')
        const startMinutes = timeToMinutes(proposal.eventTime)
        if (startMinutes === null) throw fail('VALIDATION', '日程缺少有效开始时间')
        const session = { id: stableId(owner, id, 'session'), taskId: proposal.taskId || `event_${id}`, title: proposal.title,
          startMinutes, durationMinutes: proposal.eventDurationMinutes || 30, owner: proposal.owner || 'me', status: 'planned', fixed: true,
          scheduleType: 'event', sourceCaptureIds: sources, sourceProposalId: id, planRationale: proposal.why || '', needsConfirmation: proposal.needsConfirmation }
        const day = old || { ...meta(), id: dayId, date, headline: date === dayKey() ? '今天' : date, summary: '', planReason: '',
          taskIds: [], sessions: [], eventIds: [], reflection: '', tomorrowNote: '', isClosed: false }
        await put(collection, dayId, { ...day, sessions: [...(day.sessions || []).filter((row) => row.id !== session.id), session].sort((a, b) => a.startMinutes - b.startMinutes),
          updatedAt: at, version: Number(old?.version || 0) + 1 })
        entity = session
      } else {
        collection = 'timeline_events'; const eventId = stableId(owner, id, 'timeline')
        entity = await fresh(collection, eventId, { ...meta(), id: eventId,
          kind: proposal.type === 'achievement' ? 'result' : ['blocker', 'decision'].includes(proposal.type) ? proposal.type : 'note',
          title: proposal.title, detail: proposal.detail || '', occurredAt: at, taskId: proposal.taskId || '', captureId: sources[0] || '' })
      }
      const updated = await put('proposals', id, { ...proposal, status: 'applied', appliedAt: at, appliedEntityId: entity.id,
        appliedEntityCollection: collection, updatedAt: at, version: Number(proposal.version || 1) + 1 })
      const planningRequired = proposal.type !== 'today_todo'
      if (planningRequired) {
        const jobId = planningJobId(owner), old = await get('sync_state', jobId)
        if (old && old.ownerOpenId !== owner) throw fail('FORBIDDEN', '规划任务空间不匹配')
        await put('sync_state', jobId, { ...entityMeta(owner, 'wechat', []), ...old, id: jobId, status: 'pending',
          generation: Number(old?.generation || 0) + 1, date: dayKey(), updatedAt: at, lastError: '' })
      }
      const result = { proposal: updated, entity, ...(planningRequired ? { planningRequired: true } : {}) }
      await ledger.write(tx, operation, result)
      return { data: result, replayed: false }
    })
  }

  async function finishPlanning(owner, replan) {
    const id = planningJobId(owner), job = dataOf(await db.collection('sync_state').doc(id).get())
    if (!job || job.status !== 'pending') return { status: 'complete' }
    if (job.ownerOpenId !== owner) throw fail('FORBIDDEN', '规划任务空间不匹配')
    try {
      await replan(owner)
      const completed = await db.runTransaction(async (tx) => {
        const ref = tx.collection('sync_state').doc(id), current = dataOf(await ref.get())
        if (!current || current.generation !== job.generation) return false
        await ref.set({ ...current, status: 'complete', completedAt: now(), lastError: '' }); return true
      })
      return { status: completed ? 'complete' : 'pending' }
    } catch (error) {
      // The accepted task/steps are already committed. Keep the durable job and
      // report this separately, so a planner failure cannot mean "apply failed".
      return { status: 'pending', error: String(error.message || '规划尚未完成').slice(0, 300) }
    }
  }
  return { apply, finishPlanning }
}

module.exports = { createProposalStore, stableId, planningJobId }
