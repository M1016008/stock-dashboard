import { execAll, execGet } from '@/lib/db/client'

export type EarningsMlDirection = 'up' | 'down'

export type EarningsSignalStat = {
  horizonDays: number
  periodLabel: string
  count: number | null
  upRate: number | null
  downRate: number | null
  medianReturnPct: number | null
  source: 'signal_return_stats' | 'signal_stats' | 'missing'
}

export type EarningsSignalDetail = {
  label: string
  code: string
  triggerDate: string | null
  elapsedTradingDays: number | null
  stats: EarningsSignalStat[]
}

export type EarningsSignalDecoration = {
  signalLabels: string[]
  signalCodes: string[]
  signalDetails: EarningsSignalDetail[]
  mlDirection: EarningsMlDirection | null
  mlInsight: {
    direction: EarningsMlDirection
    confidenceLabel: string
    summary: string
    watchPoints: string[]
    riskNotes: string[]
  } | null
}

type DecorationDraft = {
  codes: Set<string>
  labels: Map<string, number>
  mlDirection: EarningsMlDirection | null
  mlScore: number
  mlInsight: EarningsSignalDecoration['mlInsight']
}

type TechnicalRow = {
  ticker: string
  signal_code: string
}

type ModelFeatureRow = {
  ticker: string
  signal_codes: string | null
}

type ServingSignalRow = {
  ticker: string
  signal_codes: string | null
}

type MlCandidateRow = {
  ticker: string
  direction: EarningsMlDirection
  candidate_score: number
  explanation_json: string
}

type SignalReturnStatsRow = {
  signal_code: string
  horizon_days: number
  count: number
  up_rate: number | null
  down_rate: number | null
  median_return_pct: number | null
}

type SignalStatsRow = {
  signal_code: string
  horizon_days: number
  count: number
  return_p50: number | null
}

type ServingSignalStatsRow = {
  signal_code: string
  horizon_days: number
  payload_json: string
}

type TriggerRow = {
  ticker: string
  signal_code: string
  trigger_date: string
}

type ModelTriggerRow = {
  ticker: string
  date: string
  signal_codes: string | null
}

const EMPTY_DECORATION: EarningsSignalDecoration = {
  signalLabels: [],
  signalCodes: [],
  signalDetails: [],
  mlDirection: null,
  mlInsight: null,
}

const STAT_HORIZONS = [
  { horizonDays: 5, periodLabel: '1週' },
  { horizonDays: 10, periodLabel: '2週' },
  { horizonDays: 15, periodLabel: '3週' },
] as const

const LABEL_PRIORITY: Record<string, number> = {
  '上昇候補': 0,
  '下落警戒': 1,
  'ブレイク直前': 10,
  '押し目候補': 20,
  '好転予兆': 30,
  'ボラ収縮': 40,
  '高値継続': 50,
  '上位足一致': 55,
  'MA上抜け': 60,
  'MA下抜け': 61,
  'MA上タッチ': 70,
  'MA下タッチ': 71,
  'MA接触': 72,
}

const EXACT_SIGNAL_LABELS: Record<string, string> = {
  pullback_candidate: '押し目候補',
  pre_breakout: 'ブレイク直前',
  volatility_squeeze: 'ボラ収縮',
  stage_improvement_setup: '好転予兆',
  higher_timeframe_alignment: '上位足一致',
  high_breakout_continuation: '高値継続',
}

export function normalizeSignalTicker(ticker: string): string {
  return ticker.replace(/\.T$/i, '')
}

export function labelForSignalCode(code: string): string | null {
  if (code === 'ml_candidate_up') return '上昇候補'
  if (code === 'ml_candidate_down') return '下落警戒'
  if (EXACT_SIGNAL_LABELS[code]) return EXACT_SIGNAL_LABELS[code]
  if (code.startsWith('ma_cross_up_')) return 'MA上抜け'
  if (code.startsWith('ma_cross_down_')) return 'MA下抜け'
  if (code.startsWith('ma_upper_touch_')) return 'MA上タッチ'
  if (code.startsWith('ma_lower_touch_')) return 'MA下タッチ'
  if (code.startsWith('ma_touch_')) return 'MA接触'
  return null
}

function emptyDecoration(): EarningsSignalDecoration {
  return { ...EMPTY_DECORATION, signalLabels: [], signalCodes: [], signalDetails: [] }
}

function draftFor(map: Map<string, DecorationDraft>, ticker: string): DecorationDraft {
  const key = normalizeSignalTicker(ticker)
  let draft = map.get(key)
  if (!draft) {
    draft = { codes: new Set(), labels: new Map(), mlDirection: null, mlScore: -Infinity, mlInsight: null }
    map.set(key, draft)
  }
  return draft
}

function addLabel(draft: DecorationDraft, label: string) {
  const priority = LABEL_PRIORITY[label] ?? 999
  const current = draft.labels.get(label)
  if (current == null || priority < current) draft.labels.set(label, priority)
}

function addSignalCode(draft: DecorationDraft, code: string) {
  const trimmed = code.trim()
  if (!trimmed) return
  draft.codes.add(trimmed)
  const label = labelForSignalCode(trimmed)
  if (label) addLabel(draft, label)
}

function splitSignalCodes(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((code) => code.trim()).filter(Boolean)
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function detailKey(ticker: string, code: string): string {
  return `${normalizeSignalTicker(ticker)}\t${code}`
}

function statKey(code: string, horizonDays: number): string {
  return `${code}\t${horizonDays}`
}

function orderedLabels(draft: DecorationDraft): string[] {
  return Array.from(draft.labels.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'ja'))
    .map(([label]) => label)
}

function codesForLabel(draft: DecorationDraft, label: string): string[] {
  return Array.from(draft.codes)
    .filter((code) => labelForSignalCode(code) === label)
    .sort((a, b) => a.localeCompare(b))
}

async function loadTradingDateIndex(baseDate: string | null): Promise<Map<string, number>> {
  if (!baseDate) return new Map()
  const rows = await execAll<{ date: string }>(
    `SELECT DISTINCT date FROM daily_snapshots WHERE date <= ? ORDER BY date ASC`,
    [baseDate],
  )
  return new Map(rows.map((row, index) => [row.date, index]))
}

async function loadTechnicalTriggerDates(
  tickers: string[],
  codes: string[],
  baseDate: string | null,
): Promise<Map<string, string>> {
  if (!baseDate || tickers.length === 0 || codes.length === 0) return new Map()
  const out = new Map<string, string>()
  const codePlaceholders = codes.map(() => '?').join(',')
  const rows = await forTickerChunks<TriggerRow>(tickers, (placeholders, args) =>
    execAll<TriggerRow>(
      `
      SELECT ticker, signal_code, MAX(date) AS trigger_date
      FROM technical_signals
      WHERE date <= ?
        AND ticker IN (${placeholders})
        AND signal_code IN (${codePlaceholders})
      GROUP BY ticker, signal_code
      `,
      [baseDate, ...args, ...codes],
    ))
  for (const row of rows) {
    if (row.trigger_date) out.set(detailKey(row.ticker, row.signal_code), row.trigger_date)
  }
  return out
}

async function loadModelTriggerDates(
  tickers: string[],
  codes: string[],
  baseDate: string | null,
): Promise<Map<string, string>> {
  if (!baseDate || tickers.length === 0 || codes.length === 0) return new Map()
  const out = new Map<string, string>()
  const codeSet = new Set(codes)
  const rows = await forTickerChunks<ModelTriggerRow>(tickers, (placeholders, args) =>
    execAll<ModelTriggerRow>(
      `
      SELECT ticker, date, signal_codes
      FROM model_features
      WHERE date <= ?
        AND ticker IN (${placeholders})
        AND signal_codes IS NOT NULL
        AND signal_codes <> ''
      ORDER BY date DESC
      `,
      [baseDate, ...args],
    ))
  for (const row of rows) {
    for (const code of splitSignalCodes(row.signal_codes)) {
      if (!codeSet.has(code)) continue
      const key = detailKey(row.ticker, code)
      const current = out.get(key)
      if (!current || row.date > current) out.set(key, row.date)
    }
  }
  return out
}

function parseServingStat(row: ServingSignalStatsRow): SignalStatsRow | null {
  try {
    const payload = JSON.parse(row.payload_json) as { count?: unknown; return_p50?: unknown }
    const count = Number(payload.count)
    return {
      signal_code: row.signal_code,
      horizon_days: row.horizon_days,
      count: Number.isFinite(count) ? count : 0,
      return_p50: typeof payload.return_p50 === 'number' ? payload.return_p50 : null,
    }
  } catch {
    return null
  }
}

async function loadSignalStats(codes: string[]): Promise<Map<string, EarningsSignalStat>> {
  if (codes.length === 0) return new Map()
  const codePlaceholders = codes.map(() => '?').join(',')
  const horizonPlaceholders = STAT_HORIZONS.map(() => '?').join(',')
  const horizonArgs = STAT_HORIZONS.map((horizon) => horizon.horizonDays)
  const out = new Map<string, EarningsSignalStat>()

  const returnRows = await execAll<SignalReturnStatsRow>(
    `
    SELECT signal_code, horizon_days, count, up_rate, down_rate, median_return_pct
    FROM signal_return_stats
    WHERE signal_code IN (${codePlaceholders})
      AND horizon_days IN (${horizonPlaceholders})
    `,
    [...codes, ...horizonArgs],
  )
  for (const row of returnRows) {
    const period = STAT_HORIZONS.find((item) => item.horizonDays === Number(row.horizon_days))
    if (!period) continue
    out.set(statKey(row.signal_code, Number(row.horizon_days)), {
      horizonDays: period.horizonDays,
      periodLabel: period.periodLabel,
      count: Number(row.count),
      upRate: row.up_rate,
      downRate: row.down_rate,
      medianReturnPct: row.median_return_pct,
      source: 'signal_return_stats',
    })
  }

  const missingCodes = codes.filter((code) =>
    STAT_HORIZONS.some((horizon) => !out.has(statKey(code, horizon.horizonDays))),
  )
  if (missingCodes.length === 0) return out

  const fallbackPlaceholders = missingCodes.map(() => '?').join(',')
  const [servingRows, statsRows] = await Promise.all([
    execAll<ServingSignalStatsRow>(
      `
      SELECT signal_code, horizon_days, payload_json
      FROM serving_signal_stats
      WHERE pattern_code = 'ALL'
        AND signal_code IN (${fallbackPlaceholders})
        AND horizon_days IN (${horizonPlaceholders})
      `,
      [...missingCodes, ...horizonArgs],
    ),
    execAll<SignalStatsRow>(
      `
      SELECT signal_code, horizon_days, count, return_p50
      FROM signal_stats
      WHERE pattern_code = 'ALL'
        AND signal_code IN (${fallbackPlaceholders})
        AND horizon_days IN (${horizonPlaceholders})
      `,
      [...missingCodes, ...horizonArgs],
    ),
  ])

  const fallbackRows = [
    ...servingRows.map(parseServingStat).filter((row): row is SignalStatsRow => row != null),
    ...statsRows,
  ]
  for (const row of fallbackRows) {
    const period = STAT_HORIZONS.find((item) => item.horizonDays === Number(row.horizon_days))
    if (!period) continue
    const key = statKey(row.signal_code, Number(row.horizon_days))
    if (out.has(key)) continue
    out.set(key, {
      horizonDays: period.horizonDays,
      periodLabel: period.periodLabel,
      count: Number(row.count),
      upRate: null,
      downRate: null,
      medianReturnPct: row.return_p50,
      source: 'signal_stats',
    })
  }

  return out
}

function statsForCode(code: string, stats: Map<string, EarningsSignalStat>): EarningsSignalStat[] {
  return STAT_HORIZONS.map((horizon) => stats.get(statKey(code, horizon.horizonDays)) ?? {
    horizonDays: horizon.horizonDays,
    periodLabel: horizon.periodLabel,
    count: null,
    upRate: null,
    downRate: null,
    medianReturnPct: null,
    source: 'missing',
  })
}

async function latestDate(table: string, column: string, baseDate: string | null): Promise<string | null> {
  const where = baseDate ? `WHERE ${column} <= ?` : ''
  const args = baseDate ? [baseDate] : []
  const row = await execGet<{ date: string | null }>(
    `SELECT MAX(${column}) AS date FROM ${table} ${where}`,
    args,
  )
  return row?.date ?? null
}

async function forTickerChunks<T>(
  tickers: string[],
  query: (placeholders: string, args: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = []
  const chunkSize = 400
  for (let i = 0; i < tickers.length; i += chunkSize) {
    const chunk = tickers.slice(i, i + chunkSize)
    if (chunk.length === 0) continue
    out.push(...await query(chunk.map(() => '?').join(','), chunk))
  }
  return out
}

export async function loadEarningsSignalDecorations(
  tickers: Iterable<string>,
  baseDate: string | null,
): Promise<Map<string, EarningsSignalDecoration>> {
  const keys = Array.from(new Set(Array.from(tickers).map(normalizeSignalTicker).filter(Boolean)))
  if (keys.length === 0) return new Map()

  const [technicalDate, modelDate, servingSignalDate, mlDate] = await Promise.all([
    latestDate('technical_signals', 'date', baseDate),
    latestDate('model_features', 'date', baseDate),
    latestDate('serving_latest_signals', 'date', baseDate),
    latestDate('serving_ml_candidates', 'as_of_date', baseDate),
  ])

  const draftMap = new Map<string, DecorationDraft>()

  if (technicalDate) {
    const rows = await forTickerChunks<TechnicalRow>(keys, (placeholders, args) =>
      execAll<TechnicalRow>(
        `
        SELECT ticker, signal_code
        FROM technical_signals
        WHERE date = ? AND ticker IN (${placeholders})
        `,
        [technicalDate, ...args],
      ))
    for (const row of rows) addSignalCode(draftFor(draftMap, row.ticker), row.signal_code)
  }

  if (modelDate) {
    const rows = await forTickerChunks<ModelFeatureRow>(keys, (placeholders, args) =>
      execAll<ModelFeatureRow>(
        `
        SELECT ticker, signal_codes
        FROM model_features
        WHERE date = ? AND ticker IN (${placeholders})
          AND signal_codes IS NOT NULL AND signal_codes <> ''
        `,
        [modelDate, ...args],
      ))
    for (const row of rows) {
      const draft = draftFor(draftMap, row.ticker)
      for (const code of splitSignalCodes(row.signal_codes)) addSignalCode(draft, code)
    }
  }

  if (servingSignalDate) {
    const rows = await forTickerChunks<ServingSignalRow>(keys, (placeholders, args) =>
      execAll<ServingSignalRow>(
        `
        SELECT ticker, signal_codes
        FROM serving_latest_signals
        WHERE date = ? AND ticker IN (${placeholders})
        `,
        [servingSignalDate, ...args],
      ))
    for (const row of rows) {
      const draft = draftFor(draftMap, row.ticker)
      for (const code of splitSignalCodes(row.signal_codes)) addSignalCode(draft, code)
    }
  }

  if (mlDate) {
    const rows = await forTickerChunks<MlCandidateRow>(keys, (placeholders, args) =>
      execAll<MlCandidateRow>(
        `
        SELECT ticker, direction, candidate_score, explanation_json
        FROM serving_ml_candidates
        WHERE as_of_date = ? AND ticker IN (${placeholders})
        ORDER BY candidate_score DESC
        `,
        [mlDate, ...args],
      ))
    for (const row of rows) {
      const draft = draftFor(draftMap, row.ticker)
      if (row.candidate_score > draft.mlScore) {
        draft.mlDirection = row.direction
        draft.mlScore = row.candidate_score
        const explanation = parseJson<{
          confidenceLabel?: unknown
          summary?: unknown
          watchPoints?: unknown
          riskNotes?: unknown
        }>(row.explanation_json, {})
        draft.mlInsight = {
          direction: row.direction,
          confidenceLabel: typeof explanation.confidenceLabel === 'string' ? explanation.confidenceLabel : '要確認',
          summary: typeof explanation.summary === 'string'
            ? explanation.summary
            : row.direction === 'up'
              ? '6ステージとMA形状から上昇候補として抽出されています。'
              : '6ステージとMA形状から下落警戒として抽出されています。',
          watchPoints: Array.isArray(explanation.watchPoints)
            ? explanation.watchPoints.filter((item): item is string => typeof item === 'string').slice(0, 3)
            : [],
          riskNotes: Array.isArray(explanation.riskNotes)
            ? explanation.riskNotes.filter((item): item is string => typeof item === 'string').slice(0, 2)
            : [],
        }
      }
      addSignalCode(draft, `ml_candidate_${row.direction}`)
      addLabel(draft, row.direction === 'up' ? '上昇候補' : '下落警戒')
    }
  }

  const allCodes = Array.from(new Set(
    Array.from(draftMap.values()).flatMap((draft) => Array.from(draft.codes)),
  )).sort()
  const effectiveBaseDate = technicalDate ?? modelDate ?? servingSignalDate ?? mlDate ?? baseDate
  const [technicalTriggers, modelTriggers, tradingDateIndex, signalStats] = await Promise.all([
    loadTechnicalTriggerDates(keys, allCodes, effectiveBaseDate),
    loadModelTriggerDates(keys, allCodes, effectiveBaseDate),
    loadTradingDateIndex(effectiveBaseDate),
    loadSignalStats(allCodes),
  ])
  const baseTradingIndex = effectiveBaseDate ? tradingDateIndex.get(effectiveBaseDate) : null

  const result = new Map<string, EarningsSignalDecoration>()
  for (const [ticker, draft] of draftMap) {
    const signalLabels = orderedLabels(draft)
    const signalDetails = signalLabels.map((label) => {
      const codes = codesForLabel(draft, label)
      const candidates = codes
        .map((code) => ({
          code,
          triggerDate: technicalTriggers.get(detailKey(ticker, code)) ?? modelTriggers.get(detailKey(ticker, code)) ?? null,
        }))
        .sort((a, b) => (b.triggerDate ?? '').localeCompare(a.triggerDate ?? '') || a.code.localeCompare(b.code))
      const chosen = candidates[0] ?? { code: codes[0] ?? label, triggerDate: null }
      const triggerIndex = chosen.triggerDate ? tradingDateIndex.get(chosen.triggerDate) : null
      const elapsedTradingDays =
        baseTradingIndex != null && triggerIndex != null
          ? Math.max(0, baseTradingIndex - triggerIndex)
          : null
      return {
        label,
        code: chosen.code,
        triggerDate: chosen.triggerDate,
        elapsedTradingDays,
        stats: statsForCode(chosen.code, signalStats),
      }
    })
    result.set(ticker, {
      signalLabels,
      signalCodes: Array.from(draft.codes).sort(),
      signalDetails,
      mlDirection: draft.mlDirection,
      mlInsight: draft.mlInsight,
    })
  }
  return result
}

export function attachEarningsSignalDecorations<T extends { ticker: string }>(
  rows: T[],
  decorations: Map<string, EarningsSignalDecoration>,
): Array<T & EarningsSignalDecoration> {
  return rows.map((row) => ({
    ...row,
    ...(decorations.get(normalizeSignalTicker(row.ticker)) ?? emptyDecoration()),
  }))
}
