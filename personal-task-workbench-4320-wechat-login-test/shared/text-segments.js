'use strict'
// Canonical server-side segmentation and assembly. Mirror to notebookApi.
const MarkdownIt = require('./vendor/markdown-it.js')
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false })
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' })
const POLICY = 'source-seams-v1'
const phrases = /并没有|尚不确定|还不确定|不太确定|尚未确定|不确定|没有|并未|尚未|未能|没能|还没|还未|不是|不能|不会|不愿|不想|不要|无需|不再|可能|也许|或许|大概|大约|似乎|好像|未必|待确认|待核实/g

function lineOffsets(source) {
  const offsets = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1)
  offsets.push(source.length)
  return offsets
}
function protectedRanges(source, size) {
  const offsets = lineOffsets(source), ranges = []
  for (const token of parser.parse(source, {})) {
    if (token.map && ['fence', 'code_block', 'table_open'].includes(token.type)) {
      ranges.push([offsets[token.map[0]], offsets[token.map[1]] ?? source.length])
    }
  }
  // A huge identifier, URL or digit string has no useful prose boundary.
  // Preserve it literally in bounded receipts instead of asking AI to cut it.
  for (const match of source.matchAll(new RegExp('[A-Za-z0-9_][A-Za-z0-9_.:/%+=-]{' + size + ',}', 'g'))) {
    ranges.push([match.index, match.index + match[0].length])
  }
  const merged = []
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1])
    else merged.push(range)
  }
  return merged
}
function splitZone(source, size, literal) {
  const chars = [...graphemes.segment(source)].map((part) => part.segment), result = []
  const forbidden = (at) => {
    if (at <= 0 || at >= chars.length) return false
    if (/[A-Za-z0-9_.:/%+=-]$/.test(chars[at - 1]) && /^[A-Za-z0-9_.:/%+=-]/.test(chars[at])) return true
    const left = chars.slice(Math.max(0, at - 8), at).join(''), around = left + chars.slice(at, at + 8).join('')
    return [...around.matchAll(phrases)].some((match) => match.index < left.length && match.index + match[0].length > left.length)
  }
  for (let start = 0; start < chars.length;) {
    let end = Math.min(chars.length, start + size)
    if (!literal && end < chars.length) {
      const lower = start + Math.floor(size / 2)
      let boundary = end
      for (let at = end; at >= lower; at--) {
        if (!forbidden(at) && /[\s。！？；，;!?]$/.test(chars[at - 1])) { boundary = at; break }
      }
      while (boundary > start && forbidden(boundary)) boundary--
      if (boundary > start) end = boundary
    }
    result.push({ content: chars.slice(start, end).join(''), literal })
    start = end
  }
  return result
}
function splitText(value, size = 3000) {
  if (!Number.isInteger(size) || size < 16 || size > 12000) throw new Error('Invalid organization segment size')
  const source = String(value || ''), result = []
  let at = 0
  for (const [start, end] of protectedRanges(source, size)) {
    result.push(...splitZone(source.slice(at, start), size, false), ...splitZone(source.slice(start, end), size, true))
    at = end
  }
  result.push(...splitZone(source.slice(at), size, false))
  return result.map((part, index) => ({ ...part, index, total: result.length }))
}
function splitInputs(inputs, size = 3000) {
  return (inputs || []).flatMap((input) => splitText(input.content, size).map((segment) => ({
    ...input, ...segment, part: segment.index + 1, parts: segment.total
  })))
}
function restoreEdges(source, candidate, before, after) {
  if (source === candidate) return source
  const leading = String(before ? source : candidate).match(/^\s*/)[0], trailing = String(after ? source : candidate).match(/\s*$/)[0]
  if (!source.trim()) return source
  return leading + String(candidate).trim() + trailing
}
function joinText(parts, outputs) {
  if (parts.length !== outputs.length) throw new Error('整理段落数量不一致，原文已保留')
  return parts.map((part, index) => part.literal ? part.content : restoreEdges(part.content, outputs[index], index > 0, index < parts.length - 1)).join('')
}
function diarySections(candidate) {
  const text = String(candidate || '').replace(/^##[ \t]+今日记录[ \t]*(?:\r?\n){0,2}/, '')
  const offsets = lineOffsets(text), tokens = parser.parse(text, {})
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type === 'heading_open' && tokens[i].tag === 'h2' && tokens[i].level === 0 && tokens[i + 1].content.trim() === '今日补充') {
      const at = offsets[tokens[i].map[0]]
      return { body: text.slice(0, at).replace(/\s+$/, ''), supplements: text.slice(at).trim() }
    }
  }
  return { body: text, supplements: '' }
}
function joinDiary(fragments, outputs) {
  const sections = outputs.map((output, index) => fragments[index].manualInputs[0]?.literal
    ? { body: '', supplements: '' } : diarySections(output))
  let body = '', groupParts = [], groupBodies = []
  const flush = () => {
    if (!groupParts.length) return
    if (body) body += '\n\n'
    body += joinText(groupParts, groupBodies)
    groupParts = []; groupBodies = []
  }
  for (let i = 0; i < fragments.length; i++) {
    const part = fragments[i].manualInputs[0]
    if (part) {
      if (part.part === 1) flush()
      groupParts.push(part); groupBodies.push(sections[i].body)
    } else if (!fragments.some((item) => item.manualInputs.length)) body += sections[i].body.trim()
    if (i < fragments.length - 1 && sections[i].supplements) throw Object.assign(new Error('整理稿在中间段提前加入补充，原文已保留，请手动重试'), { code: 'AI_FRAGMENT_STRUCTURE' })
  }
  flush()
  const supplements = sections.at(-1)?.supplements
  return '## 今日记录\n\n' + body + (supplements ? '\n\n' + supplements : '')
}
function hasSupplements(context) {
  const keys = ['captures', 'timelineEvents', 'sessions', 'dailyTasks', 'activeTasks', 'newTodos', 'completed', 'notes', 'journals', 'existingPeriods']
  return keys.some((key) => Array.isArray(context[key]) && context[key].length) ||
    Object.values(context.dailyFacts || {}).some((value) => Array.isArray(value) && value.length)
}
module.exports = { POLICY, splitText, splitInputs, joinText, diarySections, joinDiary, hasSupplements }
