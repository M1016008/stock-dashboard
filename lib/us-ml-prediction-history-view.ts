export function selectUsPredictionHistoryRows<T extends { outcome: unknown | null }>(
  rows: readonly T[],
  limit = 4,
): T[] {
  const completed = rows.filter((row) => row.outcome != null)
  const pending = rows.filter((row) => row.outcome == null)
  if (completed.length === 0 || pending.length === 0) return rows.slice(0, limit)

  const pendingCount = Math.min(
    pending.length,
    Math.max(Math.ceil(limit / 2), limit - completed.length),
  )
  const completedCount = Math.min(completed.length, limit - pendingCount)
  const chosen = new Set([
    ...pending.slice(0, pendingCount),
    ...completed.slice(0, completedCount),
  ])
  return rows.filter((row) => chosen.has(row))
}
