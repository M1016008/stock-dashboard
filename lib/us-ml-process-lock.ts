import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const US_ML_PROCESS_LOCK_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'StockBoard',
  'us-ml-job.lock',
)

const INVALID_OWNER_GRACE_MS = 60_000

export type UsMlProcessLock = {
  release: () => void
}

function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    return code === 'EPERM'
  }
}

export function acquireUsMlProcessLock(
  mode: string,
  lockPath = US_ML_PROCESS_LOCK_PATH,
): UsMlProcessLock | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
  const ownerContents = `${JSON.stringify({
    pid: process.pid,
    mode,
    owner,
    startedAt: new Date().toISOString(),
  })}\n`

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporaryPath = path.join(
      path.dirname(lockPath),
      `.${path.basename(lockPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    )
    try {
      fs.writeFileSync(temporaryPath, ownerContents, { flag: 'wx', mode: 0o600 })
      fs.linkSync(temporaryPath, lockPath)
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          try {
            const current = JSON.parse(
              fs.readFileSync(lockPath, 'utf8'),
            ) as { owner?: unknown }
            if (current.owner === owner) fs.unlinkSync(lockPath)
          } catch {
            // A missing lock is already released; a different owner is preserved.
          }
        },
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST') throw error
    } finally {
      fs.rmSync(temporaryPath, { force: true })
    }

    let existingRaw = ''
    let modifiedAt = Date.now()
    let existingPid = 0
    let existingMode = 'unknown'
    let parsedOwner = false
    try {
      existingRaw = fs.readFileSync(lockPath, 'utf8')
      modifiedAt = fs.statSync(lockPath).mtimeMs
      const existing = JSON.parse(existingRaw) as { pid?: unknown; mode?: unknown }
      existingPid = Number(existing.pid)
      existingMode = String(existing.mode ?? 'unknown')
      parsedOwner = Number.isInteger(existingPid) && existingPid > 0
    } catch {
      // A legacy writer may still be publishing the owner record.
    }
    if (pidExists(existingPid)) {
      console.log(
        `US ML ${mode} skipped: another US ML job is active `
        + `(pid=${existingPid}, mode=${existingMode})`,
      )
      return null
    }
    if (!parsedOwner && Date.now() - modifiedAt < INVALID_OWNER_GRACE_MS) {
      console.log(`US ML ${mode} skipped: another lock owner is still being published`)
      return null
    }

    try {
      if (fs.readFileSync(lockPath, 'utf8') === existingRaw) {
        fs.unlinkSync(lockPath)
      }
    } catch {
      // Another contender changed or removed the stale lock; retry acquisition.
    }
  }
  console.log(`US ML ${mode} skipped: process lock could not be acquired safely`)
  return null
}
