const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const capture = require('../miniprogram/pages/capture/presenter')
const diary = require('../miniprogram/pages/tasks/diary-presenter')
const fixture = '# 今天的感悟\n\n我**没有完成**，费用可能是 *123.45 元*。\n保留第二行。\n\n> 暂时不确定\n> 还需要核对\n\n3. 联系老师\n4. 核对材料\n   - 保留子项\n\n- [x] 记录完成\n- [ ] 尚未处理\n\n[参考](https://example.com/a?q=1&b=2)\n\n```js\n  const x = "**不要改**";\n\n  // 不是列表\n```\n\n末尾保留。'
const walk = (nodes) => (nodes || []).flatMap((node) => [node, ...walk(node.children)])
const textOf = (node) => node.type === 'text' ? node.text : (node.children || []).map(textOf).join('')

test('phone journal body keeps strong/emphasis, quoted uncertainty and exact fenced source', () => {
  const entry = capture.present({ id: 'md', journalTitle: '日记', rawContent: fixture, organizedContent: fixture, markdown: fixture })
  const nodes = walk(entry.bodyNodes)
  assert.ok(nodes.some((node) => node.name === 'strong' && textOf(node) === '没有完成'), 'body lost bold markup')
  assert.ok(nodes.some((node) => node.name === 'em' && textOf(node) === '123.45 元'))
  assert.ok(nodes.some((node) => node.name === 'blockquote' && textOf(node).includes('暂时不确定')))
  const code = nodes.find((node) => node.name === 'pre')
  assert.equal(textOf(code), '  const x = "**不要改**";\n\n  // 不是列表\n')
  assert.equal(entry.originalContent, fixture)
})

test('phone diary and journal share one rendering tree including numbered and nested lists', () => {
  const summary = '## 今日记录\n\n' + fixture
  const view = diary.buildDiaryView({ todayDate: '2026-09-25', days: [{ date: '2026-09-25', summary }] })
  const entry = capture.present({ id: 'same', journalTitle: '标题', organizedContent: summary })
  assert.ok(Array.isArray(view.summaryNodes), 'diary has no structured Markdown tree')
  assert.deepEqual(view.summaryNodes, entry.bodyNodes)
  assert.equal(walk(view.summaryNodes).find((node) => node.name === 'ol').attrs.start, '3')
  assert.ok(walk(view.summaryNodes).some((node) => node.attrs && node.attrs.class === 'md-task-done'))
})

test('supplements render formatting and journal without markdown field still renders its full body', () => {
  const entry = capture.present({ id: 'supp', journalTitle: '内容', organizedContent: '**主体**', journalSupplements: [{ id: 's', content: '> 也许没有完成' }] })
  assert.ok(walk(entry.bodyNodes).some((node) => node.name === 'strong'))
  assert.ok(walk(entry.supplements[0].bodyNodes).some((node) => node.name === 'blockquote'))
})

test('desktop and mini parser plus pinned vendor are byte-identical', () => {
  const desktop = path.resolve(__dirname, '../../personal-task-workbench-4320-wechat-login-test/shared')
  const mobile = path.resolve(__dirname, '../miniprogram/utils')
  for (const file of ['markdown.js', 'vendor/markdown-it.js']) assert.equal(fs.readFileSync(path.join(desktop, file), 'utf8'), fs.readFileSync(path.join(mobile, file), 'utf8'))
  assert.deepEqual(require(path.join(desktop, 'markdown.js')).parseMarkdown(fixture), require(path.join(mobile, 'markdown.js')).parseMarkdown(fixture))
})

test('links keep their full target, unsafe markup is literal and images never fetch an untrusted URL', () => {
  const { parseMarkdown, markdownLinks } = require('../miniprogram/utils/markdown')
  const raw = '[安全](https://example.com/a?q=1&b=2) [邮件](mailto:a@example.com) [坏](javascript:alert(1))\n\n<script>alert(1)</script>\n\n![图片](https://example.com/p.png)'
  const nodes = parseMarkdown(raw), all = walk(nodes)
  assert.ok(!all.some((node) => ['script', 'iframe', 'img'].includes(node.name)))
  assert.ok(all.filter((node) => node.name === 'a').every((node) => /^(https?:|mailto:)/.test(node.attrs.href)))
  assert.ok(nodes.map(textOf).join('').includes('<script>alert(1)</script>'))
  assert.ok(markdownLinks(nodes).some((link) => link.url === 'https://example.com/a?q=1&b=2'))
  assert.ok(markdownLinks(nodes).some((link) => link.url === 'https://example.com/p.png'))
})

test('long Unicode and unsupported syntax remain visible without truncation; hard line breaks survive', () => {
  const { parseMarkdown } = require('../miniprogram/utils/markdown')
  const raw = '甲🙂'.repeat(15000) + '\n第二行\n\n$x_1$ 和 ~~暂时~~\n\n最后一字Ω'
  const nodes = parseMarkdown(raw)
  assert.ok(nodes.map(textOf).join('').includes('甲🙂'.repeat(15000)))
  assert.ok(nodes.map(textOf).join('').endsWith('最后一字Ω'))
  assert.ok(walk(nodes).some((node) => node.name === 'br'))
  assert.ok(walk(nodes).some((node) => node.name === 's' && textOf(node) === '暂时'))
})

test('fences protect stars and task markers, unclosed fences keep remaining content', () => {
  const { parseMarkdown } = require('../miniprogram/utils/markdown')
  const raw = '~~~text\n- [x] **未确定**\n末尾'
  const nodes = parseMarkdown(raw)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].name, 'pre')
  assert.equal(textOf(nodes[0]), '- [x] **未确定**\n末尾')
})

test('table columns and reference links retain content; link extraction is deduplicated', () => {
  const { parseMarkdown, markdownLinks } = require('../miniprogram/utils/markdown')
  const nodes = parseMarkdown('| 项目 | 金额 |\n| --- | ---: |\n| 未付款 | 123.45 |\n\n[甲][r] [乙][r]\n\n[r]: https://example.com/full-path')
  assert.ok(walk(nodes).some((node) => node.name === 'table'))
  assert.ok(walk(nodes).some((node) => node.name === 'td' && textOf(node) === '123.45'))
  assert.deepEqual(markdownLinks(nodes), [{ label: '甲', url: 'https://example.com/full-path' }])
})

test('old markdown outline cannot replace the complete body and Codex source is not exposed', () => {
  const { journalBody } = require('../miniprogram/utils/markdown')
  const entry = capture.present({ id: 'legacy', journalTitle: '旧记录', organizedContent: '**完整正文**及补充事实', markdown: '# 只有标题' })
  assert.ok(walk(entry.bodyNodes).some((node) => node.name === 'strong' && textOf(node) === '完整正文'))
  assert.equal(journalBody({ source: 'codex', content: 'private raw', markdown: 'private markdown', organizationSummary: '允许展示的整理摘要' }), '允许展示的整理摘要')
  assert.equal(journalBody({ source: 'codex', content: 'private raw' }), '')
  assert.equal(capture.present({ id: 'markdown-only', journalTitle: '旧格式', markdown: '**保留正文**' }).showBody, true)
})

test('native Markdown component copies the selected full URL and clears stale links on a new record', () => {
  const file = path.resolve(__dirname, '../miniprogram/components/markdown-view/index.js')
  let definition
  const copied = []
  new Function('require', 'Component', 'wx', fs.readFileSync(file, 'utf8'))(
    require('node:module').createRequire(file), (value) => { definition = value },
    { setClipboardData: ({ data }) => copied.push(data) })
  const instance = { data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch) } }
  const { parseMarkdown } = require('../miniprogram/utils/markdown')
  definition.observers.nodes.call(instance, parseMarkdown('[目标](https://example.com/full?one=1&two=2)'))
  definition.methods.copyLink.call(instance, { currentTarget: { dataset: { index: 0 } } })
  assert.deepEqual(copied, ['https://example.com/full?one=1&two=2'])
  definition.observers.nodes.call(instance, parseMarkdown('另一个账号的记录'))
  definition.methods.copyLink.call(instance, { currentTarget: { dataset: { index: 0 } } })
  assert.deepEqual(copied, ['https://example.com/full?one=1&two=2'])
})

test('lazy history component formats a complete past diary and clears its previous body', () => {
  const file = path.resolve(__dirname, '../miniprogram/components/markdown-view/index.js')
  let definition
  new Function('require', 'Component', fs.readFileSync(file, 'utf8'))(
    require('node:module').createRequire(file), (value) => { definition = value })
  const instance = { data: {}, setData(patch) { Object.assign(this.data, patch) } }
  definition.properties.content.observer.call(instance, '**历史**\n\n' + '完整原文'.repeat(2000))
  assert.ok(walk(instance.data.nodes).some((node) => node.name === 'strong' && textOf(node) === '历史'))
  assert.ok(instance.data.nodes.map(textOf).join('').endsWith('完整原文'.repeat(2000)))
  definition.properties.content.observer.call(instance, '')
  assert.deepEqual(instance.data.nodes, [])
})

test('vendored parser matches its pinned provenance and ships its license', () => {
  const vendor = path.resolve(__dirname, '../miniprogram/utils/vendor')
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'markdown-it.provenance.json'), 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(manifest.version, '15.0.2')
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(vendor, 'markdown-it.js'))).digest('hex')
  assert.equal(digest, manifest.sha256.toLowerCase())
  assert.match(fs.readFileSync(path.join(vendor, 'markdown-it.LICENSE'), 'utf8'), /MIT/)
})
