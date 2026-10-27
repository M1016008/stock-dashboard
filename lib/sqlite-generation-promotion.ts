import fs from 'node:fs'

export type SqliteGenerationPromotion = {
  primaryPath: string
  shadowPath: string
  backupPath: string | null
}

type PromoteOptions = {
  primaryPath: string
  shadowPath: string
  backupPath: string
  checkpoint: (dbPath: string) => Promise<void>
  clone: (source: string, target: string) => void
  beforeReplace?: () => void
}

function moveIfPresent(from: string, to: string): void {
  if (fs.existsSync(from)) fs.renameSync(from, to)
}

export async function promoteSqliteGeneration(
  options: PromoteOptions,
): Promise<SqliteGenerationPromotion> {
  const { primaryPath, shadowPath, backupPath, checkpoint, clone, beforeReplace } = options
  if (!fs.existsSync(shadowPath)) {
    throw new Error(`SQLite shadow generation not found: ${shadowPath}`)
  }
  if (fs.existsSync(primaryPath)) await checkpoint(primaryPath)
  await checkpoint(shadowPath)

  const retainedBackup = fs.existsSync(primaryPath) ? backupPath : null
  if (retainedBackup) clone(primaryPath, retainedBackup)
  beforeReplace?.()
  if (retainedBackup) {
    moveIfPresent(`${primaryPath}-wal`, `${retainedBackup}-wal`)
    moveIfPresent(`${primaryPath}-shm`, `${retainedBackup}-shm`)
  }
  moveIfPresent(`${shadowPath}-wal`, `${backupPath}.promoted-shadow-wal`)
  moveIfPresent(`${shadowPath}-shm`, `${backupPath}.promoted-shadow-shm`)
  fs.renameSync(shadowPath, primaryPath)
  return { primaryPath, shadowPath, backupPath: retainedBackup }
}

export async function rollbackSqliteGeneration(
  promotion: SqliteGenerationPromotion,
  checkpoint: (dbPath: string) => Promise<void>,
): Promise<void> {
  const { primaryPath, shadowPath, backupPath } = promotion
  if (!fs.existsSync(primaryPath)) {
    throw new Error(`Promoted SQLite generation is missing: ${primaryPath}`)
  }
  if (fs.existsSync(shadowPath)) {
    throw new Error(`Cannot preserve failed promotion; shadow already exists: ${shadowPath}`)
  }

  await checkpoint(primaryPath)
  moveIfPresent(`${primaryPath}-wal`, `${shadowPath}-wal`)
  moveIfPresent(`${primaryPath}-shm`, `${shadowPath}-shm`)
  fs.renameSync(primaryPath, shadowPath)
  if (!backupPath) return

  try {
    fs.renameSync(backupPath, primaryPath)
    moveIfPresent(`${backupPath}-wal`, `${primaryPath}-wal`)
    moveIfPresent(`${backupPath}-shm`, `${primaryPath}-shm`)
  } catch (error) {
    if (!fs.existsSync(primaryPath) && fs.existsSync(shadowPath)) {
      fs.renameSync(shadowPath, primaryPath)
      moveIfPresent(`${shadowPath}-wal`, `${primaryPath}-wal`)
      moveIfPresent(`${shadowPath}-shm`, `${primaryPath}-shm`)
    }
    throw error
  }
}
