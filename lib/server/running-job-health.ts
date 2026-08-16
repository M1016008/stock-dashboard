type RunningJobCandidate = {
  jobType: string
  startedAt: number
  payloadJson?: string | null
}

const PROCESS_HINTS: Array<[RegExp, string[]]> = [
  [/^physical_momentum_/i, ['batch-physical-momentum']],
  [/^forward_extrema(?:_|$)/i, ['batch-forward-extrema']],
  [/^ml_learning(?:_|$)/i, ['run-ml-learning']],
  [/^us_adjusted_foundation(?:_|$)/i, ['us-adjusted-foundation', 'build-us-adjusted']],
  [/^snapshot_compute(?:_|$)/i, ['build-us-snapshots']],
]

function recentHeartbeat(payloadJson: string | null | undefined, nowMs: number, graceMs: number): boolean {
  if (!payloadJson) return false
  try {
    const payload = JSON.parse(payloadJson) as { heartbeatAt?: unknown }
    if (typeof payload.heartbeatAt !== 'string') return false
    const heartbeatAt = Date.parse(payload.heartbeatAt)
    return Number.isFinite(heartbeatAt) && nowMs - heartbeatAt <= graceMs
  } catch {
    return false
  }
}

export function runningJobIsVisible(
  job: RunningJobCandidate,
  processText: string | null,
  nowMs = Date.now(),
  graceMs = 15 * 60 * 1_000,
): boolean {
  const hints = PROCESS_HINTS.find(([pattern]) => pattern.test(job.jobType))?.[1]
  if (hints && processText != null) {
    const normalizedProcesses = processText.toLowerCase()
    return hints.some((hint) => normalizedProcesses.includes(hint))
  }

  if (nowMs - job.startedAt * 1_000 <= graceMs) return true
  if (recentHeartbeat(job.payloadJson, nowMs, graceMs)) return true
  if (!hints || processText == null) return true
  return false
}
