import { acquireExclusiveUpdateLock } from '@/lib/server/update-lock'

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

async function main(): Promise<void> {
  const jobType = process.env.STOCKBOARD_LOCK_HOLDER_JOB_TYPE?.trim() || 'db_maintenance'
  if (jobType !== 'db_maintenance') throw new Error(`unsupported lock holder job type: ${jobType}`)
  const leaseSeconds = positiveInteger('STOCKBOARD_LOCK_HOLDER_LEASE_SECONDS', 6 * 60 * 60)
  const heartbeatMs = Math.min(
    positiveInteger('STOCKBOARD_LOCK_HOLDER_HEARTBEAT_MS', 10 * 60_000),
    Math.floor(leaseSeconds * 1_000 / 3),
  )
  const lock = await acquireExclusiveUpdateLock(jobType, leaseSeconds)
  if (!lock) throw new Error(`${jobType} is already active`)

  let rejectHeartbeat: (error: unknown) => void = () => undefined
  const heartbeatFailed = new Promise<never>((_resolve, reject) => { rejectHeartbeat = reject })
  const heartbeat = setInterval(() => {
    void lock.heartbeat().catch(rejectHeartbeat)
  }, heartbeatMs)
  process.stdout.write(`${JSON.stringify({ status: 'LOCKED', jobType, owner: lock.owner })}\n`)

  let releaseRequested = false
  let resolveRelease: () => void = () => undefined
  const requestedRelease = new Promise<void>((resolve) => { resolveRelease = resolve })
  const parentPipeClosed = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
  })
  try {
    process.stdin.resume()
    let input = ''
    process.stdin.on('data', (chunk: Buffer) => {
      input += chunk.toString()
      if (!releaseRequested && input.split('\n').some((line) => line.trim() === 'RELEASE')) {
        releaseRequested = true
        resolveRelease()
      }
    })
    await Promise.race([requestedRelease, parentPipeClosed, heartbeatFailed])
  } finally {
    clearInterval(heartbeat)
    process.stdin.pause()
    // Parent exit or pipe closure is not a release authorization. Only the
    // explicit protocol message may make the lease idle.
    if (releaseRequested) await lock.release()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
