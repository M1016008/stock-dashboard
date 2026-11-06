import fs from 'node:fs'
import path from 'node:path'

// Moves a closed SQLite database out of its normal path and back, within one
// directory, without ever replacing an existing entry. Both directions are
// link-before-unlink: an existing target fails with EEXIST instead of being
// overwritten (rename(2) would replace it), and a crash between the two steps
// leaves both names on the same inode. Every step re-checks the exact dev and
// inode. Nothing is retried; on any error the files stay where they are for a
// separately approved recovery.
export type SameDirectoryQuarantine = Readonly<{
  originalPath: string
  quarantinedPath: string
  dev: number
  inode: number
}>

const COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

// lstat, not exists: a dangling symlink companion also fails.
function assertNoCompanions(file: string): void {
  for (const suffix of COMPANION_SUFFIXES) {
    if (fs.lstatSync(`${file}${suffix}`, { throwIfNoEntry: false })) {
      throw new Error(`QUARANTINE_COMPANION_PRESENT:${file}${suffix}`)
    }
  }
}

function assertIdentity(file: string, expected: SameDirectoryQuarantine, links: number): void {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || Number(stat.dev) !== expected.dev || Number(stat.ino) !== expected.inode) {
    throw new Error(`QUARANTINE_IDENTITY_MISMATCH:${file}`)
  }
  if (stat.nlink !== links) throw new Error(`QUARANTINE_LINK_COUNT_MISMATCH:${file}:${stat.nlink}`)
}

function assertSameRealDirectory(quarantine: SameDirectoryQuarantine): string {
  const directory = path.dirname(quarantine.originalPath)
  if (!path.isAbsolute(quarantine.originalPath) || !path.isAbsolute(quarantine.quarantinedPath)
      || path.dirname(quarantine.quarantinedPath) !== directory
      || quarantine.originalPath === quarantine.quarantinedPath) {
    throw new Error('QUARANTINE_NOT_SAME_DIRECTORY')
  }
  if (fs.realpathSync(directory) !== directory) throw new Error('QUARANTINE_DIRECTORY_NOT_REALPATH')
  return directory
}

export function quarantineInSameDirectory(args: SameDirectoryQuarantine): SameDirectoryQuarantine {
  const quarantine = { ...args }
  const directory = assertSameRealDirectory(quarantine)
  assertNoCompanions(quarantine.originalPath)
  assertNoCompanions(quarantine.quarantinedPath)
  assertIdentity(quarantine.originalPath, quarantine, 1)
  fs.linkSync(quarantine.originalPath, quarantine.quarantinedPath)
  syncDirectory(directory)
  assertIdentity(quarantine.quarantinedPath, quarantine, 2)
  fs.unlinkSync(quarantine.originalPath)
  syncDirectory(directory)
  assertIdentity(quarantine.quarantinedPath, quarantine, 1)
  return quarantine
}

// Anything that recreated the original path (a stray open of the normal path
// creates an empty database) makes the restore fail with EEXIST.
export function restoreFromSameDirectoryQuarantine(quarantine: SameDirectoryQuarantine): void {
  const directory = assertSameRealDirectory(quarantine)
  assertNoCompanions(quarantine.quarantinedPath)
  assertNoCompanions(quarantine.originalPath)
  assertIdentity(quarantine.quarantinedPath, quarantine, 1)
  fs.linkSync(quarantine.quarantinedPath, quarantine.originalPath)
  syncDirectory(directory)
  assertIdentity(quarantine.originalPath, quarantine, 2)
  fs.unlinkSync(quarantine.quarantinedPath)
  syncDirectory(directory)
  assertIdentity(quarantine.originalPath, quarantine, 1)
}
