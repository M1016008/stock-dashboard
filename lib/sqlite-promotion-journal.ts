import fs from 'node:fs'
import path from 'node:path'
import { OperatorActionRequiredError } from '@/lib/operational-exit'
import { removeDurableFile, writeDurableJson } from '@/lib/durable-json-file'

export type SqlitePromotionPlan = {
  primaryPath: string
  shadowPath: string
  backupPath: string
}

export type SqlitePromotionJournal = {
  version: 1
  transactionId: string
  phase: 'prepared' | 'analog-promoted' | 'analytics-promoted' | 'compensation-failed'
  createdAt: string
  updatedAt: string
  analog: SqlitePromotionPlan | null
  analytics: SqlitePromotionPlan
  error: string | null
}

export function resolveSqlitePromotionJournalPath(
  analyticsDbPath: string,
  priceBasis: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configuredJournal = env.US_ADJUSTED_FOUNDATION_PROMOTION_JOURNAL_PATH?.trim()
  if (configuredJournal) return path.resolve(configuredJournal)
  const configuredShadow = env.US_ADJUSTED_FOUNDATION_SHADOW_PATH?.trim()
  const shadowPath = configuredShadow
    ? path.resolve(configuredShadow)
    : `${path.resolve(analyticsDbPath)}.${priceBasis}.building`
  return `${shadowPath}.promotion-journal.json`
}

export function resolveWeeklyMlPromotionJournalPath(analyticsDbPath: string): string {
  return `${path.resolve(analyticsDbPath)}.weekly-ml.building.promotion-journal.json`
}

export function writeSqlitePromotionJournal(
  journalPath: string,
  journal: SqlitePromotionJournal,
): void {
  writeDurableJson(journalPath, journal)
}

export function removeSqlitePromotionJournal(journalPath: string): void {
  removeDurableFile(journalPath)
}

export function promotionRecoveryMessage(
  journalPath: string,
  journal: SqlitePromotionJournal,
): string {
  const phaseMeaning: Record<SqlitePromotionJournal['phase'], string> = {
    prepared: 'replacement may or may not have occurred; inspect primary and shadow before recovery',
    'analog-promoted': 'Analog may be new while analytics remains old',
    'analytics-promoted': 'both rename steps were journaled but final journal removal is unconfirmed',
    'compensation-failed': 'the live Analog/analytics pair is uncertain after failed compensation',
  }
  const plans = [journal.analog, journal.analytics]
    .filter((plan): plan is SqlitePromotionPlan => plan != null)
    .map((plan) => `primary=${plan.primaryPath}, shadow=${plan.shadowPath}, backup=${plan.backupPath}`)
    .join(' | ')
  return `US adjusted foundation promotion requires operator review; `
    + `journal=${journalPath}, transaction=${journal.transactionId}, phase=${journal.phase} `
    + `(${phaseMeaning[journal.phase]}), error=${journal.error ?? 'none'}, ${plans}. `
    + 'Inspect every primary/shadow/backup DB/WAL/SHM member read-only and obtain explicit recovery '
    + 'approval. Do not remove the journal, retry promotion, or adopt a generation meanwhile.'
}

function isPromotionPlan(value: unknown): value is SqlitePromotionPlan {
  if (value == null || typeof value !== 'object') return false
  const plan = value as Partial<SqlitePromotionPlan>
  return typeof plan.primaryPath === 'string'
    && typeof plan.shadowPath === 'string'
    && typeof plan.backupPath === 'string'
}

function parsePromotionJournal(raw: string): SqlitePromotionJournal {
  const value: unknown = JSON.parse(raw)
  if (value == null || typeof value !== 'object') throw new Error('journal must be an object')
  const journal = value as Partial<SqlitePromotionJournal>
  const validPhase = journal.phase === 'prepared'
    || journal.phase === 'analog-promoted'
    || journal.phase === 'analytics-promoted'
    || journal.phase === 'compensation-failed'
  if (
    journal.version !== 1
    || typeof journal.transactionId !== 'string'
    || !validPhase
    || typeof journal.createdAt !== 'string'
    || typeof journal.updatedAt !== 'string'
    || (journal.analog != null && !isPromotionPlan(journal.analog))
    || !isPromotionPlan(journal.analytics)
    || (journal.error != null && typeof journal.error !== 'string')
  ) {
    throw new Error('journal schema is invalid')
  }
  return journal as SqlitePromotionJournal
}

export function assertNoIncompleteSqlitePromotion(journalPath: string): void {
  if (!fs.existsSync(journalPath)) return
  let journal: SqlitePromotionJournal
  try {
    journal = parsePromotionJournal(fs.readFileSync(journalPath, 'utf8'))
  } catch (error) {
    throw new OperatorActionRequiredError(
      `US adjusted foundation promotion journal is unreadable; journal=${journalPath}. `
      + 'Do not publish or delete any primary, shadow, or backup generation.',
      { cause: error },
    )
  }
  throw new OperatorActionRequiredError(promotionRecoveryMessage(journalPath, journal))
}
