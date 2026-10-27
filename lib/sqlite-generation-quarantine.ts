import fs from 'node:fs'
import { removeDurableFile, writeDurableJson } from '@/lib/durable-json-file'
import { OperatorActionRequiredError } from '@/lib/operational-exit'

const SQLITE_GENERATION_SUFFIXES = ['', '-wal', '-shm'] as const

type QuarantineMember = {
  source: string
  destination: string
}

type QuarantineJournal = {
  version: 1
  dbPath: string
  quarantinePath: string
  createdAt: string
  members: QuarantineMember[]
}

function parseQuarantineJournal(raw: string): QuarantineJournal {
  const value: unknown = JSON.parse(raw)
  if (value == null || typeof value !== 'object') throw new Error('journal must be an object')
  const journal = value as Partial<QuarantineJournal>
  if (
    journal.version !== 1
    || typeof journal.dbPath !== 'string'
    || typeof journal.quarantinePath !== 'string'
    || typeof journal.createdAt !== 'string'
    || !Array.isArray(journal.members)
    || journal.members.some((member) => (
      member == null
      || typeof member !== 'object'
      || typeof (member as Partial<QuarantineMember>).source !== 'string'
      || typeof (member as Partial<QuarantineMember>).destination !== 'string'
    ))
  ) {
    throw new Error('journal schema is invalid')
  }
  return journal as QuarantineJournal
}

export function sqliteQuarantineJournalPath(dbPath: string): string {
  return `${dbPath}.quarantine-journal.json`
}

function readJournal(journalPath: string): QuarantineJournal {
  try {
    return parseQuarantineJournal(fs.readFileSync(journalPath, 'utf8'))
  } catch (error) {
    throw new OperatorActionRequiredError(
      `SQLite quarantine journal is unreadable: ${journalPath}`,
      { cause: error },
    )
  }
}

export function recoverInterruptedSqliteQuarantine(dbPath: string): void {
  const journalPath = sqliteQuarantineJournalPath(dbPath)
  if (!fs.existsSync(journalPath)) return
  const journal = readJournal(journalPath)
  const moved: QuarantineMember[] = []
  for (const member of journal.members) {
    const sourceExists = fs.existsSync(member.source)
    const destinationExists = fs.existsSync(member.destination)
    if (sourceExists === destinationExists) {
      const ambiguity = sourceExists
        ? 'both source and quarantine members exist'
        : 'neither source nor quarantine member exists'
      throw new OperatorActionRequiredError(
        `SQLite quarantine recovery is ambiguous; journal=${journalPath}, `
        + `source=${member.source} exists=${sourceExists}, `
        + `destination=${member.destination} exists=${destinationExists}; ${ambiguity}. `
        + 'Inspect every recorded DB/WAL/SHM member read-only and obtain explicit recovery approval. '
        + 'Do not open, delete, or retry the generation meanwhile.',
      )
    }
    if (destinationExists) moved.push(member)
  }

  try {
    for (const member of moved.reverse()) {
      fs.renameSync(member.destination, member.source)
    }
    removeDurableFile(journalPath)
  } catch (error) {
    throw new OperatorActionRequiredError(
      `SQLite quarantine recovery failed; journal=${journalPath}. `
      + 'The DB/WAL/SHM family must remain isolated for operator review.',
      { cause: error },
    )
  }
}

export function quarantineSqliteGeneration(
  dbPath: string,
  quarantinePath: string,
): string | null {
  recoverInterruptedSqliteQuarantine(dbPath)
  const members = SQLITE_GENERATION_SUFFIXES
    .map((suffix) => ({
      source: `${dbPath}${suffix}`,
      destination: `${quarantinePath}${suffix}`,
    }))
    .filter(({ source }) => fs.existsSync(source))
  if (members.length === 0) return null

  for (const { destination } of members) {
    if (fs.existsSync(destination)) {
      throw new Error(`SQLite quarantine target already exists: ${destination}`)
    }
  }

  const journalPath = sqliteQuarantineJournalPath(dbPath)
  const journal: QuarantineJournal = {
    version: 1,
    dbPath,
    quarantinePath,
    createdAt: new Date().toISOString(),
    members,
  }
  writeDurableJson(journalPath, journal)

  try {
    for (const member of members) fs.renameSync(member.source, member.destination)
    removeDurableFile(journalPath)
  } catch (error) {
    try {
      recoverInterruptedSqliteQuarantine(dbPath)
    } catch (recoveryError) {
      throw new OperatorActionRequiredError(
        `SQLite quarantine failed and recovery is incomplete; journal=${journalPath}`,
        { cause: recoveryError },
      )
    }
    throw error
  }
  return quarantinePath
}
