import fs from 'node:fs'
import path from 'node:path'

export type PidProcessLock = {
  release: () => void
}

const INVALID_OWNER_GRACE_MS = 60_000

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

function installAtomicLock(lockPath: string, contents: string): boolean {
  const temporaryPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  fs.writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
  try {
    fs.linkSync(temporaryPath, lockPath)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code === 'EEXIST') return false
    throw error
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

export function acquirePidProcessLock(
  lockPath: string,
  label: string,
): PidProcessLock | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const ownerContents = `${process.pid}\n`

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (installAtomicLock(lockPath, ownerContents)) {
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          try {
            if (fs.readFileSync(lockPath, 'utf8') === ownerContents) fs.unlinkSync(lockPath)
          } catch {
            // A missing or replaced lock no longer belongs to this process.
          }
        },
      }
    }

    let existingRaw = ''
    let modifiedAt = Date.now()
    try {
      existingRaw = fs.readFileSync(lockPath, 'utf8')
      modifiedAt = fs.statSync(lockPath).mtimeMs
    } catch {
      continue
    }
    const existingPid = Number(existingRaw.trim())
    const validOwnerPid = Number.isInteger(existingPid) && existingPid > 0
    if (pidExists(existingPid)) {
      console.log(`${label} already running (pid=${existingPid}); skipping duplicate.`)
      return null
    }
    if (!validOwnerPid && Date.now() - modifiedAt < INVALID_OWNER_GRACE_MS) {
      console.log(`${label} lock owner is still being published; skipping duplicate.`)
      return null
    }
    try {
      if (fs.readFileSync(lockPath, 'utf8') === existingRaw) fs.unlinkSync(lockPath)
    } catch {
      // Another contender changed or removed the stale lock; retry acquisition.
    }
  }
  console.log(`${label} lock could not be acquired after stale-owner recovery attempts.`)
  return null
}
