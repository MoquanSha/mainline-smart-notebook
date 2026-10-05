const longBody = [
  '我想把最近关于手机和电脑同步的思考整理下来，今日待办、灵光一现和长期计划都要保留，但没有变化的数据不应重复上传。',
  '手机端和电脑端切换时，收藏、隐藏状态、清单完成情况和排序都应保持一致。',
  '原始 Codex 记录和运行日志不需要出现在手机上，只同步经过整理后真正有用的内容。',
  '用户之后回看时，应该先看到容易检索的短标题，再展开阅读完整笔记；长内容不能挤满整个手机屏幕，也不能因为标题和正文相同就被系统直接隐藏。',
  '日期索引只负责帮助跳转，收藏、隐藏、清单勾选和展开操作仍沿用原来的交互。'
].join('\n')

module.exports = {
  longBody,
  longEntry: {
    id: 'long-entry',
    source: 'manual',
    occurredAt: '2026-08-18T08:30:00.000Z',
    journalTitle: longBody,
    journalSummary: longBody,
    organizedContent: longBody,
    content: longBody,
    journalType: 'note',
    checklistItems: [
      { id: 'one', text: '核对手机与电脑的收藏状态', checked: true },
      { id: 'two', text: '确认没有变化的数据不会重复上传', done: false, checked: true }
    ],
    markdown: '# 增量同步\n- [x] 核对收藏状态\n- [ ] 核对隐藏状态\n> 只同步整理后的有效内容\n\n保留用户手动记下的重要输入。'
  }
}
