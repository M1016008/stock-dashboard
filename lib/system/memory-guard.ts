import { execFileSync } from 'node:child_process'

export type MemoryHeadroom = {
  availableMb: number
  immediateAvailableMb: number
  inactiveMb: number
  compressorMb: number
  freePercent: number | null
  throttledPages: number
}

type WaitOptions = {
  label: string
  minAvailableMb?: number
  minFreePercent?: number
  maxCompressorMb?: number
  maxThrottledPages?: number
  waitSeconds?: number
  pollSeconds?: number
}

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>

const MB = 1024 * 1024

function positiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseVmStatValue(output: string, label: string): number {
  const match = output.match(new RegExp(`${label}:\\s+([0-9]+)\\.`))
  return match ? Number(match[1]) : 0
}

function parseMemoryPressureFreePercent(output: string): number | null {
  const match = output.match(/System-wide memory free percentage:\s+([0-9]+)%/i)
  return match ? Number(match[1]) : null
}

export function readMemoryHeadroom(): MemoryHeadroom | null {
  if (process.platform !== 'darwin') return null
  const output = execFileSync('vm_stat', { encoding: 'utf8' })
  let pressureOutput = ''
  try {
    pressureOutput = execFileSync('memory_pressure', { encoding: 'utf8' })
  } catch {
    pressureOutput = ''
  }
  return parseMacMemoryHeadroom(output, pressureOutput)
}

export function parseMacMemoryHeadroom(output: string, pressureOutput = ''): MemoryHeadroom {
  const pageSizeMatch = output.match(/page size of ([0-9]+) bytes/i)
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16_384

  const free = parseVmStatValue(output, 'Pages free')
  const inactive = parseVmStatValue(output, 'Pages inactive')
  const speculative = parseVmStatValue(output, 'Pages speculative')
  const purgeable = parseVmStatValue(output, 'Pages purgeable')
  const compressor = parseVmStatValue(output, 'Pages occupied by compressor')
  const throttled = parseVmStatValue(output, 'Pages throttled')
  const immediateAvailableMb = ((free + speculative + purgeable) * pageSize) / MB
  const inactiveMb = (inactive * pageSize) / MB

  return {
    // Inactive pages are clean/reclaimable cache on macOS. Excluding them made
    // healthy machines wait forever even when memory_pressure reported ample room.
    availableMb: immediateAvailableMb + inactiveMb,
    immediateAvailableMb,
    inactiveMb,
    compressorMb: (compressor * pageSize) / MB,
    freePercent: pressureOutput ? parseMemoryPressureFreePercent(pressureOutput) : null,
    throttledPages: throttled,
  }
}

function hasEnoughHeadroom(
  headroom: MemoryHeadroom,
  minAvailableMb: number,
  minFreePercent: number,
  maxCompressorMb: number,
  maxThrottledPages: number,
): boolean {
  // memory_pressure is the authoritative current-pressure signal on macOS.
  // Compressor pages can remain high long after pressure has recovered, so use
  // them only when memory_pressure is unavailable.
  const pressureHealthy = headroom.freePercent === null
    ? headroom.compressorMb <= maxCompressorMb
    : minFreePercent === 0 || headroom.freePercent >= minFreePercent
  return (
    (minAvailableMb === 0 || headroom.availableMb >= minAvailableMb)
    && pressureHealthy
    && headroom.throttledPages <= maxThrottledPages
  )
}

function formatHeadroom(headroom: MemoryHeadroom): string {
  const freePercent = headroom.freePercent === null ? 'unknown' : `${headroom.freePercent}%`
  return `reclaimable=${Math.round(headroom.availableMb)}MB, immediate=${Math.round(headroom.immediateAvailableMb)}MB, inactive=${Math.round(headroom.inactiveMb)}MB, free=${freePercent}, compressor=${Math.round(headroom.compressorMb)}MB, throttled=${headroom.throttledPages}`
}

export async function waitForMemoryHeadroom(options: WaitOptions): Promise<void> {
  if (process.env.STOCKBOARD_MEMORY_GUARD === '0') return
  if (process.platform !== 'darwin') return

  const minAvailableMb = options.minAvailableMb
    ?? nonNegativeNumberEnv('STOCKBOARD_MEMORY_MIN_AVAILABLE_MB', 0)
  const minFreePercent = options.minFreePercent
    ?? nonNegativeNumberEnv('STOCKBOARD_MEMORY_MIN_FREE_PERCENT', 20)
  const maxCompressorMb = options.maxCompressorMb
    ?? positiveNumberEnv('STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB', 12_288)
  const maxThrottledPages = options.maxThrottledPages
    ?? nonNegativeNumberEnv('STOCKBOARD_MEMORY_MAX_THROTTLED_PAGES', 0)
  const waitSeconds = options.waitSeconds
    ?? nonNegativeNumberEnv('STOCKBOARD_MEMORY_WAIT_SECONDS', 1_800)
  const pollSeconds = options.pollSeconds
    ?? positiveNumberEnv('STOCKBOARD_MEMORY_POLL_SECONDS', 30)

  const startedAt = Date.now()
  let lastLogAt = 0

  for (;;) {
    const headroom = readMemoryHeadroom()
    if (!headroom) return
    if (hasEnoughHeadroom(headroom, minAvailableMb, minFreePercent, maxCompressorMb, maxThrottledPages)) {
      return
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000)
    const pressureRequirement = headroom.freePercent === null
      ? `compressor<=${maxCompressorMb}MB (memory_pressure unavailable)`
      : `free>=${minFreePercent}%`
    const message = `Memory guard waiting before ${options.label}: ${formatHeadroom(headroom)}; required reclaimable>=${minAvailableMb}MB, ${pressureRequirement}, throttled<=${maxThrottledPages}`
    if (Date.now() - lastLogAt > 60_000) {
      lastLogAt = Date.now()
      console.warn(message)
    }

    if (waitSeconds === 0 || elapsedSeconds >= waitSeconds) {
      throw new Error(`${message}; timed out after ${elapsedSeconds}s`)
    }

    await sleep(Math.min(pollSeconds, Math.max(1, waitSeconds - elapsedSeconds)) * 1_000)
  }
}

export function withMemoryGuardEnv<T extends EnvMap>(env: T, defaultMaxOldSpaceMb = 3_072): T {
  const maxOldSpaceMb = positiveNumberEnv('STOCKBOARD_NODE_MAX_OLD_SPACE_MB', defaultMaxOldSpaceMb)
  const existing = env.NODE_OPTIONS ?? ''
  if (existing.includes('--max-old-space-size')) return env
  return {
    ...env,
    NODE_OPTIONS: `${existing} --max-old-space-size=${maxOldSpaceMb}`.trim(),
  } as T
}
