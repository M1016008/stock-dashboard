import fs from 'node:fs'
import path from 'node:path'
import { DeferredExecutionError } from '@/lib/operational-exit'

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
  beforeReplace?: () => void | Promise<void>
}

type CheckpointResult = {
  rows?: readonly unknown[]
}

function moveIfPresent(from: string, to: string): void {
  if (fs.existsSync(from)) fs.renameSync(from, to)
}

function assertSameFilesystem(paths: string[]): void {
  const devices = new Set(paths.map((filePath) => fs.statSync(path.dirname(filePath)).dev))
  if (devices.size !== 1) {
    throw new Error(`SQLite promotion paths must share one filesystem: ${paths.join(', ')}`)
  }
}

function fsyncDirectories(paths: string[]): void {
  for (const directory of new Set(paths.map((filePath) => path.dirname(filePath)))) {
    const descriptor = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }
}

function fsyncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

export function assertTruncateCheckpointComplete(result: CheckpointResult, dbPath: string): void {
  const row = result.rows?.[0]
  if (row == null || typeof row !== 'object') {
    throw new Error(`SQLite TRUNCATE checkpoint returned no status for ${dbPath}`)
  }
  const values = Object.values(row)
  const keyed = row as Record<string, unknown>
  const busy = Number(keyed.busy ?? keyed[0] ?? values[0])
  const logFrames = Number(keyed.log ?? keyed[1] ?? values[1])
  const checkpointedFrames = Number(keyed.checkpointed ?? keyed[2] ?? values[2])
  if (![busy, logFrames, checkpointedFrames].every(Number.isFinite)) {
    throw new Error(`SQLite TRUNCATE checkpoint returned an invalid status for ${dbPath}`)
  }
  if (busy !== 0 || checkpointedFrames !== logFrames) {
    throw new DeferredExecutionError(
      `SQLite TRUNCATE checkpoint incomplete for ${dbPath}: `
      + `busy=${busy}, log=${logFrames}, checkpointed=${checkpointedFrames}; `
      + 'defer promotion until readers release the WAL',
    )
  }
}

export async function promoteSqliteGeneration(
  options: PromoteOptions,
): Promise<SqliteGenerationPromotion> {
  const { primaryPath, shadowPath, backupPath, checkpoint, clone, beforeReplace } = options
  if (!fs.existsSync(shadowPath)) {
    throw new Error(`SQLite shadow generation not found: ${shadowPath}`)
  }
  assertSameFilesystem([primaryPath, shadowPath, backupPath])
  if (fs.existsSync(primaryPath)) await checkpoint(primaryPath)
  await checkpoint(shadowPath)

  const retainedBackup = fs.existsSync(primaryPath) ? backupPath : null
  if (retainedBackup) {
    clone(primaryPath, retainedBackup)
    fsyncFile(retainedBackup)
  }
  fsyncFile(shadowPath)
  await beforeReplace?.()
  if (retainedBackup) {
    moveIfPresent(`${primaryPath}-wal`, `${retainedBackup}-wal`)
    moveIfPresent(`${primaryPath}-shm`, `${retainedBackup}-shm`)
  }
  moveIfPresent(`${shadowPath}-wal`, `${backupPath}.promoted-shadow-wal`)
  moveIfPresent(`${shadowPath}-shm`, `${backupPath}.promoted-shadow-shm`)
  fs.renameSync(shadowPath, primaryPath)
  fsyncDirectories([primaryPath, shadowPath, backupPath])
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
  assertSameFilesystem([primaryPath, shadowPath, ...(backupPath ? [backupPath] : [])])

  await checkpoint(primaryPath)
  moveIfPresent(`${primaryPath}-wal`, `${shadowPath}-wal`)
  moveIfPresent(`${primaryPath}-shm`, `${shadowPath}-shm`)
  fs.renameSync(primaryPath, shadowPath)
  if (!backupPath) {
    fsyncDirectories([primaryPath, shadowPath])
    return
  }

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
  fsyncDirectories([primaryPath, shadowPath, backupPath])
}
