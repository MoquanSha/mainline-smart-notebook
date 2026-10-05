"use strict";

const COLLECTIONS = ["tasks", "daily_tasks", "captures", "day_records"];
const fail = (message) => Object.assign(new Error(message), { code: "SYNC_CHECKPOINT_INVALID", retryable: false });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

function validateCursor(cursor, workspaceId, phase) {
  if (!cursor || cursor.workspaceId !== workspaceId || cursor.version !== 2 || !integer(cursor.collection) || cursor.collection > COLLECTIONS.length) throw fail("接收进度或空间不一致，未推进进度");
  if (phase === "history") {
    if (typeof cursor.after !== "string" || cursor.after.length > 256 || !integer(cursor.changeAfter)) throw fail("历史接收进度无效");
  } else if (![cursor.from, cursor.through, cursor.after].every(integer) || cursor.from > cursor.after || cursor.after > cursor.through) throw fail("增量接收进度无效");
}

async function receiveOrdered({ workspaceId, scope, checkpoint, headSequence, readPage, applyPage, assertCurrent = () => {}, pageBudget = 8 }) {
  if (!workspaceId || !scope || !integer(headSequence)) throw fail("云端未提供有效的空间和接收序号");
  let state = checkpoint ? structuredClone(checkpoint) : { version: 2, workspaceId, scope, phase: "history", cursor: null, after: 0 };
  if (state.version !== 2 || state.workspaceId !== workspaceId || state.scope !== scope || !["history", "changes", "idle"].includes(state.phase) || !integer(state.after)) throw fail("接收进度不属于当前登录，原有数据已保留");
  if (state.cursor) validateCursor(state.cursor, workspaceId, state.phase);
  if (state.after > headSequence || state.cursor && (state.phase === "history" ? state.cursor.changeAfter : state.cursor.through) > headSequence) throw fail("云端序号发生回退，需要核对环境，未重置本地记录");
  const budget = Math.max(1, Math.min(20, Math.floor(Number(pageBudget) || 8)));
  let pulled = 0, pages = 0;
  for (; pages < budget;) {
    assertCurrent();
    if (state.phase === "idle") {
      if (state.after >= headSequence) break;
      state = { ...state, phase: "changes", cursor: null };
    }
    const phase = state.phase;
    const response = await readPage(phase === "history" ? "sync.historyPage" : "sync.changes", {
      ...(state.cursor ? { cursor: state.cursor } : phase === "changes" ? { after: state.after } : {}), limit: 99,
    });
    assertCurrent();
    if (!response || !Array.isArray(response.records) || typeof response.hasMore !== "boolean") throw fail("历史分页回复不完整，未确认这一页");
    validateCursor(response.nextCursor, workspaceId, phase);
    const next = response.nextCursor;
    const currentCollection = state.cursor?.collection || 0;
    if (response.hasMore !== (next.collection < COLLECTIONS.length)) throw fail("分页结束标记与游标不一致");
    if (state.cursor && (next.collection < state.cursor.collection || JSON.stringify(next) === JSON.stringify(state.cursor))) throw fail("分页没有前进，已保留收到的内容");
    if (phase === "history" && state.cursor && next.changeAfter !== state.cursor.changeAfter) throw fail("历史接收的起始序号发生变化");
    if (phase === "changes" && (next.from !== state.after || state.cursor && next.through !== state.cursor.through)) throw fail("增量窗口发生变化");
    if (next.collection > currentCollection + 1 && !(phase === "changes" && next.from === next.through && !response.records.length)) throw fail("分页跳过了未接收的集合");
    if (state.cursor && next.collection === currentCollection && next.after <= state.cursor.after) throw fail("分页记录边界没有前进");
    for (const record of response.records) {
      if (record.collection !== COLLECTIONS[currentCollection] || !record.document?.id || typeof record.document.id !== "string") throw fail("收到无法识别的记录，未跳过这一页");
    }
    const proposed = response.hasMore ? { ...state, cursor: next }
      : phase === "history" ? { ...state, phase: "changes", cursor: null, after: next.changeAfter }
        : { ...state, phase: "idle", cursor: null, after: next.through };
    // The caller must durably merge the records FIRST, then atomically publish
    // this checkpoint. A crash between them only replays the same stable IDs.
    await applyPage(response.records, proposed);
    assertCurrent();
    state = proposed;
    pulled += response.records.length;
    pages++;
    if (phase === "changes" && !response.hasMore) break;
  }
  return { checkpoint: state, pulled, pages, pending: state.phase !== "idle" || state.after < headSequence };
}

module.exports = { receiveOrdered };
