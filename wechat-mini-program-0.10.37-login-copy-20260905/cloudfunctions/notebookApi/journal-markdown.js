'use strict'

// A checklist mutation changes only matching checkbox markers. Reconstructing
// the body from title/summary would discard paragraphs, formatting and details.
// Unmatched items remain authoritative in checklistItems; never guess a line.
function updateChecklistMarkdown(markdown, previousItems, nextItems) {
  const nextById = new Map(nextItems.map((item) => [item.id, item]))
  const occurrences = new Map()
  for (const item of previousItems) {
    const text = String(item.text || '').trim()
    if (!occurrences.has(text)) occurrences.set(text, [])
    occurrences.get(text).push(item)
  }
  let fence = null
  return String(markdown || '').replace(/[^\r\n]+/g, (line) => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length }
      else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null
      return line
    }
    if (fence) return line
    const check = line.match(/^( {0,3}(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/)
    if (!check) return line
    const previous = occurrences.get(check[4].trim())?.shift()
    const next = previous && nextById.get(previous.id)
    if (!next || Boolean(previous.done) === Boolean(next.done)) return line
    return check[1] + (next.done ? 'x' : ' ') + check[3] + check[4]
  })
}

module.exports = { updateChecklistMarkdown }
