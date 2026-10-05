const test = require("node:test");
const assert = require("node:assert/strict");
const { __test } = require("../cloudfunctions/notebookApi/index.js");

test("今日待办按置顶分组和手动顺序稳定排序", () => {
  const rows = [
    { id: "older", status: "planned", pinned: false, sortRank: 10, createdAt: "2026-08-07T01:00:00.000Z" },
    { id: "newer", status: "planned", pinned: false, sortRank: 20, createdAt: "2026-08-07T02:00:00.000Z" },
    { id: "pinned", status: "planned", pinned: true, sortRank: 5, createdAt: "2026-08-07T00:00:00.000Z" },
  ];
  assert.deepEqual(rows.sort(__test.compareTodayTodos).map((item) => item.id), ["pinned", "newer", "older"]);
  assert.equal(__test.todayTodoSortValue({ createdAt: "2026-08-07T02:00:00.000Z" }), Date.parse("2026-08-07T02:00:00.000Z"));
});

test("持续置顶始终排在普通置顶之前", () => {
  const rows = [
    { id: "regular-new", status: "planned", pinned: true, priorityPinned: false, sortRank: 900 },
    { id: "priority-old", status: "planned", pinned: true, priorityPinned: true, sortRank: 100 },
    { id: "regular-old", status: "planned", pinned: true, priorityPinned: false, sortRank: 500 },
    { id: "normal", status: "planned", pinned: false, sortRank: 1000 }
  ];
  assert.deepEqual(
    rows.sort(__test.compareTodayTodos).map((item) => item.id),
    ["priority-old", "regular-new", "regular-old", "normal"]
  );
  assert.deepEqual(rows.map(__test.todayTodoPinTier), [0, 1, 1, 2]);
});

test("跨天结转使用确定性 ID 并完整保留置顶、评论和附件", () => {
  const source = {
    id: "todo-old",
    entryKind: "today_todo",
    date: "2026-08-24",
    title: "核对申请材料",
    status: "planned",
    pinned: true,
    priorityPinned: true,
    pinnedAt: "2026-08-24T01:00:00.000Z",
    comments: [{ id: "comment-1", content: "还差成绩单", attachments: [{ id: "image-1" }] }],
    sourceCaptureIds: ["capture-1"],
    completedAt: "",
    cloudVersion: 7
  };
  const expectedHash = require("node:crypto")
    .createHash("sha256")
    .update("todo-old|2026-08-25")
    .digest("hex")
    .slice(0, 24);
  const carried = __test.buildCarriedTodayTodo(
    source,
    "owner-1",
    "2026-08-25",
    900,
    "2026-08-25T00:00:00.000Z"
  );

  assert.equal(__test.todayTodoCarryId(source.id, "2026-08-25"), `today-todo-carry-${expectedHash}`);
  assert.equal(carried.id, `today-todo-carry-${expectedHash}`);
  assert.equal(carried.carriedFromId, source.id);
  assert.equal(carried.date, "2026-08-25");
  assert.equal(carried.status, "planned");
  assert.equal(carried.pinned, true);
  assert.equal(carried.priorityPinned, true);
  assert.equal(carried.pinnedAt, source.pinnedAt);
  assert.deepEqual(carried.comments, source.comments);
  assert.deepEqual(carried.sourceCaptureIds, ["capture-1"]);
  assert.equal(carried.cloudVersion, undefined);
  assert.equal(carried.completedAt, undefined);
});

test("零散输入拆成多项今日待办", () => {
  const items = __test.splitTodayTodoInput("给导师发邮件；看一篇具身智能论文\n核对夏令营材料");
  assert.deepEqual(items.map((item) => item.title), [
    "给导师发邮件",
    "看一篇具身智能论文",
    "核对夏令营材料",
  ]);
});

test("Codex 候选只接受今天由本人执行的动作", () => {
  assert.ok(__test.todayTodoCandidateScore("我今天要给导师发邮件并核对材料") >= 7);
  assert.equal(__test.todayTodoCandidateScore("你帮我修改一下网页 UI"), 0);
  assert.equal(__test.todayTodoCandidateScore("为什么小程序不能这样做？"), 0);
  assert.equal(__test.todayTodoCandidateScore("明天再提交报名材料"), 0);
  assert.equal(__test.todayTodoCandidateScore("我今天已经完成了报名"), 0);
});

test("评论附件必须属于当前用户与待办目录", () => {
  const owner = "owner-open-id";
  const todoId = "today_todo_1";
  const prefix = `todo-comments/${require("node:crypto").createHash("sha256").update(owner).digest("hex").slice(0, 24)}/${todoId}`;
  const cloudPath = `${prefix}/image_1.webp`;
  const accepted = __test.normalizeCommentAttachments(owner, todoId, [{
    id: "image_1",
    fileName: "截图.webp",
    mimeType: "image/webp",
    size: 1024,
    cloudPath,
    fileID: `cloud://mainline.${cloudPath}`,
  }]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].cloudPath, cloudPath);
  assert.throws(() => __test.normalizeCommentAttachments(owner, todoId, [{
    mimeType: "image/png",
    size: 1024,
    cloudPath: "todo-comments/another-user/image.png",
    fileID: "cloud://mainline.todo-comments/another-user/image.png",
  }]), /存储位置无效/);
});

test("十四天历史日期跨月计算正确", () => {
  assert.equal(__test.offsetDayKey("2026-08-01", -1), "2026-07-31");
  assert.equal(__test.offsetDayKey("2026-08-01", -14), "2026-07-18");
});

test("电脑配对不等于在线，只有最近心跳才显示在线", () => {
  const now = Date.parse("2026-08-13T03:00:00.000Z");
  assert.equal(__test.desktopHeartbeatOnline("2026-08-13T02:59:30.000Z", now), true);
  assert.equal(__test.desktopHeartbeatOnline("2026-08-13T02:58:00.000Z", now), false);
  assert.equal(__test.desktopHeartbeatOnline("", now), false);
});

test("灵光一现规则整理购物清单并生成 Markdown", () => {
  const entry = __test.ruleJournalEntry("计划买菜，买西红柿、鸡蛋、牛奶");
  assert.equal(entry.journalType, "checklist");
  assert.deepEqual(entry.checklistItems.map((item) => item.text), ["西红柿", "鸡蛋", "牛奶"]);
  assert.match(entry.markdown, /- \[ \] 西红柿/);
});

test("长句笔记保留具体主题而不是退化成随手记", () => {
  const entry = __test.ruleJournalEntry("整理完成已同步的提示栏存在时间太长，需要放到标题右侧短暂显示");
  assert.notEqual(entry.title, "随手记");
  assert.match(entry.title, /整理完成已同步|提示栏/);
  assert.ok(entry.title.length <= 23);
});

test("规则兼容整理保留长笔记 Markdown 的完整尾部", () => {
  const content = `开头 ${"中文🙂".repeat(5000)} 兼容路径尾部标记-20260925`;
  const entry = __test.ruleJournalEntry(content);
  assert.match(entry.summary, /^开头/);
  assert.match(entry.markdown, /兼容路径尾部标记-20260925$/);
});

test("AI 返回泛化标题时改用原文中的具体标题且不重复摘要", () => {
  const entry = __test.normalizeJournalEntry({
    title: "随手记",
    summary: "补充笔记并增加归档入口",
    type: "note",
    items: []
  }, "补充笔记并增加归档入口");
  assert.equal(entry.title, "补充笔记并增加归档入口");
  assert.equal(entry.summary, "");
});

test("勾选后的 Markdown 保留交互状态", () => {
  const markdown = __test.journalMarkdown("买菜清单", "", [
    { text: "鸡蛋", done: true },
    { text: "牛奶", done: false },
  ]);
  assert.match(markdown, /- \[x\] 鸡蛋/);
  assert.match(markdown, /- \[ \] 牛奶/);
});
