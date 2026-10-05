// Canonical renderer contract. Mirror byte-for-byte to miniprogram/utils/markdown.js.
// The tree is consumed by React and native rich-text; raw HTML is never executed.
// Do not load the bundled Markdown engine while the page module is being
// initialized. Older WeChat base libraries can reject a modern bundled
// dependency before the page has a chance to render. Keep the dependency
// lazy and fall back to the small renderer below when it cannot load.
let parser
let parserAttempted = false
function getParser() {
  if (parserAttempted) return parser
  parserAttempted = true
  try {
    const MarkdownIt = require('./vendor/markdown-it.js')
    parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true })
  } catch (_) {
    parser = null
  }
  return parser
}
const styles = {
  p: 'margin:0.35em 0;overflow-wrap:anywhere;white-space:pre-wrap',
  h1: 'font-size:1.4em;font-weight:700;line-height:1.45;margin:0.8em 0 0.35em',
  h2: 'font-size:1.25em;font-weight:700;line-height:1.45;margin:0.8em 0 0.35em',
  h3: 'font-size:1.15em;font-weight:700;line-height:1.45;margin:0.8em 0 0.35em',
  h4: 'font-size:1.05em;font-weight:700;margin:0.7em 0 0.3em',
  h5: 'font-size:1em;font-weight:700;margin:0.7em 0 0.3em',
  h6: 'font-size:1em;font-weight:700;margin:0.7em 0 0.3em',
  blockquote: 'margin:0.5em 0;padding:0.2em 0.8em;border-left:3px solid #b9bfe6;color:#676579',
  ul: 'margin:0.35em 0;padding-left:1.5em', ol: 'margin:0.35em 0;padding-left:1.7em',
  li: 'margin:0.2em 0',
  pre: 'margin:0.5em 0;padding:0.8em;border-radius:6px;background:#20232a;color:#f4f5f7;overflow-x:auto;white-space:pre;line-height:1.55;font-family:Consolas,monospace',
  code: 'font-family:Consolas,monospace;background:#eceef2;color:#6d3fa0;padding:0.1em 0.3em;border-radius:3px',
  a: 'color:#4f62d2;text-decoration:underline;overflow-wrap:anywhere',
  table: 'border-collapse:collapse;margin:0.6em 0;width:100%',
  th: 'border:1px solid #dfe2eb;padding:0.35em;text-align:left',
  td: 'border:1px solid #dfe2eb;padding:0.35em;text-align:left',
  hr: 'border:0;border-top:1px solid #dfe2eb;margin:0.8em 0'
}
const tags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', 's', 'a', 'br', 'hr', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td'])
const text = (value) => ({ type: 'text', text: value })
const element = (name, attrs = {}, children = []) => ({ type: 'node', name, attrs: { ...(styles[name] ? { style: styles[name] } : {}), ...attrs }, children })
function safeLink(value) { return /^(https?:\/\/|mailto:)[^\s\u0000-\u001f]*$/i.test(String(value || '')) }
function textContent(nodes) { return (nodes || []).map((node) => node.type === 'text' ? node.text : node.name === 'br' ? '\n' : textContent(node.children)).join('') }

function tree(tokens) {
  const root = [], stack = [root]
  for (const token of tokens) {
    const target = stack[stack.length - 1]
    if (token.type === 'inline') { target.push(...tree(token.children || [])); continue }
    if (token.type === 'text') { target.push(text(token.content)); continue }
    if (token.type === 'softbreak' || token.type === 'hardbreak') { target.push(element('br')); continue }
    if (token.type === 'code_inline') { target.push(element('code', {}, [text(token.content)])); continue }
    if (token.type === 'fence' || token.type === 'code_block') {
      target.push(element('pre', {}, [element('code', { style: 'background:transparent;color:inherit;padding:0;font-family:inherit;white-space:pre' }, [text(token.content)])])); continue
    }
    if (token.type === 'image') {
      // The app's attachment uploader owns images. Keep Markdown image links
      // visible without silently fetching third-party resources while reading.
      const url = token.attrGet('src'), label = `图片 · ${token.content || '查看图片'}`
      target.push(safeLink(url) ? element('a', { href: url }, [text(label)]) : text(`![${token.content}](${url || ''})`)); continue
    }
    if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue }
    if (token.nesting === 1) {
      const attrs = {}, tag = tags.has(token.tag) ? token.tag : 'span'
      if (tag === 'a' && safeLink(token.attrGet('href'))) attrs.href = token.attrGet('href')
      if (tag === 'a' && token.attrGet('title')) attrs.title = token.attrGet('title')
      if (tag === 'ol' && /^\d+$/.test(token.attrGet('start') || '')) attrs.start = String(token.attrGet('start'))
      if (['td', 'th'].includes(tag) && /^text-align:(left|right|center)$/.test(token.attrGet('style') || '')) attrs.style = styles[tag] + ';' + token.attrGet('style')
      const node = element(tag, attrs)
      target.push(node); stack.push(node.children); continue
    }
    if (token.type === 'hr') target.push(element('hr'))
    else if (token.content) target.push(text(token.content))
  }
  return root
}

function decorateTasks(nodes) {
  for (const node of nodes) {
    if (node.name === 'li') {
      const first = node.children[0], content = first && first.name === 'p' ? first.children : node.children
      const prefix = content[0] && content[0].type === 'text' && content[0].text.match(/^\[([ xX])\]\s+/)
      if (prefix) {
        const done = prefix[1].toLowerCase() === 'x'
        node.attrs.class = done ? 'md-task-done' : 'md-task-open'
        node.attrs.style += ';list-style-type:none'
        content[0].text = content[0].text.slice(prefix[0].length)
        content.unshift(element('span', { style: 'font-family:inherit;color:#5367d9', title: done ? '已完成' : '未完成' }, [text(done ? '☑ ' : '☐ ')]))
      }
    }
    if (node.children) decorateTasks(node.children)
  }
  return nodes
}

function fallbackInline(value) {
  const source = String(value || '')
  const nodes = []
  const pattern = /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^\s)]+\)|`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g
  let cursor = 0
  let match
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) nodes.push(text(source.slice(cursor, match.index)))
    const token = match[0]
    const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/)
    if (link && safeLink(link[2])) nodes.push(element('a', { href: link[2] }, [text(link[1])]))
    else if (token[0] === '`') nodes.push(element('code', {}, [text(token.slice(1, -1))]))
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(element('strong', {}, [text(token.slice(2, -2))]))
    else if (token[0] === '*' || token[0] === '_') nodes.push(element('em', {}, [text(token.slice(1, -1))]))
    else nodes.push(text(token))
    cursor = match.index + token.length
  }
  if (cursor < source.length) nodes.push(text(source.slice(cursor)))
  return nodes.length ? nodes : [text(source)]
}

function fallbackMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n')
  const nodes = []
  let inFence = false
  let fenceText = []
  for (const raw of lines) {
    const line = raw.trim()
    if (/^```/.test(line)) {
      if (inFence) {
        nodes.push(element('pre', {}, [element('code', { style: 'background:transparent;color:inherit;padding:0;font-family:inherit;white-space:pre' }, [text(fenceText.join('\n'))])]));
        inFence = false
        fenceText = []
      } else inFence = true
      continue
    }
    if (inFence) { fenceText.push(raw); continue }
    if (!line) continue
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) { nodes.push(element(`h${heading[1].length}`, {}, fallbackInline(heading[2]))); continue }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) { nodes.push(element('blockquote', {}, [element('p', {}, fallbackInline(quote[1]))])); continue }
    if (/^(?:---+|\*\*\*+|___+)$/.test(line)) { nodes.push(element('hr')); continue }
    const checked = line.match(/^[-*+]\s+\[([ xX])\]\s+(.+)$/)
    if (checked) {
      nodes.push(element('p', {}, [element('span', { style: 'font-family:inherit;color:#5367d9' }, [text(checked[1].toLowerCase() === 'x' ? '☑ ' : '☐ ')]), ...fallbackInline(checked[2])]));
      continue
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/)
    if (bullet) { nodes.push(element('p', {}, [text('• '), ...fallbackInline(bullet[1])])); continue }
    nodes.push(element('p', {}, fallbackInline(line)))
  }
  if (inFence && fenceText.length) nodes.push(element('pre', {}, [element('code', {}, [text(fenceText.join('\n'))])]));
  return nodes
}

function parseMarkdown(value) {
  const source = String(value == null ? '' : value)
  const engine = getParser()
  if (engine) {
    try { return decorateTasks(tree(engine.parse(source, {}))) } catch (_) {}
  }
  return fallbackMarkdown(source)
}
function markdownLinks(nodes) {
  const links = [], seen = new Set()
  function visit(list) {
    for (const node of list || []) {
      const url = node.name === 'a' && node.attrs && node.attrs.href
      if (safeLink(url) && !seen.has(url)) { seen.add(url); links.push({ label: textContent(node.children) || url, url }) }
      if (node.children) visit(node.children)
    }
  }
  visit(nodes)
  return links
}
function journalBody(entry) {
  if (entry.source === 'codex') return String(entry.organizationSummary || entry.journalSummary || '')
  // A legacy markdown field may only be a short outline. The complete reading
  // body takes precedence on BOTH clients, rather than replacing it with that outline.
  return String(entry.organizedContent || entry.markdown || entry.journalSummary || entry.organizationSummary || entry.content || entry.rawContent || '')
}
module.exports = { parseMarkdown, markdownLinks, textContent, journalBody }
