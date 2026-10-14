export const US_UNIVERSE_ACTIVE_WINDOW_DAYS = 14

export function usUniverseActivityCutoff(reference = new Date()): string {
  const cutoff = new Date(reference.getTime() - US_UNIVERSE_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  if (
    cutoff.getUTCHours() !== 0
    || cutoff.getUTCMinutes() !== 0
    || cutoff.getUTCSeconds() !== 0
    || cutoff.getUTCMilliseconds() !== 0
  ) {
    cutoff.setUTCDate(cutoff.getUTCDate() + 1)
  }
  return cutoff.toISOString().slice(0, 10)
}

export function isUsUniverseActive(
  endDate: string | null | undefined,
  cutoff = usUniverseActivityCutoff(),
): boolean {
  return Boolean(endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate >= cutoff)
}

export function shouldReconcileUsUniverse(options: {
  targeted: boolean
  limit: number
  failed: number
}): boolean {
  return !options.targeted && options.limit === 0 && options.failed === 0
}
