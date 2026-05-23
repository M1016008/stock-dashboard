import { execAll, execGet } from '@/lib/db/client'

export type EarningsMlDirection = 'up' | 'down'

export type EarningsSignalDecoration = {
  signalLabels: string[]
  signalCodes: string[]
  mlDirection: EarningsMlDirection | null
}

type DecorationDraft = {
  codes: Set<string>
  labels: Map<string, number>
  mlDirection: EarningsMlDirection | null
  mlScore: number
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
}

const EMPTY_DECORATION: EarningsSignalDecoration = {
  signalLabels: [],
  signalCodes: [],
  mlDirection: null,
}

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
  if (EXACT_SIGNAL_LABELS[code]) return EXACT_SIGNAL_LABELS[code]
  if (code.startsWith('ma_cross_up_')) return 'MA上抜け'
  if (code.startsWith('ma_cross_down_')) return 'MA下抜け'
  if (code.startsWith('ma_upper_touch_')) return 'MA上タッチ'
  if (code.startsWith('ma_lower_touch_')) return 'MA下タッチ'
  if (code.startsWith('ma_touch_')) return 'MA接触'
  return null
}

function emptyDecoration(): EarningsSignalDecoration {
  return { ...EMPTY_DECORATION, signalLabels: [], signalCodes: [] }
}

function draftFor(map: Map<string, DecorationDraft>, ticker: string): DecorationDraft {
  const key = normalizeSignalTicker(ticker)
  let draft = map.get(key)
  if (!draft) {
    draft = { codes: new Set(), labels: new Map(), mlDirection: null, mlScore: -Infinity }
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
        SELECT ticker, direction, candidate_score
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
      }
      addSignalCode(draft, `ml_candidate_${row.direction}`)
      addLabel(draft, row.direction === 'up' ? '上昇候補' : '下落警戒')
    }
  }

  const result = new Map<string, EarningsSignalDecoration>()
  for (const [ticker, draft] of draftMap) {
    const signalLabels = Array.from(draft.labels.entries())
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'ja'))
      .map(([label]) => label)
    result.set(ticker, {
      signalLabels,
      signalCodes: Array.from(draft.codes).sort(),
      mlDirection: draft.mlDirection,
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
