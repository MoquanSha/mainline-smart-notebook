import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { reconcileDuplicateCarryOverTodayTodos, rollOverIncompleteTodayTodos, todayTodoCarryId, handleAction } from "../server.mjs";
const phone = createRequire(import.meta.url)("../../wechat-mini-program-0.10.37-login-copy-20260905/cloudfunctions/notebookApi/index.js").__test;
const date = "2026-09-24";
const row = (id, patch = {}) => ({ id, entryKind: "today_todo", date: "2026-09-23", title: "同名待办", rawInput: "同名待办", relatedTaskId: "shared-task", status: "planned", source: "manual", comments: [], createdAt: "2026-09-23T01:00:00Z", ...patch });
const state = (...rows) => ({ settings: {}, dailyTasks: rows });

test("real desktop and cloud implementations use original-id/date, even across skipped days", () => {
  const source = row("shared-source");
  const desktop = state(structuredClone(source));
  assert.equal(rollOverIncompleteTodayTodos(desktop, date), 1);
  const carried = desktop.dailyTasks.find((item) => item.date === date);
  const mobile = phone.buildCarriedTodayTodo(source, "space-a", date, 1);
  assert.equal(carried.id, mobile.id);
  assert.equal(carried.lineageId, source.id);
  assert.equal(mobile.lineageId, source.id);
  assert.equal(todayTodoCarryId(carried, "2026-09-25"), phone.todayTodoCarryId(source, "2026-09-25"));
});

test("distinct originals sharing title/task stay distinct, including older unfinished days", () => {
  const desktop = state(row("a", { date: "2026-09-21" }), row("b"));
  assert.equal(rollOverIncompleteTodayTodos(desktop, date), 2);
  const current = desktop.dailyTasks.filter((item) => item.date === date);
  assert.equal(new Set(current.map((item) => item.id)).size, 2);
  assert.deepEqual(new Set(current.map((item) => item.lineageId)), new Set(["a", "b"]));
  assert.equal(reconcileDuplicateCarryOverTodayTodos(desktop, date), 0);
});

test("legacy ancestry resolves across multiple days without guessing from title", () => {
  const desktop = state(row("root", { date: "2026-09-20", status: "postponed" }), row("middle", { date: "2026-09-21", carriedFromId: "root", status: "postponed" }), row("leaf", { carriedFromId: "middle", source: "carry_over" }));
  rollOverIncompleteTodayTodos(desktop, date);
  const current = desktop.dailyTasks.find((item) => item.date === date);
  assert.equal(current.lineageId, "root");
  assert.equal(current.id, phone.todayTodoCarryId("root", date));
});

test("same-lineage duplicates retain comments/audit while unrelated rows stay visible", () => {
  const desktop = state(row("old-1", { date, source: "carry_over", carriedFromId: "source", lineageId: "source" }), row("old-2", { date, source: "carry_over", carriedFromId: "source", lineageId: "source", comments: [{ id: "c", content: "保留评论" }] }), row("unrelated", { date, source: "carry_over", carriedFromId: "other" }));
  assert.equal(reconcileDuplicateCarryOverTodayTodos(desktop, date), 1);
  assert.equal(desktop.dailyTasks.filter((item) => item.status === "planned").length, 2);
  assert.equal(desktop.dailyTasks.find((item) => item.id === "old-1").comments[0].content, "保留评论");
  assert.equal(desktop.dailyTasks.find((item) => item.id === "old-2").deduplicatedIntoId, "old-1");
});

test("deleted/completed descendants prevent stale ancestors from rolling over", () => {
  for (const patch of [{ status: "removed", trashedAt: "2026-09-23T12:00:00Z" }, { deletedAt: "2026-09-23T12:00:00Z" }, { status: "done" }]) {
    const desktop = state(row("root", { date: "2026-09-21" }), row("descendant", { lineageId: "root", carriedFromId: "root", ...patch }));
    assert.equal(rollOverIncompleteTodayTodos(desktop, date), 0);
    assert.equal(desktop.dailyTasks.filter((item) => item.date === date).length, 0);
  }
});

test("a deleted target is not recreated or modified by rollover", () => {
  const deleted = row(phone.todayTodoCarryId("source", date), { date, lineageId: "source", carriedFromId: "source", status: "removed", deletedAt: "2026-09-24T01:00:00Z" });
  const desktop = state(row("source"), structuredClone(deleted));
  assert.equal(rollOverIncompleteTodayTodos(desktop, date), 0);
  assert.deepEqual(desktop.dailyTasks.find((item) => item.id === deleted.id), deleted);
});

test("desktop handlers refuse late completion and comments on deleted todos", async () => {
  const desktop = state(row("deleted", { status: "removed", trashedAt: "2026-09-24T01:00:00Z" }));
  for (const action of ["todayTodo.complete", "todayTodo.reopen", "todayTodo.defer", "todayTodo.commentAdd", "todayTodo.togglePin"]) {
    await assert.rejects(handleAction(desktop, { action, todoId: "deleted", content: "本机保留" }), /已删除/);
  }
  assert.equal(desktop.dailyTasks[0].status, "removed");
});
