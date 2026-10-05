function persistableRows(todos = [], completed = []) {
  return [...(todos || []), ...(completed || [])]
}

function mergeVisibleState(cached = {}, todos = [], completed = []) {
  const base = cached && !Array.isArray(cached) ? cached : {}
  return {
    ...base,
    todos: persistableRows(todos, completed)
  }
}

module.exports = { persistableRows, mergeVisibleState }
