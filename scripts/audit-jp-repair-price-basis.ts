import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import {
  fetchJQuantsDailyProviderRowsByDate,
  fetchJQuantsTradingDates,
  fromJQuantsCode,
  type JQuantsDailyProviderRow,
} from '@/lib/jquants'

type OhlcvRow = {
  ticker: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type OfficialRow = OhlcvRow & { adjustmentFactor: number }

type OfficialEvidence = {
  date: string
  priceBasis: string
  sourceContract: {
    providerRows: number
    acceptedRows: number
    noTradeRows: number
    unexpectedRejectedRows: number
    contentSha256: string
  }
  rows: OfficialRow[]
}

type Cli = {
  database: string
  official: string
  output: string
}

type Envelope = {
  date: string
  providerRows: number
  acceptedRows: number
  noTradeRows: number
  invalidRows: number
  contentSha256: string
}

type CorporateActionEvent = {
  ticker: string
  date: string
  adjustmentFactor: number
  rawClose: number | null
  adjustedClose: number | null
}

const PRICE_BASIS = 'jquants-adjusted-ohlcv-v1'
const EXPECTED_CONFLICTS = ['1447', '2164']

function parseCli(argv: string[]): Cli {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    values.set(name, value)
  }
  const required = (name: string): string => {
    const value = values.get(name)
    if (!value) throw new Error(`missing ${name}`)
    return path.resolve(value)
  }
  return {
    database: required('--database'),
    official: required('--official'),
    output: required('--output'),
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]))
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-8, Math.abs(left) * 1e-10)
}

function sameOhlcv(left: OhlcvRow, right: OhlcvRow): boolean {
  return left.ticker === right.ticker
    && left.date === right.date
    && near(left.open, right.open)
    && near(left.high, right.high)
    && near(left.low, right.low)
    && near(left.close, right.close)
    && left.volume === right.volume
}

function isNoTrade(row: JQuantsDailyProviderRow): boolean {
  return [row.O, row.H, row.L, row.C, row.Vo, row.AdjO, row.AdjH, row.AdjL, row.AdjC, row.AdjVo]
    .every((value) => value == null)
}

function normalize(row: JQuantsDailyProviderRow): OfficialRow | null {
  if (isNoTrade(row)) return null
  const close = row.AdjC ?? row.C
  if (close == null) throw new Error(`partial provider row without close: ${row.Code}:${row.Date}`)
  const open = row.AdjO ?? row.O ?? close
  const high = row.AdjH ?? row.H ?? close
  const low = row.AdjL ?? row.L ?? close
  const volume = Math.round(row.AdjVo ?? row.Vo ?? 0)
  const values = [open, high, low, close]
  if (!values.every((value) => Number.isFinite(value) && value > 0)
      || high < Math.max(open, low, close)
      || low > Math.min(open, high, close)
      || !Number.isSafeInteger(volume)
      || volume < 0) {
    throw new Error(`invalid provider OHLCV: ${row.Code}:${row.Date}`)
  }
  return {
    ticker: fromJQuantsCode(row.Code),
    date: row.Date,
    open,
    high,
    low,
    close,
    volume,
    adjustmentFactor: row.AdjFactor ?? 1,
  }
}

function providerIdentity(row: JQuantsDailyProviderRow): Record<string, unknown> {
  return {
    date: row.Date,
    code: row.Code,
    open: row.O,
    high: row.H,
    low: row.L,
    close: row.C,
    volume: row.Vo,
    adjustmentFactor: row.AdjFactor,
    adjustedOpen: row.AdjO,
    adjustedHigh: row.AdjH,
    adjustedLow: row.AdjL,
    adjustedClose: row.AdjC,
    adjustedVolume: row.AdjVo,
  }
}

function rawAdjustedEqual(row: JQuantsDailyProviderRow): boolean {
  return row.O === row.AdjO && row.H === row.AdjH && row.L === row.AdjL
    && row.C === row.AdjC && row.Vo === row.AdjVo
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

async function fetchDate(date: string): Promise<JQuantsDailyProviderRow[]> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchJQuantsDailyProviderRowsByDate(date)
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
    }
  }
  throw lastError
}

function classifyExisting(db: DatabaseSync, evidence: OfficialEvidence): {
  matching: string[]
  missing: OfficialRow[]
  conflicts: string[]
} {
  const existingRows = db.prepare(`
    SELECT ticker,date,open,high,low,close,volume
    FROM ohlcv_daily WHERE date=? ORDER BY ticker
  `).all(evidence.date) as OhlcvRow[]
  const existing = new Map(existingRows.map((row) => [row.ticker, row]))
  const matching: string[] = []
  const missing: OfficialRow[] = []
  const conflicts: string[] = []
  for (const row of evidence.rows) {
    const current = existing.get(row.ticker)
    if (!current) missing.push(row)
    else if (sameOhlcv(current, row)) matching.push(row.ticker)
    else conflicts.push(row.ticker)
  }
  return { matching, missing, conflicts }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const evidence = JSON.parse(fs.readFileSync(cli.official, 'utf8')) as OfficialEvidence
  if (evidence.priceBasis !== PRICE_BASIS || evidence.sourceContract.unexpectedRejectedRows !== 0) {
    throw new Error('official evidence Price Basis or envelope is not approved')
  }

  const db = new DatabaseSync(cli.database, { readOnly: true })
  let latestDate: string
  let classification: ReturnType<typeof classifyExisting>
  try {
    classification = classifyExisting(db, evidence)
    latestDate = (db.prepare('SELECT MAX(date) AS date FROM ohlcv_daily')
      .get() as { date: string }).date
  } finally {
    db.close()
  }

  const officialSessions = await fetchJQuantsTradingDates(addUtcDays(evidence.date, -10), latestDate)
  const previousDate = officialSessions.filter((date) => date < evidence.date).at(-1) ?? ''
  const dates = officialSessions.filter((date) => date >= evidence.date && date <= latestDate)
  const nextDate = dates.find((date) => date > evidence.date) ?? ''
  if (!previousDate || !nextDate || dates[0] !== evidence.date || dates.at(-1) !== latestDate) {
    throw new Error(`official trading calendar does not cover ${evidence.date}..${latestDate}`)
  }
  const existingBoundaries = new Map<string, Map<string, OhlcvRow>>()
  const boundaryDb = new DatabaseSync(cli.database, { readOnly: true })
  try {
    for (const date of [previousDate, nextDate]) {
      const rows = boundaryDb.prepare(`
        SELECT ticker,date,open,high,low,close,volume
        FROM ohlcv_daily WHERE date=? ORDER BY ticker
      `).all(date) as OhlcvRow[]
      existingBoundaries.set(date, new Map(rows.map((row) => [row.ticker, row])))
    }
  } finally {
    boundaryDb.close()
  }

  if (classification.matching.length !== 155 || classification.missing.length !== 4_061) {
    throw new Error(`unexpected baseline: matching=${classification.matching.length}, missing=${classification.missing.length}`)
  }
  if (JSON.stringify(classification.conflicts) !== JSON.stringify(EXPECTED_CONFLICTS)) {
    throw new Error(`unexpected conflicts: ${classification.conflicts.join(',')}`)
  }

  const approved = new Set(classification.missing.map((row) => row.ticker))
  const officialByTicker = new Map(evidence.rows.map((row) => [row.ticker, row]))
  const chainHashes = new Map<string, ReturnType<typeof createHash>>()
  const observedSessions = new Map<string, number>()
  const actionEvents: CorporateActionEvent[] = []
  const rawAdjustedDifferences: CorporateActionEvent[] = []
  const envelopes: Envelope[] = []
  const boundaryRows = new Map<string, JQuantsDailyProviderRow>()
  const boundaryProviderRows = new Map<string, Map<string, OfficialRow>>()
  const targetProviderRows = new Map<string, JQuantsDailyProviderRow>()
  for (const ticker of approved) chainHashes.set(ticker, createHash('sha256'))

  const requestedDates = [previousDate, ...dates]
  for (const date of requestedDates) {
    const rows = await fetchDate(date)
    let acceptedRows = 0
    let noTradeRows = 0
    let invalidRows = 0
    const normalizedForDate = new Map<string, OfficialRow>()

    for (const row of rows) {
      try {
        const normalized = normalize(row)
        if (!normalized) {
          noTradeRows += 1
          continue
        }
        acceptedRows += 1
        if (normalizedForDate.has(normalized.ticker)) {
          throw new Error(`duplicate normalized provider key: ${normalized.ticker}:${date}`)
        }
        normalizedForDate.set(normalized.ticker, normalized)
        if (normalized.ticker === '8105' && (date === previousDate || date === evidence.date)) {
          boundaryRows.set(date, row)
        }
        if (date === evidence.date && approved.has(normalized.ticker)) {
          targetProviderRows.set(normalized.ticker, row)
        }
        if (!approved.has(normalized.ticker) || date < evidence.date) continue
        const identity = providerIdentity(row)
        chainHashes.get(normalized.ticker)!.update(`${JSON.stringify(stable(identity))}\n`)
        observedSessions.set(normalized.ticker, (observedSessions.get(normalized.ticker) ?? 0) + 1)
        if (Math.abs(normalized.adjustmentFactor - 1) > Number.EPSILON) {
          actionEvents.push({
            ticker: normalized.ticker,
            date,
            adjustmentFactor: normalized.adjustmentFactor,
            rawClose: row.C,
            adjustedClose: row.AdjC,
          })
        }
        if (!rawAdjustedEqual(row)) {
          rawAdjustedDifferences.push({
            ticker: normalized.ticker,
            date,
            adjustmentFactor: normalized.adjustmentFactor,
            rawClose: row.C,
            adjustedClose: row.AdjC,
          })
        }
      } catch (error) {
        invalidRows += 1
        throw error
      }
    }

    if (date === previousDate || date === nextDate) {
      boundaryProviderRows.set(date, normalizedForDate)
    }

    envelopes.push({
      date,
      providerRows: rows.length,
      acceptedRows,
      noTradeRows,
      invalidRows,
      contentSha256: sha256(rows.map(providerIdentity)),
    })

    if (date === evidence.date) {
      for (const official of evidence.rows) {
        const current = normalizedForDate.get(official.ticker)
        if (!current || !sameOhlcv(current, official)
            || !near(current.adjustmentFactor, official.adjustmentFactor)) {
          throw new Error(`sealed target row changed at provider: ${official.ticker}`)
        }
      }
      const targetEnvelope = envelopes.at(-1)!
      if (targetEnvelope.providerRows !== evidence.sourceContract.providerRows
          || targetEnvelope.acceptedRows !== evidence.sourceContract.acceptedRows
          || targetEnvelope.noTradeRows !== evidence.sourceContract.noTradeRows
          || targetEnvelope.invalidRows !== 0) {
        throw new Error(`target provider envelope changed: ${JSON.stringify(targetEnvelope)}`)
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const before8105 = boundaryRows.get(previousDate)
  const target8105 = boundaryRows.get(evidence.date)
  if (!before8105 || !target8105) throw new Error('8105 boundary rows are missing')
  const normalizedBefore8105 = normalize(before8105)!
  const normalizedTarget8105 = normalize(target8105)!
  const events8105 = actionEvents.filter((event) => event.ticker === '8105')
  const classification8105 = (
    (before8105.AdjFactor ?? 1) === 1
    && (target8105.AdjFactor ?? 1) === 1
    && rawAdjustedEqual(before8105)
    && rawAdjustedEqual(target8105)
    && events8105.length === 0
  ) ? 'PROVIDER_VALUES_CONFIRMED_WITHOUT_CORPORATE_ACTION_SIGNAL' : 'REQUIRES_MANUAL_REVIEW'

  const targetBasis = { equal: 0, different: [] as string[], incomplete: [] as string[] }
  for (const ticker of approved) {
    const row = targetProviderRows.get(ticker)
    if (!row) {
      targetBasis.incomplete.push(ticker)
      continue
    }
    const rawComplete = [row.O, row.H, row.L, row.C, row.Vo].every((value) => value != null)
    const adjustedComplete = [row.AdjO, row.AdjH, row.AdjL, row.AdjC, row.AdjVo].every((value) => value != null)
    if (!rawComplete || !adjustedComplete) targetBasis.incomplete.push(ticker)
    else if (rawAdjustedEqual(row)) targetBasis.equal += 1
    else targetBasis.different.push(ticker)
  }

  const boundaryEvidence = [previousDate, nextDate].map((date) => {
    const existing = existingBoundaries.get(date)!
    const provider = boundaryProviderRows.get(date)!
    const matching: string[] = []
    const bothAbsent: string[] = []
    const oneSideMissing: string[] = []
    const mismatching: string[] = []
    for (const ticker of approved) {
      const current = existing.get(ticker)
      const official = provider.get(ticker)
      if (!current && !official) bothAbsent.push(ticker)
      else if (!current || !official) oneSideMissing.push(ticker)
      else if (sameOhlcv(current, official)) matching.push(ticker)
      else mismatching.push(ticker)
    }
    return {
      date,
      matching: matching.length,
      bothAbsent: bothAbsent.length,
      bothAbsentKeys: bothAbsent.sort(),
      oneSideMissing,
      mismatching,
      matchingKeysSha256: sha256(matching.sort()),
      bothAbsentKeysSha256: sha256(bothAbsent),
    }
  })
  const basisPass = targetBasis.equal === approved.size
    && targetBasis.different.length === 0
    && targetBasis.incomplete.length === 0
    && actionEvents.length === 0
    && rawAdjustedDifferences.length === 0
    && boundaryEvidence.every((boundary) => (
      boundary.oneSideMissing.length === 0 && boundary.mismatching.length === 0
    ))

  const perTicker = [...approved].sort().map((ticker) => ({
    ticker,
    targetRowSha256: sha256(officialByTicker.get(ticker)),
    providerChainSha256: chainHashes.get(ticker)!.digest('hex'),
    observedSessions: observedSessions.get(ticker) ?? 0,
    corporateActionEvents: actionEvents.filter((event) => event.ticker === ticker).length,
  }))
  const report = {
    version: 1,
    status: basisPass && classification8105 === 'PROVIDER_VALUES_CONFIRMED_WITHOUT_CORPORATE_ACTION_SIGNAL' ? 'PASS' : 'HOLD',
    generatedAt: new Date().toISOString(),
    database: fs.realpathSync(cli.database),
    officialEvidence: fs.realpathSync(cli.official),
    targetDate: evidence.date,
    latestDate,
    priceBasis: evidence.priceBasis,
    classification: {
      official: evidence.rows.length,
      matching: classification.matching.length,
      missing: classification.missing.length,
      conflicts: classification.conflicts,
      approvedMissingKeysSha256: sha256(classification.missing.map((row) => `${row.ticker}:${row.date}`).sort()),
      approvedMissingRowsSha256: sha256(classification.missing),
    },
    providerAudit: {
      calendarSource: 'J-Quants /v2/markets/calendar HolDiv 1|2',
      dates: requestedDates.length,
      firstDate: previousDate,
      lastDate: latestDate,
      envelopesSha256: sha256(envelopes),
      invalidRows: envelopes.reduce((sum, row) => sum + row.invalidRows, 0),
      corporateActionEvents: actionEvents.sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)),
      rawAdjustedDifferences: rawAdjustedDifferences.sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)),
      tickersWithCorporateActions: [...new Set(actionEvents.map((event) => event.ticker))].sort(),
      verifiedTickers: perTicker.length,
      targetRawAdjusted: targetBasis,
      neighborContinuity: boundaryEvidence,
      perTicker,
    },
    boundary8105: {
      classification: classification8105,
      previous: { provider: providerIdentity(before8105), normalized: normalizedBefore8105 },
      target: { provider: providerIdentity(target8105), normalized: normalizedTarget8105 },
      closeRatio: normalizedTarget8105.close / normalizedBefore8105.close,
      postTargetCorporateActionEvents: events8105,
    },
  }
  fs.mkdirSync(path.dirname(cli.output), { recursive: true })
  fs.writeFileSync(cli.output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({
    status: report.status,
    targetDate: report.targetDate,
    latestDate: report.latestDate,
    missing: report.classification.missing,
    conflicts: report.classification.conflicts,
    verifiedTickers: perTicker.length,
    corporateActionEvents: actionEvents.length,
    tickersWithCorporateActions: report.providerAudit.tickersWithCorporateActions.length,
    boundary8105: classification8105,
    output: cli.output,
  }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
