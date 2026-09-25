import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { sha256 } from '@/lib/large-holders/evidence-provenance'
import { applyReviewDecisions, type ReviewDecision } from '@/lib/large-holders/entity-review'
import type { RankingSnapshot } from '@/lib/large-holders/ranking-core'
import { guardForDatabase, requiresExternalStorageGuard } from '@/lib/storage/external-storage-guard'

type Line = { sequence: number; previousHash: string; decision: ReviewDecision; hash: string }
const zero = '0'.repeat(64)
const defaultPath = join(homedir(), 'Library', 'Application Support', 'StockBoard',
  'large-holder-operations', 'entity-review.ndjson')
export const reviewLedgerPath = () => process.env.LARGE_HOLDER_REVIEW_LEDGER_PATH ?? defaultPath

export async function readReviewLedger(path = reviewLedgerPath()): Promise<ReviewDecision[]> {
  const text = await readFile(path, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  if (text && !text.endsWith('\n')) throw new Error('review_ledger_incomplete')
  let previousHash = zero
  return text.split('\n').filter(Boolean).map((textLine, index) => {
    const row = JSON.parse(textLine) as Line
    const hash = sha256(JSON.stringify({ sequence: row.sequence,
      previousHash: row.previousHash, decision: row.decision }))
    if (row.sequence !== index + 1 || row.previousHash !== previousHash || row.hash !== hash)
      throw new Error('review_ledger_integrity_failed')
    previousHash = row.hash
    return row.decision
  })
}

export async function appendReviewDecision(snapshot: RankingSnapshot, decision: ReviewDecision,
  path = reviewLedgerPath()): Promise<{ count: number; reviewHash: string }> {
  const dbPath = process.env.STOCKBOARD_DB_PATH
  if (!dbPath) throw new Error('STOCKBOARD_DB_PATH required')
  if (requiresExternalStorageGuard(dbPath)) guardForDatabase(dbPath).assertWritable(true)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const lockPath = `${path}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    const prior = await readReviewLedger(path)
    const next = [...prior, decision]
    applyReviewDecisions(snapshot, next)
    const previousHash = prior.length ? sha256(JSON.stringify({ sequence: prior.length,
      previousHash: await previousLineHash(path, prior.length - 1), decision: prior.at(-1) })) : zero
    const row = { sequence: next.length, previousHash, decision }
    const line: Line = { ...row, hash: sha256(JSON.stringify(row)) }
    await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    return { count: next.length, reviewHash: sha256(JSON.stringify(next)) }
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

async function previousLineHash(path: string, index: number): Promise<string> {
  if (index === 0) return zero
  const text = await readFile(path, 'utf8')
  const row = JSON.parse(text.split('\n')[index - 1]) as Line
  return row.hash
}
