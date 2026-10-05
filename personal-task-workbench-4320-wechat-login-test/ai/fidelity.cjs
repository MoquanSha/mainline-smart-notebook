'use strict'

// A conservative marker check, NOT a semantic equivalence proof. Equal markers
// cannot detect changed subjects, swapped amounts, invented causes or sarcasm.
// Suspicious results must not replace the reading body automatically.
const POLICY = 'fidelity-markers-v1'
const uncertainty = [
  { kind: 'uncertainty', label: '不确定语气', pattern: /可能|也许|或许|大概|大约|大致|似乎|好像|估计|恐怕|未必|约(?=\s*\d)|\b(?:may|might|maybe|perhaps|probably|possibly|approximately)\b/gi },
  { kind: 'unconfirmed', label: '待确认表述', pattern: /尚不确定|还不确定|不确定|不太确定|尚未确定|待确认|待核实|待核对|有待确认|需要核实|\b(?:not sure|uncertain|unconfirmed|to be confirmed)\b/gi }
]
const negative = /并没有|并未|尚未|没有|未曾|未能|没能|还没|还未|没|未(?=完成|提交|付款|通过|报名|处理|开始|结束|收到|找到)|不是|并不|不能|不会|不愿|不想|不应|不要|无需|不再|不(?=[\u4e00-\u9fff])|\b(?:not|never|no|cannot|can't|won't|didn't|doesn't|isn't|wasn't|don't|without)\b/gi

function markerText(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/[‘’]/g, "'")
    .replace(/^\s*(?:`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/^\s*(?:>\s*)?(?:[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^(?:#{1,6})\s+/gm, '').replace(/[*_`~]/g, '')
    .replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/g, '$1 $2 $3')
}
function numeral(value) {
  const percent = value.endsWith('%') ? '%' : ''
  let text = value.replace(/%$/, '').replace(/,/g, '').replace(/^\+/, '')
  let sign = ''
  if (text.startsWith('-')) { sign = '-'; text = text.slice(1) }
  const [integer, fraction = ''] = text.split('.')
  const whole = integer.replace(/^0+(?=\d)/, ''), decimal = fraction.replace(/0+$/, '')
  return sign + whole + (decimal ? '.' + decimal : '') + percent
}
function chineseNumber(text) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 }
  if (![...text].some((char) => units[char])) return [...text].map((char) => digits[char]).join('').replace(/^0+(?=\d)/, '')
  let total = 0, section = 0, digit = 0
  for (const char of text) {
    if (digits[char] !== undefined) { digit = digits[char]; continue }
    const unit = units[char]
    if (unit < 10000) { section += (digit || 1) * unit; digit = 0 }
    else {
      if (unit === 100000000) total = (total + section + digit) * unit
      else total += (section + digit) * unit
      section = 0; digit = 0
    }
  }
  return String(total + section + digit)
}
function numbers(value) {
  const result = new Map()
  const add = (token) => result.set(token, (result.get(token) || 0) + 1)
  const source = value.replace(/[零〇一二两三四五六七八九十百千万亿]+(?=\s*(?:元|次|天|年|月|日|个|份|张|小时|分钟|公里|米|人|项|条))/g, (token) => chineseNumber(token))
  for (const match of source.matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g)) add(numeral(match[0]))
  return result
}
function countAndRemove(value, pattern) {
  let count = 0
  const text = value.replace(pattern, () => { count++; return ' ' })
  return { count, text }
}
function inspectFidelity(original, candidate) {
  let before = markerText(original), after = markerText(candidate)
  const findings = [], originalNumbers = numbers(before), outputNumbers = numbers(after)
  const changedNumbers = [...new Set([...originalNumbers.keys(), ...outputNumbers.keys()])].filter((number) => (originalNumbers.get(number) || 0) !== (outputNumbers.get(number) || 0))
  if (changedNumbers.length) findings.push({ kind: 'number', label: '数字', changeCount: changedNumbers.length,
    changes: changedNumbers.slice(0, 64).map((value) => ({ value, originalCount: originalNumbers.get(value) || 0, candidateCount: outputNumbers.get(value) || 0 })) })
  // Remove complete uncertainty phrases first so "不确定" and "not sure" do
  // not also count as a negated fact. Synonyms within a group are allowed.
  for (const rule of uncertainty.slice().reverse()) {
    const left = countAndRemove(before, rule.pattern), right = countAndRemove(after, rule.pattern)
    before = left.text; after = right.text
    if (left.count !== right.count) findings.push({ kind: rule.kind, label: rule.label, originalCount: left.count, candidateCount: right.count })
  }
  const rhetorical = /不得不|不仅|不但|不妨|不过|不错/g
  const left = countAndRemove(before.replace(rhetorical, ''), negative), right = countAndRemove(after.replace(rhetorical, ''), negative)
  if (left.count !== right.count) findings.push({ kind: 'negation', label: '否定表述', originalCount: left.count, candidateCount: right.count })
  return { policy: POLICY, status: findings.length ? 'needs_review' : 'markers_unchanged', findings }
}
function assertCapacity(value, limit = 150000) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) throw Object.assign(new Error('整理结果过长，原文已保留'), { code: 'AI_OUTPUT_CAPACITY' })
}
function assertFidelity(original, candidate, options = {}) {
  assertCapacity(String(candidate), options.aggregate ? 800000 : 150000)
  const review = inspectFidelity(original, candidate)
  const retained = { ...review, candidate: String(options.candidateForReview ?? candidate),
    ...(options.aggregate ? { checkedScope: 'assembled', candidateScope: 'last_segment', precedingReceiptsRequired: true } : {}) }
  assertCapacity(retained)
  if (review.findings.length) throw Object.assign(new Error(`整理稿的${review.findings.map((item) => item.label).join('、')}可能改变原意，未采用该整理稿；原文已保留，请核对后手动重试`), {
    code: 'AI_FIDELITY_REVIEW', fidelityReview: retained
  })
  return review
}
function diaryBody(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n'), result = []
  let fence = null
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null
    } else if (!fence && /^##\s+今日补充\s*$/.test(line)) break
    if (!fence && /^##\s+今日记录\s*$/.test(line)) continue
    result.push(line)
  }
  return result.join('\n')
}
function assertDiaryFidelity(inputs, candidate, options = {}) {
  assertCapacity(String(candidate), options.aggregate ? 800000 : 150000)
  if (!(inputs || []).some((input) => String(input.content || '').trim())) return { policy: POLICY, status: 'no_original', findings: [] }
  try {
    return assertFidelity(inputs.map((input) => String(input.content || '')).join('\n\n'), diaryBody(candidate), options)
  } catch (error) {
    if (error.code === 'AI_FIDELITY_REVIEW') {
      error.fidelityReview = { ...error.fidelityReview, candidate: String(options.candidateForReview ?? candidate), checkedScope: options.aggregate ? 'assembled_diary_body' : 'diary_body' }
      assertCapacity(error.fidelityReview)
    }
    throw error
  }
}
module.exports = { POLICY, inspectFidelity, assertFidelity, diaryBody, assertDiaryFidelity }
