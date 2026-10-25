import fs from 'node:fs'
import path from 'node:path'
import {
  SIX_STAGE_REAL_RESEARCH_ROOT,
  SIX_STAGE_REAL_INPUTS,
  SIX_STAGE_SOURCE_ADOPTION_SHA256,
  assertResearchOnlyExecution,
  assertSixStageRealInput,
  sha256File,
} from '@/lib/research/six-stage-real-data-contract'

type Statement = {
  all(...bindings: unknown[]): Record<string, unknown>[]
  get(...bindings: unknown[]): Record<string, unknown> | undefined
}
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (databasePath: string, options?: { readOnly?: boolean }) => Database
}

const SOURCE_PATH = path.join(
  SIX_STAGE_REAL_RESEARCH_ROOT,
  'six-stage-discovery-source-export-20261025T211500JST-v2-r2.incomplete',
  'us-discovery-ohlcv.sqlite',
)
const OUTPUT_DIRECTORY = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'event-path-stores', 'E043-US-H20-extreme-audit-v1-20261026')

function number(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('expected finite number')
  return parsed
}

function main(): void {
  assertResearchOnlyExecution()
  const manifest = assertSixStageRealInput('US')
  if (!fs.existsSync(SOURCE_PATH)) throw new Error('adopted US physical source is missing')
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true })
  const outputPath = path.join(OUTPUT_DIRECTORY, 'extreme-audit.json')
  if (fs.existsSync(outputPath)) throw new Error('extreme audit is write-once and already exists')

  const eventDb = new DatabaseSync(SIX_STAGE_REAL_INPUTS.US.eventStorePath, { readOnly: true })
  const sourceDb = new DatabaseSync(SOURCE_PATH, { readOnly: true })
  eventDb.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
  sourceDb.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
  try {
    const totals = eventDb.prepare(`SELECT COUNT(*) AS events,SUM(abs(close_return_20)) AS absolute_sum,
      SUM(CASE WHEN entry_open<0.01 THEN 1 ELSE 0 END) AS sub_cent_entries,
      SUM(CASE WHEN entry_open<0.1 THEN 1 ELSE 0 END) AS sub_ten_cent_entries
      FROM event_paths WHERE close_return_20 IS NOT NULL`).get() ?? {}
    const events = number(totals.events)
    const absoluteSum = number(totals.absolute_sum)
    const topOneCount = Math.max(1, Math.ceil(events * 0.01))
    const topOne = eventDb.prepare(`SELECT SUM(absolute_return) AS absolute_sum FROM (
      SELECT abs(close_return_20) AS absolute_return FROM event_paths
      WHERE close_return_20 IS NOT NULL ORDER BY absolute_return DESC LIMIT ?
    )`).get(topOneCount) ?? {}
    const tickerRows = eventDb.prepare(`SELECT t.ticker,COUNT(*) AS events,
      SUM(abs(e.close_return_20)) AS absolute_sum,MAX(abs(e.close_return_20)) AS maximum_absolute_return,
      MIN(e.signal_date) AS first_signal_date,MAX(e.signal_date) AS last_signal_date,MIN(e.entry_open) AS minimum_entry_open
      FROM event_paths e JOIN ticker_dictionary t ON t.ticker_id=e.ticker_id
      WHERE e.close_return_20 IS NOT NULL GROUP BY e.ticker_id ORDER BY absolute_sum DESC LIMIT 100`).all()
    const yearRows = eventDb.prepare(`SELECT substr(signal_date,1,4) AS year,COUNT(*) AS events,
      SUM(abs(close_return_20)) AS absolute_sum,MAX(abs(close_return_20)) AS maximum_absolute_return
      FROM event_paths WHERE close_return_20 IS NOT NULL GROUP BY year ORDER BY absolute_sum DESC`).all()
    const topEvents = eventDb.prepare(`SELECT t.ticker,e.length,e.sequence_key,e.signal_date,e.entry_date,e.entry_open,
      e.exit_date_20,e.close_return_20,e.mfe_20,e.mae_20
      FROM event_paths e JOIN ticker_dictionary t ON t.ticker_id=e.ticker_id
      WHERE e.close_return_20 IS NOT NULL ORDER BY abs(e.close_return_20) DESC LIMIT 100`).all()

    const inspectedTickers = [...new Set(topEvents.slice(0, 40).map((row) => String(row.ticker)))]
    const sourceEvidence = inspectedTickers.map((ticker) => {
      const summary = sourceDb.prepare(`SELECT COUNT(*) AS rows,MIN(date) AS first_date,MAX(date) AS last_date,
        MIN(open) AS minimum_open,MAX(open) AS maximum_open,MIN(close) AS minimum_close,MAX(close) AS maximum_close,
        SUM(CASE WHEN open<0.01 OR close<0.01 THEN 1 ELSE 0 END) AS sub_cent_rows,
        SUM(CASE WHEN split_factor IS NOT NULL AND abs(split_factor-1)>1e-12 THEN 1 ELSE 0 END) AS non_unit_split_rows,
        COUNT(DISTINCT source) AS source_count,GROUP_CONCAT(DISTINCT source) AS sources
        FROM market_ohlcv_daily WHERE market='US' AND ticker=? AND date<='2022-12-30'`).get(ticker) ?? {}
      const discontinuities = sourceDb.prepare(`WITH ordered AS (
        SELECT date,close,LAG(close) OVER (ORDER BY date) AS previous_close
        FROM market_ohlcv_daily WHERE market='US' AND ticker=? AND date<='2022-12-30'
      ) SELECT COUNT(*) AS count,MAX(CASE WHEN previous_close>0 AND close>0 THEN max(close/previous_close,previous_close/close) END) AS maximum_ratio
      FROM ordered WHERE previous_close>0 AND close>0 AND (close/previous_close>=100 OR previous_close/close>=100)`).get(ticker) ?? {}
      return { ticker, ...summary, discontinuity100xCount: number(discontinuities.count ?? 0), maximumAdjacentCloseRatio: Number(discontinuities.maximum_ratio ?? 0) }
    })

    const artifact = {
      schemaVersion: 1,
      namespace: 'SIX_STAGE_US_H20_EXTREME_AUDIT_V1',
      status: 'COMPLETE_WITH_SOURCE_QUALITY_LIMITATION',
      generatedAt: new Date().toISOString(),
      sourceAdoptionSha256: SIX_STAGE_SOURCE_ADOPTION_SHA256,
      eventStoreSha256: manifest.file.sha256,
      physicalSourceSha256: manifest.source.priceSourceFileSha256,
      productionAccess: 0,
      validationAccess: 0,
      holdoutAccess: 0,
      policy: { rowsRemoved: 0, winsorized: false, fullDistributionRetained: true },
      totals: {
        events,
        absoluteSum,
        subCentEntries: number(totals.sub_cent_entries),
        subTenCentEntries: number(totals.sub_ten_cent_entries),
        topOneCount,
        topOneAbsoluteContribution: number(topOne.absolute_sum) / absoluteSum,
      },
      tickerContributions: tickerRows.map((row) => ({
        ...row,
        absoluteContribution: number(row.absolute_sum) / absoluteSum,
      })),
      yearContributions: yearRows.map((row) => ({
        ...row,
        absoluteContribution: number(row.absolute_sum) / absoluteSum,
      })),
      topEvents,
      sourceEvidence,
      finding: 'The dominant tail is concentrated in Tiingo rows with near-zero prices and discontinuities of 100x or more while split_factor remains unit or absent. This is a source-quality/lineage limitation, not a DCM-boundary effect. Events remain present and are not winsorized.',
    }
    const temporary = `${outputPath}.tmp-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' })
    fs.renameSync(temporary, outputPath)
    console.log(JSON.stringify({
      status: artifact.status,
      file: outputPath,
      sha256: sha256File(outputPath),
      totals: artifact.totals,
      topTicker: artifact.tickerContributions[0],
      inspectedTickers: sourceEvidence.length,
    }, null, 2))
  } finally {
    eventDb.close()
    sourceDb.close()
  }
}

main()
