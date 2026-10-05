import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const phone = createRequire(import.meta.url)("../../wechat-mini-program-0.10.37-login-copy-20260905/cloudfunctions/notebookApi/index.js").__test;

import {
  reconcileDuplicateCarryOverTodayTodos,
  rollOverIncompleteTodayTodos,
} from "../server.mjs";

function yesterdayKey() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
}

function makeDeviceState(id) {
  return {
    settings: {},
    dailyTasks: [{
      id,
      lineageId: "shared-original-todo",
      carriedFromId: "shared-original-todo",
      entryKind: "today_todo",
      date: yesterdayKey(),
      title: "跨端顺延测试",
      rawInput: "跨端顺延测试",
      source: "carry_over",
      relatedTaskId: "shared-long-task",
      status: "planned",
      comments: [],
      createdAt: "2026-09-20T20:00:00.000Z",
      updatedAt: "2026-09-20T20:00:00.000Z",
    }],
  };
}

test("real phone and desktop derive one stable carry-over id for the same original todo", () => {
  const phoneState = makeDeviceState("phone-previous-copy");
  const desktopState = makeDeviceState("desktop-previous-copy");

  assert.equal(rollOverIncompleteTodayTodos(desktopState), 1);
  const desktopCarry = desktopState.dailyTasks.find((item) => item.status === "planned");
  const phoneCarry = phone.buildCarriedTodayTodo(phoneState.dailyTasks[0], "workspace", desktopCarry.date, 1);
  assert.equal(phoneCarry.id, desktopCarry.id);
});

test("a historical cross-device carry-over collision keeps one visible todo and preserves the other for audit", () => {
  const phoneState = makeDeviceState("phone-previous-copy");
  const desktopState = makeDeviceState("desktop-previous-copy");
  rollOverIncompleteTodayTodos(phoneState);
  rollOverIncompleteTodayTodos(desktopState);
  const phoneCarry = phoneState.dailyTasks.find((item) => item.status === "planned");
  const desktopCarry = desktopState.dailyTasks.find((item) => item.status === "planned");
  desktopCarry.id = "legacy-different-id-from-an-old-client";
  desktopCarry.comments = [{ id: "desktop-note", content: "保留备注", attachments: [] }];

  const merged = { settings: {}, dailyTasks: [phoneCarry, desktopCarry] };
  assert.equal(reconcileDuplicateCarryOverTodayTodos(merged), 1);
  assert.equal(merged.dailyTasks.filter((item) => item.status === "planned").length, 1);
  const archivedDuplicate = merged.dailyTasks.find((item) => item.status === "postponed");
  assert.equal(archivedDuplicate.deferredTo, "duplicate_merged");
  assert.ok(archivedDuplicate.deduplicatedIntoId);
  const visible = merged.dailyTasks.find((item) => item.status === "planned");
  assert.equal(visible.comments[0].id, "desktop-note");
});
