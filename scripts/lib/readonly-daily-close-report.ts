import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  DAILY_CLOSE_REPORT_TYPE,
  DAILY_CLOSE_REPORT_VERSION,
  aggregateClassifications60,
  aggregateSectorRotation,
  isValidReportDate,
  percentage,
  sortTopBottom,
  stageChanges,
  watchlistChangeReasons,
  type DailyCloseReport,
  type EarningsEvent,
  type LargeHolderEvent,
  type ReportTakeaway,
  type ReportTickerRow,
  type StageSet,
  type TriggerReport,
  type TriggerReportRow,
  type TriggerReportStatus,
  type WatchlistReportRow,
} from '@/lib/daily-close-report'
import { jpMarketClosureReason } from '@/lib/server/jp-market-calendar'

// 本番 SQLite から DailyCloseReport 相当を read-only で組み立てる検証用モジュール (scripts 専用)。
//
// 本番 DB はアプリの DB クライアント (lib/db/client) / external-storage-guard / node:sqlite を
// 一切経由せず、`sqlite3 -readonly -json` + `PRAGMA query_only=ON` の SELECT だけで読む。
// lib/server/daily-close-report.ts の private ロジックと SQL はこのファイルへ同一内容で移植し、
// verifyPortedSource() で移植元ソースとの一致を照合する (不一致なら呼び出し側で中止する)。
//
// 移植元との意図的な差分:
// - execAll / execGet の実体: sqlite3 -readonly CLI
// - loadLargeHolderEvents: 本番 DB / 公開 snapshot を開かないため UNAVAILABLE 固定
//
// DB パスは READONLY_SQLITE_DB_PATH で明示指定する (推測しない)。

const SOURCE_PATH = 'lib/server/daily-close-report.ts'
const SELF_PATH = 'scripts/lib/readonly-daily-close-report.ts'
const SQLITE_TIMEOUT_MS = 20 * 60_000
const readonlyDbPath = process.env.READONLY_SQLITE_DB_PATH?.trim() ?? ''

export const READONLY_REPORT_CONSTRAINTS = {
  dbAccess: 'sqlite3 -readonly -json + PRAGMA query_only=ON (app DB client / external-storage-guard 不使用)',
  largeHolder: 'UNAVAILABLE 固定 (本番 DB / 公開 snapshot を開かないため。本番レポートとは異なる)',
} as const

export const PORTED_BLOCKS = [
  'WATCHLIST_LIMIT', 'REPORT_ROW_LIMIT', 'TRIGGER_STATUS',
  'StockRow', 'TriggerEvaluationRow', 'TriggerMemberRow', 'TriggerEventRow', 'EarningsRow',
  'num', 'normalizeTickers', 'stages', 'stockView', 'resolveDates', 'loadStockRows', 'loadIndices',
  'loadTriggerReport', 'loadSparklines', 'countTradingSessions', 'loadEarnings', 'buildTakeaways',
  'buildDailyCloseReport',
] as const

function sqlLiteral(value: unknown): string {
  if (value == null) return 'NULL'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  // 日付・評価 ID のみを想定。CLI の dot-command へ渡すため文字種を制限する
  if (typeof value === 'string' && /^[A-Za-z0-9_\-:. ]*$/.test(value)) return `'${value}'`
  throw new Error('unsupported sqlite parameter')
}

function runSqlite<T>(sql: string, args: readonly unknown[]): Promise<T[]> {
  if (!readonlyDbPath) return Promise.reject(new Error('READONLY_SQLITE_DB_PATH is required'))
  const input = [
    ...args.map((value, index) => `.parameter set ?${index + 1} "${sqlLiteral(value)}"`),
    'PRAGMA query_only=ON;',
    `${sql.trim()};`,
    '',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-readonly', '-json', readonlyDbPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('sqlite3 timed out')) }, SQLITE_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || stderr.trim()) return reject(new Error(`sqlite3 failed (exit=${code}): ${stderr.trim().slice(0, 300)}`))
      const text = stdout.trim()
      try {
        resolve(text ? JSON.parse(text) as T[] : [])
      } catch {
        reject(new Error('sqlite3 returned invalid JSON'))
      }
    })
    child.stdin.end(input, 'utf8')
  })
}

// lib/db/client の execAll / execGet と同じ呼び出し形。実体は sqlite3 -readonly。
async function execAll<T>(sql: string, args: readonly unknown[] = []): Promise<T[]> {
  return runSqlite<T>(sql, args)
}

async function execGet<T>(sql: string, args: readonly unknown[] = []): Promise<T | undefined> {
  return (await runSqlite<T>(sql, args))[0]
}

function topLevelBlock(source: string, name: string): string | null {
  const match = new RegExp(`^(?:export )?(?:async )?(?:function|type|const) ${name}\\b`, 'm').exec(source)
  if (!match) return null
  const lines = source.slice(match.index).split('\n')
  const block = [lines[0]]
  for (const line of lines.slice(1)) {
    if (line && !/^[\s})\]]/.test(line)) break
    block.push(line)
  }
  return block.join('\n').replace(/^export /, '').replace(/\s+/g, ' ').trim()
}

export function verifyPortedSource(): void {
  const source = fs.readFileSync(path.join(process.cwd(), SOURCE_PATH), 'utf8')
  const self = fs.readFileSync(path.join(process.cwd(), SELF_PATH), 'utf8')
  const mismatched = PORTED_BLOCKS.filter((name) => {
    const original = topLevelBlock(source, name)
    return !original || original !== topLevelBlock(self, name)
  })
  if (mismatched.length) throw new Error(`ported source mismatch: ${mismatched.join(', ')}`)
}

// 対象 DB の実在・journal_mode=wal・parameter binding を確認する。満たさなければ throw。
export async function precheckReadonlyDatabase(): Promise<void> {
  if (!readonlyDbPath) throw new Error('READONLY_SQLITE_DB_PATH is required')
  if (!fs.existsSync(readonlyDbPath)) throw new Error('READONLY_SQLITE_DB_PATH does not exist')
  const [journal] = await runSqlite<{ journal_mode: string }>('PRAGMA journal_mode', [])
  if (String(journal?.journal_mode ?? '').toLowerCase() !== 'wal') throw new Error('journal_mode is not wal; aborting')
  const [probe] = await runSqlite<{ probe: unknown }>('SELECT ? AS probe', ['2000-01-01'])
  if (probe?.probe !== '2000-01-01') throw new Error('sqlite3 parameter binding probe failed')
}

export function isReportDate(value: string): boolean {
  return isValidReportDate(value)
}

// ---- 以下、lib/server/daily-close-report.ts からの同一移植 (verifyPortedSource で照合) ----

const WATCHLIST_LIMIT = 100
const REPORT_ROW_LIMIT = 12
const TRIGGER_STATUS = new Set<TriggerReportStatus>(['APPROACHING', 'NEAR', 'IN_ZONE', 'BELOW_ZONE'])

type StockRow = {
  ticker: string
  name: string | null
  sector33: string | null
  classification60: string | null
  close0: number | null
  close1: number | null
  close2: number | null
  close5: number | null
  close10: number | null
  close20: number | null
  currentHigh: number | null
  currentLow: number | null
  currentVolume: number | null
  avgVolume20: number | null
  avgTradingValue20: number | null
  high252: number | null
  low252: number | null
  dayA: number | null
  dayB: number | null
  weekA: number | null
  weekB: number | null
  monthA: number | null
  monthB: number | null
  prevDayA: number | null
  prevDayB: number | null
  prevWeekA: number | null
  prevWeekB: number | null
  prevMonthA: number | null
  prevMonthB: number | null
}

type TriggerEvaluationRow = {
  id: string
  definitionId: string
  definitionName: string
  resolvedAsOf: string
}

type TriggerMemberRow = {
  evaluationId: string
  ticker: string
  companyName: string
  triggerStatus: string
  triggerScore: number
  zoneDistancePct: number
  averageTradingValue: number | null
  dayA: number | null
  dayB: number | null
  weekA: number | null
  weekB: number | null
  monthA: number | null
  monthB: number | null
}

type TriggerEventRow = {
  currentEvaluationId: string
  ticker: string
  eventType: string
  currentTriggerStatus: string | null
  previousScore: number | null
  currentScore: number | null
  currentZoneDistancePct: number | null
}

type EarningsRow = { ticker: string; name: string | null; announceDate: string }

function num(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeTickers(tickers: string[]): string[] {
  return [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase().replace(/\.T$/i, ''))
    .filter((ticker) => /^[0-9A-Z]{4,8}$/.test(ticker)))].slice(0, WATCHLIST_LIMIT)
}

function stages(row: StockRow | TriggerMemberRow, prefix = ''): StageSet {
  const get = (key: string) => num((row as unknown as Record<string, unknown>)[`${prefix}${key}`])
  return {
    dayA: get('dayA'), dayB: get('dayB'), weekA: get('weekA'),
    weekB: get('weekB'), monthA: get('monthA'), monthB: get('monthB'),
  }
}

function stockView(row: StockRow): ReportTickerRow {
  const price = num(row.close0)
  const currentVolume = num(row.currentVolume)
  const averageVolume = num(row.avgVolume20)
  const averageTradingValue = num(row.avgTradingValue20)
  const tradingValue = price != null && currentVolume != null ? price * currentVolume : null
  return {
    ticker: row.ticker,
    name: row.name ?? row.ticker,
    price,
    dailyReturn: percentage(price, num(row.close1)),
    volumeRatio: averageVolume != null && averageVolume !== 0 && currentVolume != null
      ? currentVolume / averageVolume : null,
    turnoverRatio: averageTradingValue != null && averageTradingValue !== 0 && tradingValue != null
      ? tradingValue / averageTradingValue : null,
    tradingValue,
    sector33: row.sector33,
    classification60: row.classification60,
    stages: stages(row),
    previousStages: stages(row, 'prev'),
  }
}

async function resolveDates(requestedDate: string | null): Promise<{
  latestPrice: string
  priceDate: string
  derivedDate: string | null
  previousDate: string
}> {
  if (requestedDate && !isValidReportDate(requestedDate)) throw new Error('invalid_report_date')
  const row = await execGet<{
    latestPrice: string | null
    priceDate: string | null
    derivedDate: string | null
    previousDate: string | null
  }>(`
    SELECT
      (SELECT MAX(date) FROM ohlcv_daily) AS latestPrice,
      (SELECT MAX(date) FROM ohlcv_daily WHERE date <= COALESCE(?, '9999-12-31')) AS priceDate,
      (SELECT MAX(date) FROM daily_snapshots WHERE date <= (
        SELECT MAX(date) FROM ohlcv_daily WHERE date <= COALESCE(?, '9999-12-31')
      )) AS derivedDate,
      (SELECT MAX(date) FROM ohlcv_daily WHERE date < (
        SELECT MAX(date) FROM ohlcv_daily WHERE date <= COALESCE(?, '9999-12-31')
      )) AS previousDate
  `, [requestedDate, requestedDate, requestedDate])
  if (!row?.latestPrice || !row.priceDate || !row.previousDate) throw new Error('report_price_date_unavailable')
  return {
    latestPrice: row.latestPrice,
    priceDate: row.priceDate,
    derivedDate: row.derivedDate,
    previousDate: row.previousDate,
  }
}

async function loadStockRows(priceDate: string, previousDate: string): Promise<StockRow[]> {
  return execAll<StockRow>(`
    WITH recent_dates AS (
      SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
      FROM (
        SELECT DISTINCT date FROM ohlcv_daily WHERE date <= ? ORDER BY date DESC LIMIT 21
      )
    ), series AS (
      SELECT o.ticker, d.rn, o.close, o.high, o.low, o.volume
      FROM ohlcv_daily o JOIN recent_dates d ON d.date = o.date
    ), pivot AS (
      SELECT ticker,
        MAX(CASE WHEN rn=1 THEN close END) close0,
        MAX(CASE WHEN rn=2 THEN close END) close1,
        MAX(CASE WHEN rn=3 THEN close END) close2,
        MAX(CASE WHEN rn=6 THEN close END) close5,
        MAX(CASE WHEN rn=11 THEN close END) close10,
        MAX(CASE WHEN rn=21 THEN close END) close20,
        MAX(CASE WHEN rn=1 THEN high END) currentHigh,
        MAX(CASE WHEN rn=1 THEN low END) currentLow,
        MAX(CASE WHEN rn=1 THEN volume END) currentVolume,
        AVG(CASE WHEN rn BETWEEN 2 AND 21 THEN volume END) avgVolume20,
        AVG(CASE WHEN rn BETWEEN 2 AND 21 THEN close * volume END) avgTradingValue20
      FROM series GROUP BY ticker
    ), history AS (
      SELECT ticker, MAX(high) high252, MIN(low) low252
      FROM ohlcv_daily
      WHERE date < ? AND date >= date(?, '-380 day')
      GROUP BY ticker
    )
    SELECT p.ticker, COALESCE(tu.name, hu.name, p.ticker) name,
      COALESCE(hu.sector33_name, tu.sector33_name) sector33,
      sc.major_category classification60,
      p.close0,p.close1,p.close2,p.close5,p.close10,p.close20,
      p.currentHigh,p.currentLow,p.currentVolume,p.avgVolume20,p.avgTradingValue20,
      h.high252,h.low252,
      ds.daily_a_stage dayA,ds.daily_b_stage dayB,
      ds.weekly_a_stage weekA,ds.weekly_b_stage weekB,
      ds.monthly_a_stage monthA,ds.monthly_b_stage monthB,
      prev.daily_a_stage prevDayA,prev.daily_b_stage prevDayB,
      prev.weekly_a_stage prevWeekA,prev.weekly_b_stage prevWeekB,
      prev.monthly_a_stage prevMonthA,prev.monthly_b_stage prevMonthB
    FROM pivot p
    LEFT JOIN ticker_universe tu ON tu.ticker=p.ticker
    LEFT JOIN historical_universe hu ON hu.ticker=p.ticker
    LEFT JOIN stock_classification sc ON sc.ticker=p.ticker
    LEFT JOIN history h ON h.ticker=p.ticker
    LEFT JOIN daily_snapshots ds ON ds.ticker=p.ticker AND ds.date=?
    LEFT JOIN daily_snapshots prev ON prev.ticker=p.ticker AND prev.date=?
    WHERE p.close0 IS NOT NULL
  `, [priceDate, priceDate, priceDate, priceDate, previousDate])
}

async function loadIndices(priceDate: string, previousDate: string) {
  const rows = await execAll<{ code: string; date: string; close: number | null }>(`
    SELECT code,date,close FROM indices_daily
    WHERE date IN (?,?) AND code IN ('0000','0070','0500','0501')
  `, [priceDate, previousDate])
  const labels: Record<string, string> = {
    '0000': 'TOPIX', '0070': 'グロース250', '0500': 'プライム', '0501': 'スタンダード',
  }
  return [
    { code: 'N225', label: '日経225', value: null, changePct: null, note: 'J-Quants指数ソース未提供' },
    ...Object.entries(labels).map(([code, label]) => {
      const current = rows.find((row) => row.code === code && row.date === priceDate)
      const previous = rows.find((row) => row.code === code && row.date === previousDate)
      return { code, label, value: num(current?.close), changePct: percentage(num(current?.close), num(previous?.close)) }
    }),
  ]
}

async function loadTriggerReport(priceDate: string): Promise<{ report: TriggerReport; byTicker: Map<string, TriggerReportRow> }> {
  const current = await execGet<TriggerEvaluationRow>(`
    SELECT e.id,e.definition_id definitionId,d.name definitionName,e.resolved_as_of resolvedAsOf
    FROM trigger_evaluations e JOIN trigger_definitions d ON d.id=e.definition_id
    WHERE e.status='COMPLETED' AND e.resolved_as_of<=? AND d.archived_at IS NULL
    ORDER BY e.resolved_as_of DESC,e.completed_at DESC LIMIT 1
  `, [priceDate])
  const emptyCounts = { NEW: 0, RE_ENTRY: 0, NEAR: 0, IN_ZONE: 0 }
  if (!current) return { report: { available: false, candidateCount: 0, definitionName: null, evaluationDate: null,
    previousEvaluationDate: null, currentCounts: { ...emptyCounts }, previousCounts: { ...emptyCounts },
    newRows: [], reentryRows: [], nearRows: [], inZoneRows: [] }, byTicker: new Map() }
  const previous = await execGet<TriggerEvaluationRow>(`
    SELECT e.id,e.definition_id definitionId,d.name definitionName,e.resolved_as_of resolvedAsOf
    FROM trigger_evaluations e JOIN trigger_definitions d ON d.id=e.definition_id
    WHERE e.status='COMPLETED' AND e.definition_id=? AND e.resolved_as_of<?
    ORDER BY e.resolved_as_of DESC,e.completed_at DESC LIMIT 1
  `, [current.definitionId, current.resolvedAsOf])
  const ids = [current.id, previous?.id].filter((id): id is string => Boolean(id))
  const placeholders = ids.map(() => '?').join(',')
  const [members, events] = await Promise.all([
    execAll<TriggerMemberRow>(`
      SELECT evaluation_id evaluationId,ticker,company_name companyName,trigger_status triggerStatus,
        trigger_score triggerScore,zone_distance_pct zoneDistancePct,
        average_trading_value averageTradingValue,day_a_stage dayA,day_b_stage dayB,
        week_a_stage weekA,week_b_stage weekB,month_a_stage monthA,month_b_stage monthB
      FROM trigger_evaluation_members WHERE evaluation_id IN (${placeholders})
    `, ids),
    execAll<TriggerEventRow>(`
      SELECT current_evaluation_id currentEvaluationId,ticker,event_type eventType,
        current_trigger_status currentTriggerStatus,previous_score previousScore,
        current_score currentScore,current_zone_distance_pct currentZoneDistancePct
      FROM trigger_lifecycle_events WHERE current_evaluation_id IN (${placeholders})
    `, ids),
  ])
  const previousMembers = new Map(members.filter((row) => row.evaluationId === previous?.id).map((row) => [row.ticker, row]))
  const currentEvents = events.filter((row) => row.currentEvaluationId === current.id)
  const previousEvents = events.filter((row) => row.currentEvaluationId === previous?.id)
  const asRow = (member: TriggerMemberRow): TriggerReportRow => ({
    ticker: member.ticker, name: member.companyName, status: TRIGGER_STATUS.has(member.triggerStatus as TriggerReportStatus)
      ? member.triggerStatus as TriggerReportStatus : 'APPROACHING',
    score: Number(member.triggerScore), previousScore: num(previousMembers.get(member.ticker)?.triggerScore),
    zoneDistancePct: Number(member.zoneDistancePct),
    previousZoneDistancePct: num(previousMembers.get(member.ticker)?.zoneDistancePct),
    averageTradingValue: num(member.averageTradingValue), stages: stages(member),
  })
  const currentMembers = members.filter((row) => row.evaluationId === current.id)
  const byTicker = new Map(currentMembers.map((member) => [member.ticker, asRow(member)]))
  const eventRows = (type: string) => currentEvents.filter((event) => event.eventType === type)
    .flatMap((event) => byTicker.get(event.ticker) ?? []).sort((a, b) => b.score - a.score).slice(0, 8)
  const statusRows = (status: TriggerReportStatus) => [...byTicker.values()].filter((row) => row.status === status)
    .sort((a, b) => b.score - a.score).slice(0, 8)
  const counts = (sourceEvents: TriggerEventRow[], sourceMembers: TriggerMemberRow[]) => ({
    NEW: sourceEvents.filter((row) => row.eventType === 'NEW').length,
    RE_ENTRY: sourceEvents.filter((row) => row.eventType === 'RE_ENTRY').length,
    NEAR: sourceMembers.filter((row) => row.triggerStatus === 'NEAR').length,
    IN_ZONE: sourceMembers.filter((row) => row.triggerStatus === 'IN_ZONE').length,
  })
  return { report: {
    available: true, candidateCount: currentMembers.length,
    definitionName: current.definitionName, evaluationDate: current.resolvedAsOf,
    previousEvaluationDate: previous?.resolvedAsOf ?? null,
    currentCounts: counts(currentEvents, currentMembers),
    previousCounts: counts(previousEvents, members.filter((row) => row.evaluationId === previous?.id)),
    newRows: eventRows('NEW'), reentryRows: eventRows('RE_ENTRY'),
    nearRows: statusRows('NEAR'), inZoneRows: statusRows('IN_ZONE'),
  }, byTicker }
}

async function loadSparklines(tickers: string[], priceDate: string): Promise<Map<string, number[]>> {
  if (!tickers.length) return new Map()
  const placeholders = tickers.map(() => '?').join(',')
  const rows = await execAll<{ ticker: string; date: string; close: number }>(`
    WITH selected AS (
      SELECT ticker,date,close,ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) rn
      FROM ohlcv_daily WHERE ticker IN (${placeholders}) AND date<=?
    ) SELECT ticker,date,close FROM selected WHERE rn<=24 ORDER BY ticker,date
  `, [...tickers, priceDate])
  const result = new Map<string, number[]>()
  for (const row of rows) result.set(row.ticker, [...(result.get(row.ticker) ?? []), Number(row.close)])
  return result
}

function countTradingSessions(fromExclusive: string, toInclusive: string): number {
  let count = 0
  const cursor = new Date(`${fromExclusive}T00:00:00Z`)
  const end = new Date(`${toInclusive}T00:00:00Z`)
  for (cursor.setUTCDate(cursor.getUTCDate() + 1); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10)
    if (!jpMarketClosureReason(date)) count += 1
  }
  return count
}

async function loadEarnings(priceDate: string, stockByTicker: Map<string, ReportTickerRow>, triggerByTicker: Map<string, TriggerReportRow>): Promise<EarningsEvent[]> {
  const rows = await execAll<EarningsRow>(`
    SELECT e.ticker,COALESCE(e.company_name,u.name,e.ticker) name,e.announce_date announceDate
    FROM earnings_calendar e LEFT JOIN ticker_universe u ON u.ticker=e.ticker
    WHERE e.announce_date BETWEEN ? AND date(?, '+14 day')
    ORDER BY e.announce_date,e.ticker LIMIT 40
  `, [priceDate, priceDate])
  return rows.map((row) => ({
    ticker: row.ticker, name: row.name ?? row.ticker, eventDate: row.announceDate,
    sessionsRemaining: row.announceDate === priceDate ? 0 : countTradingSessions(priceDate, row.announceDate),
    triggerStatus: triggerByTicker.get(row.ticker)?.status ?? null,
    stages: stockByTicker.get(row.ticker)?.stages ?? { dayA: null, dayB: null, weekA: null, weekB: null, monthA: null, monthB: null },
  }))
}

// 意図的な差分: 本番 DB / 公開 snapshot を開かないため Large Holder は UNAVAILABLE 固定 (照合対象外)
async function loadLargeHolderEvents(priceDate: string): Promise<DailyCloseReport['events']['largeHolder']> {
  void priceDate
  const events: LargeHolderEvent[] = []
  return { status: 'UNAVAILABLE', priceDate: null, events }
}

function buildTakeaways(input: Pick<DailyCloseReport, 'market' | 'sectors33' | 'classifications60' | 'trigger' | 'watchlist' | 'events'>): Record<number, ReportTakeaway> {
  const topSector = input.sectors33[0]
  const top60 = [...input.classifications60].sort((a, b) => (b.oneWeek.meanReturn ?? -Infinity) - (a.oneWeek.meanReturn ?? -Infinity))[0]
  const breadth = input.market.advances - input.market.declines
  const delayed = input.events.largeHolder.status !== 'CURRENT'
  return {
    1: { headline: breadth >= 0 ? '市場内部は上昇銘柄優位' : '市場内部は下落銘柄優位', detail: [`上昇 ${input.market.advances} / 下落 ${input.market.declines}`, `Trigger NEW ${input.trigger.currentCounts.NEW}件`] },
    2: { headline: `騰落差 ${breadth >= 0 ? '+' : ''}${breadth}銘柄`, detail: [`新高値 ${input.market.newHighs} / 新安値 ${input.market.newLows}`] },
    3: { headline: topSector ? `${topSector.name}が33業種の日次首位` : '33業種データなし', detail: topSector?.return1D == null ? [] : [`業種平均 ${topSector.return1D.toFixed(2)}%`] },
    4: { headline: top60 ? `${top60.name}が1W上位` : '60分類データなし', detail: top60?.oneWeek.meanReturn == null ? [] : [`1W平均 ${top60.oneWeek.meanReturn.toFixed(2)}%`] },
    5: { headline: '短期順位を平均・中央値・勝率で確認', detail: ['1W=5営業日、2W=10営業日'] },
    6: { headline: '1Mの強さと1Wの現在地を分離', detail: ['順位変化はReturn accelerationとは区別'] },
    7: { headline: input.watchlist.total ? `${input.watchlist.changed.length}銘柄に意味のある変化` : 'Browser Watchlistは未登録', detail: ['全件ではなく変化銘柄のみ表示'] },
    8: { headline: input.trigger.available ? `保存済み条件の候補 ${input.trigger.candidateCount}件` : 'Trigger評価データなし', detail: ['Scoreは条件適合度であり売買推奨ではありません'] },
    9: { headline: 'Stage改善とMA接近を別々に確認', detail: ['既存6 Stage semanticsを維持'] },
    10: { headline: '出来高・売買代金・価格・Scoreの異常値', detail: ['各指標は独立順位'] },
    11: { headline: delayed ? 'Large Holder DATA DELAYED' : '認定済みLarge Holderと決算日程', detail: [`決算イベント ${input.events.earnings.length}件`] },
  }
}

export async function buildDailyCloseReport(input: { requestedDate?: string | null; watchlistTickers?: string[] }): Promise<DailyCloseReport> {
  const started = performance.now()
  const requestedDate = input.requestedDate ?? null
  const { latestPrice, priceDate, derivedDate, previousDate } = await resolveDates(requestedDate)
  const tickers = normalizeTickers(input.watchlistTickers ?? [])
  const [stockRows, indices, triggerResult, largeHolder] = await Promise.all([
    loadStockRows(priceDate, previousDate), loadIndices(priceDate, previousDate),
    loadTriggerReport(priceDate), loadLargeHolderEvents(priceDate),
  ])
  const stocks = stockRows.map(stockView)
  const stockByTicker = new Map(stocks.map((row) => [row.ticker, row]))
  const classifications60 = aggregateClassifications60(stockRows.filter((row) => row.classification60).map((row) => ({
    name: row.classification60!, return5: percentage(num(row.close0), num(row.close5)),
    return10: percentage(num(row.close0), num(row.close10)), return20: percentage(num(row.close0), num(row.close20)),
  })))
  const sectors33 = aggregateSectorRotation(stockRows.filter((row) => row.sector33 && row.sector33 !== 'その他').map((row) => ({
    name: row.sector33!, return1: percentage(num(row.close0), num(row.close1)),
    previousReturn1: percentage(num(row.close1), num(row.close2)), return5: percentage(num(row.close0), num(row.close5)),
  })))
  const sparkline = await loadSparklines(tickers, priceDate)
  const watchlistChanged: WatchlistReportRow[] = tickers.flatMap((ticker) => {
    const stock = stockByTicker.get(ticker)
    if (!stock) return []
    const trigger = triggerResult.byTicker.get(ticker)
    const changes = watchlistChangeReasons(stock, trigger)
    if (!changes.length) return []
    return [{ ...stock, ticker, name: stock.name, status: trigger?.status ?? 'APPROACHING',
      score: trigger?.score ?? 0, previousScore: trigger?.previousScore ?? null,
      zoneDistancePct: trigger?.zoneDistancePct ?? Number.NaN,
      previousZoneDistancePct: trigger?.previousZoneDistancePct ?? null,
      averageTradingValue: trigger?.averageTradingValue ?? null,
      changeReasons: changes, sparkline: sparkline.get(ticker) ?? [] }]
  }).sort((a, b) => b.changeReasons.length - a.changeReasons.length || Math.abs(b.dailyReturn ?? 0) - Math.abs(a.dailyReturn ?? 0)).slice(0, 12)
  const breadth = stocks.reduce((acc, row) => {
    if ((row.dailyReturn ?? 0) > 0) acc.advances += 1
    else if ((row.dailyReturn ?? 0) < 0) acc.declines += 1
    else acc.unchanged += 1
    return acc
  }, { advances: 0, declines: 0, unchanged: 0 })
  const stageCounts = new Map<number, number>()
  for (const row of stocks) if (row.stages.dayA != null) stageCounts.set(row.stages.dayA, (stageCounts.get(row.stages.dayA) ?? 0) + 1)
  const stageImproving = stocks.map((row) => ({ ...row, changes: stageChanges(row.previousStages, row.stages) }))
    .filter((row) => row.changes.length).sort((a, b) => b.changes.length - a.changes.length).slice(0, REPORT_ROW_LIMIT)
  const sortedVolume = sortTopBottom(stocks, (row) => row.volumeRatio, 5).top
  const sortedTurnover = sortTopBottom(stocks, (row) => row.turnoverRatio, 5).top
  const sortedMoves = [...stocks].filter((row) => row.dailyReturn != null)
    .sort((a, b) => Math.abs(b.dailyReturn!) - Math.abs(a.dailyReturn!)).slice(0, 5)
  const triggerScoreMove = [...triggerResult.byTicker.values()].filter((row) => row.previousScore != null)
    .sort((a, b) => Math.abs((b.score - b.previousScore!)) - Math.abs((a.score - a.previousScore!))).slice(0, 5)
  const market = {
    indices, ...breadth,
    tradingValue: stocks.reduce((sum, row) => sum + (row.tradingValue ?? 0), 0),
    newHighs: stockRows.filter((row) => num(row.currentHigh) != null && num(row.high252) != null && num(row.currentHigh)! >= num(row.high252)!).length,
    newLows: stockRows.filter((row) => num(row.currentLow) != null && num(row.low252) != null && num(row.currentLow)! <= num(row.low252)!).length,
    stageDistribution: [1, 2, 3, 4, 5, 6].map((stage) => ({ stage, count: stageCounts.get(stage) ?? 0 })),
  }
  const earnings = await loadEarnings(priceDate, stockByTicker, triggerResult.byTicker)
  const reportCore = {
    market, sectors33, classifications60,
    watchlist: { source: 'BROWSER_LOCAL_STORAGE' as const, total: tickers.length, changed: watchlistChanged },
    trigger: triggerResult.report,
    events: { largeHolder, earnings },
  }
  const topSector = sectors33[0]
  const top60 = [...classifications60].sort((a, b) => (b.oneWeek.meanReturn ?? -Infinity) - (a.oneWeek.meanReturn ?? -Infinity))[0]
  const executiveKeyPoints = [
    topSector && topSector.return1D != null ? `${topSector.name}が33業種の日次首位（${topSector.return1D.toFixed(2)}%）` : '33業種順位は算定不可',
    top60 && top60.oneWeek.meanReturn != null ? `${top60.name}が60分類1W首位（${top60.oneWeek.meanReturn.toFixed(2)}%）` : '60分類1W順位は算定不可',
    `Trigger NEW ${triggerResult.report.currentCounts.NEW}件 / RE_ENTRY ${triggerResult.report.currentCounts.RE_ENTRY}件`,
    tickers.length ? `Watchlist ${tickers.length}銘柄中 ${watchlistChanged.length}銘柄に重要変化` : 'Browser Watchlistは未登録',
    largeHolder.status === 'CURRENT' ? `Large Holder重要イベント ${largeHolder.events.length}件` : 'Large Holder DATA DELAYED',
  ]
  const report: DailyCloseReport = {
    version: DAILY_CLOSE_REPORT_VERSION, reportType: DAILY_CLOSE_REPORT_TYPE,
    reportDate: priceDate, requestedDate, priceDate, derivedDate,
    generatedAt: new Date().toISOString(), generationMs: 0,
    current: latestPrice === priceDate && derivedDate === priceDate,
    dataStatus: {
      jpPrice: { date: priceDate, status: latestPrice === priceDate ? 'CURRENT' : 'DELAYED' },
      jpDerived: { date: derivedDate, status: derivedDate === priceDate ? 'CURRENT' : 'DELAYED' },
      trigger: { date: triggerResult.report.evaluationDate, status: triggerResult.report.evaluationDate === priceDate ? 'CURRENT' : triggerResult.report.available ? 'DELAYED' : 'UNAVAILABLE' },
      largeHolder: { date: largeHolder.priceDate, status: largeHolder.status,
        note: largeHolder.status === 'CURRENT' ? undefined : '認定済みCURRENT Snapshotを取得できないため通常表示を停止' },
    },
    executive: {
      keyPoints: executiveKeyPoints,
      kpis: [
        { label: '日経225', value: 'N/A', change: null, context: 'J-Quants指数ソース未提供' },
        { label: 'TOPIX', value: indices.find((row) => row.code === '0000')?.value?.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) ?? 'N/A', change: indices.find((row) => row.code === '0000')?.changePct ?? null, context: '公式指数終値' },
        { label: '上昇銘柄比率', value: `${((breadth.advances / Math.max(1, breadth.advances + breadth.declines + breadth.unchanged)) * 100).toFixed(1)}%`, change: null, context: `${breadth.advances.toLocaleString()}銘柄` },
        { label: '売買代金', value: `${(market.tradingValue / 1e12).toFixed(2)}兆円`, change: null, context: '対象銘柄合計' },
        { label: '新高値', value: `${market.newHighs}`, change: null, context: '過去約1年比較' },
        { label: 'Trigger NEW', value: `${triggerResult.report.currentCounts.NEW}`, change: triggerResult.report.currentCounts.NEW - triggerResult.report.previousCounts.NEW, context: triggerResult.report.definitionName ?? '保存済み条件' },
        { label: 'Watchlist Changes', value: `${watchlistChanged.length}`, change: null, context: tickers.length ? `${tickers.length}銘柄中` : '未登録' },
        { label: 'Large Holder New', value: largeHolder.status === 'CURRENT' ? `${largeHolder.events.filter((event) => event.eventType === 'NEW_5PCT').length}` : 'N/A', change: null, context: largeHolder.status === 'CURRENT' ? 'NEW 5%' : 'DATA DELAYED' },
      ],
    },
    ...reportCore,
    setups: { stageImproving, maApproaching: [...triggerResult.report.nearRows, ...triggerResult.report.newRows].slice(0, 10), priceRangeHit: [] },
    unusual: { volumeSpike: sortedVolume, turnoverSpike: sortedTurnover, priceMove: sortedMoves, triggerScoreMove },
    takeaways: buildTakeaways(reportCore),
    sources: ['ohlcv_daily', 'daily_snapshots', 'indices_daily', 'ticker_universe', 'stock_classification.major_category', 'trigger_evaluations', 'trigger_lifecycle_events', 'earnings_calendar', 'Large Holder certified snapshot'],
    limitations: [
      '日経225は既存J-Quants指数ソースに存在しないためN/A。',
      'WatchlistはBrowser localStorageをSingle Sourceとし、Previewから最大100銘柄をread-onlyで渡す。',
      '過去日レポートの60分類は現行stock_classificationを参照するため、分類改定履歴は再現しない。',
      'ユーザー価格レンジは永続化sourceがないためPRICE RANGE HITはN/A。',
      'AI Narrativeは未接続。数値から生成したdeterministic summaryを表示。',
    ],
  }
  report.generationMs = Math.round((performance.now() - started) * 10) / 10
  return report
}

// ---- 移植ここまで ----
