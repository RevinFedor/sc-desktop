function boundedTail(items, project, { maxCount = 120, maxBytes = 64 * 1024 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return []
  const selected = []
  let bytes = 2
  const start = Math.max(0, items.length - maxCount)
  for (let index = items.length - 1; index >= start; index--) {
    const row = project(items[index])
    let rowBytes = 0
    try { rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1 } catch {}
    if (selected.length > 0 && bytes + rowBytes > maxBytes) break
    selected.push(row)
    bytes += rowBytes
  }
  return selected
}

module.exports = { boundedTail }
