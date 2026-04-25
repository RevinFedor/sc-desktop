// Token / size formatter shared across copy-actions.
//
// We don't tokenize on the client (no real BPE here). Heuristic: bytes/3
// averages out for mixed RU/EN content — close enough for "до клика юзер
// понимает порядок размера". Always rendered with "~" prefix so we never
// imply precision we can't deliver.

export function formatTokens(n) {
  if (!n || n < 1000) return String(n || 0)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Same heuristic as CopySavedPanel: bytes / 3 ≈ tokens. The IPC `copyFile`
// returns content length in chars, which on UTF-8 averages roughly the same
// for mixed RU/EN.
export function tokensFromBytes(bytes) {
  if (!bytes || bytes < 1) return 0
  return Math.round(bytes / 3)
}

// One-line label suitable for the "✓ Скопировано · ~12.4k токенов · 38 KB"
// confirmation text shown right after a successful copy.
export function formatCopyToast({ bytes, count, tokens }) {
  const t = tokens != null ? tokens : tokensFromBytes(bytes)
  const tokenStr = t > 0 ? ` · ~${formatTokens(t)} токенов` : ''
  const sizeStr  = bytes ? ` · ${formatBytes(bytes)}` : ''
  const countStr = count > 1 ? ` (${count})` : ''
  return `Скопировано${countStr}${tokenStr}${sizeStr}`
}
