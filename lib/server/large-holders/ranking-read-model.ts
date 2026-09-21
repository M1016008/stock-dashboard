// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { LARGE_HOLDER_DISCLAIMER, POSITION_FINGERPRINT_SQL, type HoldingBasis, type HolderActivity,
  type InvestorClass, type InvestorSummary, type RankingSnapshot } from '@/lib/large-holders/ranking-core'

let cached: { path: string; snapshot: RankingSnapshot } | null = null
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

export class RankingUnavailable extends Error {
  constructor(public readonly reason: string) { super(reason) }
}

export async function getRankingSnapshot(): Promise<RankingSnapshot> {
  const path = process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH
  const dbPath = process.env.STOCKBOARD_DB_PATH
  if (!path || !dbPath) throw new RankingUnavailable('certified_snapshot_not_configured')
  if (!cached || cached.path !== path) {
    const bytes = await readFile(path).catch(() => { throw new RankingUnavailable('certified_snapshot_missing') })
    if (basename(path) !== `${sha256(bytes)}.json`) throw new RankingUnavailable('snapshot_digest_mismatch')
    const snapshot = JSON.parse(bytes.toString('utf8')) as RankingSnapshot
    if (snapshot.version !== 1 || snapshot.publicCurrentValuationReadyCount < 20
      || snapshot.certificationAsOf !== snapshot.priceDate
      || snapshot.investors.reduce((n, investor) => n + investor.positions.length, 0) !== snapshot.currentPositionCount
      || snapshot.investors.reduce((n, investor) => n + investor.valuedPositionCount, 0)
        !== snapshot.publicCurrentValuationReadyCount) throw new RankingUnavailable('snapshot_contract_invalid')
    cached = { path, snapshot }
  }
  // Three indexed/small-table reads fail closed as soon as a newer disclosure or market date arrives.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try {
    const filing = db.prepare(`SELECT COUNT(*) count,MAX(imported_at) maxImportedAt,
      MAX(submitted_at) maxSubmittedAt FROM large_holder_filings`).get() as Record<string, unknown>
    const price = db.prepare('SELECT MAX(price_date) d FROM large_holder_price_evidence').get() as Record<string, unknown>
    const market = db.prepare('SELECT MAX(date) d FROM ohlcv_daily').get() as Record<string, unknown>
    const positionFingerprint = sha256(JSON.stringify(db.prepare(POSITION_FINGERPRINT_SQL).all()))
    const snapshot = cached.snapshot
    if (Number(filing.count) !== snapshot.filingWatermark.count
      || Number(filing.maxImportedAt ?? 0) !== Number(snapshot.filingWatermark.maxImportedAt ?? 0)
      || String(filing.maxSubmittedAt ?? '') !== String(snapshot.filingWatermark.maxSubmittedAt ?? '')
      || String(price.d ?? '') !== snapshot.priceDate || String(market.d ?? '') !== snapshot.priceDate
      || positionFingerprint !== snapshot.positionFingerprintSha256)
      throw new RankingUnavailable('certified_snapshot_stale')
    return snapshot
  } finally { db.close() }
}

export function responseMeta(snapshot: RankingSnapshot) {
  return { certificationAsOf: snapshot.certificationAsOf,
    valuationManifestSha256: snapshot.manifestSha256,
    activityEvidenceManifestSha256: snapshot.activityEvidenceManifestSha256,
    latestEdinetDataAt: snapshot.latestEdinetDataAt,
    latestPositionDate: snapshot.latestPositionDate, priceDate: snapshot.priceDate,
    publicCurrentValuationReadyCount: snapshot.publicCurrentValuationReadyCount,
    currentPositionCount: snapshot.currentPositionCount,
    entityBasis: true, ...LARGE_HOLDER_DISCLAIMER }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof Error && /^invalid_(?:[A-Za-z0-9]+|pagination)$/.test(error.message))
    return Response.json({ error: error.message }, { status: 400 })
  if (error instanceof RankingUnavailable) return Response.json({ error: error.reason }, { status: 503 })
  console.error('large_holder_read_model_failed', error)
  return Response.json({ error: 'large_holder_read_model_unavailable' }, { status: 503 })
}

export function enumParam<T extends string>(params: URLSearchParams, key: string,
  allowed: readonly T[], fallback: T): T {
  const value = params.get(key)
  if (!value) return fallback
  if (!allowed.includes(value as T)) throw new Error(`invalid_${key}`)
  return value as T
}

export function paging(params: URLSearchParams): { page: number; pageSize: number } {
  const page = Number(params.get('page') ?? 1), pageSize = Number(params.get('pageSize') ?? 50)
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize)
    || pageSize < 1 || pageSize > 100) throw new Error('invalid_pagination')
  return { page, pageSize }
}

export function paginate<T>(rows: T[], page: number, pageSize: number) {
  return { total: rows.length, page, pageSize, totalPages: Math.ceil(rows.length / pageSize),
    rows: rows.slice((page - 1) * pageSize, page * pageSize) }
}

export function investorClassFilter(investor: InvestorSummary, selected: 'ALL' | InvestorClass) {
  return selected === 'ALL' || investor.investorClass === selected
}

export function basisValue(investor: InvestorSummary, basis: HoldingBasis): number | null {
  if (basis === 'OWNERSHIP') return investor.ownershipEstimatedValue
  if (basis === 'INVESTMENT_AUTHORITY') return investor.investmentAuthorityEstimatedValue
  if (basis === 'VOTING_AUTHORITY') return investor.votingAuthorityEstimatedValue
  return investor.otherEstimatedValue
}

export function withinPeriod(activity: HolderActivity, asOf: string, period: '7D' | '30D' | '90D' | '1Y') {
  const days = { '7D': 7, '30D': 30, '90D': 90, '1Y': 365 }[period]
  const from = new Date(`${asOf}T00:00:00Z`)
  from.setUTCDate(from.getUTCDate() - days + 1)
  return activity.obligationDate >= from.toISOString().slice(0, 10)
    && activity.obligationDate <= asOf
}
