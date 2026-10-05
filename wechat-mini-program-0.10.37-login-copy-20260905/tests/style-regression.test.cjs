const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('灵光一现普通笔记使用蓝色，收藏保留黄色', () => {
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.wxss'), 'utf8')
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.wxml'), 'utf8')
  const presenter = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/presenter.js'), 'utf8')
  assert.match(template, /entry\.favorite \? 'is-favorite'/)
  assert.match(presenter, /favorite: Boolean\(entry\.favoritedAt\)/)
  assert.match(styles, /\.journal-card\{border-color:#8c9ce8;background:#f0f4ff\}/)
  assert.match(styles, /\.journal-card:before\{background:#4264d6\}/)
  assert.match(styles, /\.journal-card\.is-favorite\{border-color:#ead7a9;background:#fffdf8\}/)
  assert.match(styles, /\.journal-card\.is-favorite:before\{background:#c7942e\}/)
})

test('今日待办置顶卡片和置顶按钮使用更明确的蓝色', () => {
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxss'), 'utf8')
  assert.match(styles, /\.todo-card\.is-pinned\{border-color:#8298e8;background:#e6edff\}/)
  assert.match(styles, /\.pin-corner\.active\{border-color:#667cda;background:#d6e1ff;color:#2948b5\}/)
})
