export function sourceReadThrottleDelayMs(args: {
  logicalBytesRead: number
  elapsedMs: number
  maximumBytesPerSecond: number
}): number {
  if (!Number.isFinite(args.logicalBytesRead) || args.logicalBytesRead < 0
    || !Number.isFinite(args.elapsedMs) || args.elapsedMs < 0
    || !Number.isFinite(args.maximumBytesPerSecond) || args.maximumBytesPerSecond <= 0) {
    throw new Error('INVALID_SOURCE_READ_RATE_INPUT')
  }
  const minimumElapsedMs = args.logicalBytesRead / args.maximumBytesPerSecond * 1_000
  return Math.max(0, Math.ceil(minimumElapsedMs - args.elapsedMs))
}
