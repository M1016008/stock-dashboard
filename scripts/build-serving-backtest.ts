// scripts/build-serving-backtest.ts
//
// Turso に同期する軽量サービングテーブルをローカル分析DBから作る。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'

type LatestFeature = {
  date: string
  ticker: string
  name: string | null
  sector_large: string | null
  sector_small: string | null
  close: number | null
  volume: number | null
  volume_ratio_20: number | null
  range_pct: number | null
  atr20_pct: number | null
  ma25_pos_pct: number | null
  pattern_code: string | null
  signal_codes: string | null
}

type SummaryRow = {
  count: number
  hit_10_rate: number | null
  hit_20_rate: number | null
  hit_40_rate: number | null
  avg_max_return_pct: number | null
  avg_min_return_pct: number | null
  avg_days_to_max: number | null
}

type SummaryAggregateRow = {
  date: string
  horizon_days: number
  count: number
  signal_count: number | null
  hit_10_sum: number | null
  hit_20_sum: number | null
  hit_40_sum: number | null
  max_return_sum: number | null
  min_return_sum: number | null
  days_to_max_sum: number | null
  days_to_max_count: number | null
  signal_hit_10_sum: number | null
  signal_hit_20_sum: number | null
  signal_hit_40_sum: number | null
  signal_max_return_sum: number | null
  signal_min_return_sum: number | null
  signal_days_to_max_sum: number | null
  signal_days_to_max_count: number | null
}

type BacktestServingRow = {
  date: string
  horizon_days: number
  ticker: string
  name: string | null
  sector_large: string | null
  sector_small: string | null
  market_segment: string | null
  pattern_code: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  volume_ratio_20: number | null
  range_pct: number | null
  atr20_pct: number | null
  ma5_pos_pct: number | null
  ma25_pos_pct: number | null
  ma75_pos_pct: number | null
  signal_codes: string | null
  return_pct: number | null
  max_return_pct: number | null
  max_return_date: string | null
  days_to_max: number | null
  min_return_pct: number | null
  min_return_date: string | null
  days_to_min: number | null
  hit_10: number | null
  hit_20: number | null
  hit_40: number | null
}

type TechnicalSignalRow = {
  ticker: string
  date: string
  timescale: string
  ma_period: number
  signal_code: string
  signal_strength: string
  direction: string
  label: string
  score_component: number | null
  value_json: string | null
}

function envInt(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
}

const LATEST_LIMIT = envInt('SERVING_LATEST_LIMIT', 300, 1)
const DATE_LIMIT = envInt('SERVING_DATE_LIMIT', 260, 0)
const SUMMARY_DATE_CHUNK = envInt('SERVING_SUMMARY_DATE_CHUNK', DATE_LIMIT === 0 ? 40 : 60, 1)
const RESULT_DATE_CHUNK = envInt('SERVING_RESULT_DATE_CHUNK', DATE_LIMIT === 0 ? 5 : 20, 1)
const EVIDENCE_DATE_CHUNK = envInt('SERVING_EVIDENCE_DATE_CHUNK', DATE_LIMIT === 0 ? 5 : 20, 1)
const DETAIL_PER_DATE_HORIZON = envInt('SERVING_DETAIL_PER_DATE_HORIZON', 20, 0)
const SIMILAR_SOURCE_LIMIT = envInt('SERVING_SIMILAR_SOURCE_LIMIT', 30, 0)
const CHUNK = 250
const HORIZONS = [5, 20, 30, 40, 60, 90, 180] as const

function scoreSignals(row: LatestFeature): number {
  const codes = (row.signal_codes ?? '').split(',').filter(Boolean)
  let score = 0
  for (const code of codes) {
    if (code === 'higher_timeframe_alignment') score += 18
    else if (code === 'pre_breakout') score += 16
    else if (code === 'pullback_candidate') score += 15
    else if (code === 'high_breakout_continuation') score += 14
    else if (code === 'stage_improvement_setup') score += 12
    else if (code === 'volatility_squeeze') score += 9
    else if (code.includes('ma_cross_up')) score += 6
    else if (code.includes('ma_upper_touch')) score += 4
    else if (code.includes('ma_cross_down')) score -= 8
    else if (code.includes('ma_lower_touch')) score -= 5
  }
  if (row.volume_ratio_20 != null) score += Math.min(10, Math.max(0, (row.volume_ratio_20 - 1) * 5))
  if (row.ma25_pos_pct != null && row.ma25_pos_pct >= -3 && row.ma25_pos_pct <= 8) score += 4
  if (row.atr20_pct != null && row.atr20_pct <= 5) score += 2
  return Number(score.toFixed(3))
}

async function latestDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM model_features`))?.date ?? null
}

async function buildLatestSignals(date: string): Promise<void> {
  const rows = await execAll<LatestFeature>(
    `
    SELECT
      mf.date, mf.ticker, u.name, sm.sector_large, sm.sector_small,
      mf.close, mf.volume, mf.volume_ratio_20, mf.range_pct, mf.atr20_pct,
      mf.ma25_pos_pct, mf.pattern_code, mf.signal_codes
    FROM model_features mf
    LEFT JOIN ticker_universe u ON u.ticker = mf.ticker
    LEFT JOIN sector_master sm ON sm.ticker = mf.ticker
    WHERE mf.date = ? AND mf.signal_codes IS NOT NULL AND mf.signal_codes <> ''
    `,
    [date],
  )
  const ranked = rows
    .map((row) => ({ row, score: scoreSignals(row) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LATEST_LIMIT)

  await execRun(`DELETE FROM serving_latest_signals WHERE date = ?`, [date])
  await execBatch(ranked.map(({ row, score }, index) => ({
    sql: `
      INSERT OR REPLACE INTO serving_latest_signals
        (date, ticker, rank, score, signal_codes, summary_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `,
    args: [
      row.date,
      row.ticker,
      index + 1,
      score,
      row.signal_codes ?? '',
      JSON.stringify({
        name: row.name,
        sectorLarge: row.sector_large,
        sectorSmall: row.sector_small,
        close: row.close,
        volume: row.volume,
        volumeRatio20: row.volume_ratio_20,
        rangePct: row.range_pct,
        atr20Pct: row.atr20_pct,
        ma25PosPct: row.ma25_pos_pct,
        patternCode: row.pattern_code,
      }),
    ],
  })))
  console.log(`serving_latest_signals: ${ranked.length} rows`)
}

async function buildSignalStats(): Promise<void> {
  await execRun(`DELETE FROM serving_signal_stats`)
  const rows = await execAll<{
    signal_code: string
    pattern_code: string
    horizon_days: number
    count: number
    hit_10_rate: number | null
    hit_20_rate: number | null
    hit_40_rate: number | null
    max_return_p25: number | null
    max_return_p50: number | null
    max_return_p75: number | null
    return_p50: number | null
    min_return_p50: number | null
    days_to_max_p50: number | null
  }>(
    `SELECT * FROM signal_stats WHERE count >= 40 ORDER BY count DESC`,
  )
  for (let i = 0; i < rows.length; i += CHUNK) {
    await execBatch(rows.slice(i, i + CHUNK).map((row) => ({
      sql: `
        INSERT OR REPLACE INTO serving_signal_stats
          (signal_code, pattern_code, horizon_days, payload_json, computed_at)
        VALUES (?, ?, ?, ?, unixepoch())
      `,
      args: [
        row.signal_code,
        row.pattern_code,
        row.horizon_days,
        JSON.stringify(row),
      ],
    })))
  }
  console.log(`serving_signal_stats: ${rows.length} rows`)
}

async function buildBacktestDates(): Promise<string[]> {
  const limitSql = DATE_LIMIT > 0 ? `LIMIT ?` : ''
  const args = DATE_LIMIT > 0 ? [DATE_LIMIT] : []
  const rows = await execAll<{ date: string; total_tickers: number; signal_tickers: number }>(
    `
    SELECT
      date,
      COUNT(*) AS total_tickers,
      SUM(CASE WHEN signal_codes IS NOT NULL AND signal_codes <> '' THEN 1 ELSE 0 END) AS signal_tickers
    FROM model_features
    WHERE EXISTS (
      SELECT 1
      FROM forward_extrema fe
      WHERE fe.ticker = model_features.ticker AND fe.date = model_features.date
    )
    GROUP BY date
    ORDER BY date DESC
    ${limitSql}
    `,
    args,
  )

  if (DATE_LIMIT === 0) await execRun(`DELETE FROM serving_backtest_dates`)
  else await deleteServingDates('serving_backtest_dates', 'date', rows.map((row) => row.date))

  await execBatch(rows.map((row) => ({
    sql: `
      INSERT OR REPLACE INTO serving_backtest_dates
        (date, total_tickers, signal_tickers, computed_at)
      VALUES (?, ?, ?, unixepoch())
    `,
    args: [row.date, row.total_tickers, row.signal_tickers],
  })))
  console.log(`serving_backtest_dates: ${rows.length} rows`)
  return rows.map((row) => row.date)
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function avg(sum: number, count: number): number | null {
  return count > 0 ? sum / count : null
}

function summaryPayload(row: SummaryAggregateRow, condition: 'all' | 'with_signals'): SummaryRow {
  if (condition === 'all') {
    const count = toNumber(row.count)
    return {
      count,
      hit_10_rate: avg(toNumber(row.hit_10_sum), count),
      hit_20_rate: avg(toNumber(row.hit_20_sum), count),
      hit_40_rate: avg(toNumber(row.hit_40_sum), count),
      avg_max_return_pct: avg(toNumber(row.max_return_sum), count),
      avg_min_return_pct: avg(toNumber(row.min_return_sum), count),
      avg_days_to_max: avg(toNumber(row.days_to_max_sum), toNumber(row.days_to_max_count)),
    }
  }

  const count = toNumber(row.signal_count)
  return {
    count,
    hit_10_rate: avg(toNumber(row.signal_hit_10_sum), count),
    hit_20_rate: avg(toNumber(row.signal_hit_20_sum), count),
    hit_40_rate: avg(toNumber(row.signal_hit_40_sum), count),
    avg_max_return_pct: avg(toNumber(row.signal_max_return_sum), count),
    avg_min_return_pct: avg(toNumber(row.signal_min_return_sum), count),
    avg_days_to_max: avg(toNumber(row.signal_days_to_max_sum), toNumber(row.signal_days_to_max_count)),
  }
}

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function reasonForSignal(row: TechnicalSignalRow): Record<string, unknown> {
  const value = parseJson(row.value_json)
  const close = num(value.close)
  const high = num(value.high)
  const low = num(value.low)
  const ma = num(value.ma)
  const volumeRatio = num(value.volumeRatio ?? value.volume_ratio_20)
  let reason = row.label

  if (row.signal_code.includes('ma_cross_up')) {
    reason = `${row.timescale === 'weekly' ? '週足' : '日足'}の終値が${row.ma_period}MAを下から上に抜けました。`
  } else if (row.signal_code.includes('ma_cross_down')) {
    reason = `${row.timescale === 'weekly' ? '週足' : '日足'}の終値が${row.ma_period}MAを上から下に割りました。`
  } else if (row.signal_code.includes('ma_upper_touch')) {
    reason = `終値はまだ明確に上抜けていませんが、高値が${row.ma_period}MAに届きました。`
  } else if (row.signal_code.includes('ma_lower_touch')) {
    reason = `終値はまだ明確に下抜けていませんが、安値が${row.ma_period}MAに届きました。`
  } else if (row.signal_code.includes('ma_touch')) {
    reason = `ローソク足の値幅が${row.ma_period}MAと重なりました。`
  } else if (row.signal_code === 'pullback_candidate') {
    reason = '上位足の流れを保ちながら、株価が主要移動平均線の近くまで戻っているため、押し目候補として抽出しました。'
  } else if (row.signal_code === 'pre_breakout') {
    reason = '直近高値に近づき、出来高やステージ条件が改善しているため、ブレイク前候補として抽出しました。'
  } else if (row.signal_code === 'volatility_squeeze') {
    reason = '値幅とボラティリティが縮小しており、次の大きな値動きに備える局面として抽出しました。'
  } else if (row.signal_code === 'stage_improvement_setup') {
    reason = '日足・週足・月足のステージ構成が改善方向にあり、好転予兆として抽出しました。'
  } else if (row.signal_code === 'higher_timeframe_alignment') {
    reason = '週足・月足など上位足のステージがそろっており、上位足一致として抽出しました。'
  } else if (row.signal_code === 'high_breakout_continuation') {
    reason = '高値更新後もステージと出来高の条件が崩れていないため、継続力のある候補として抽出しました。'
  }

  return {
    label: row.label,
    reason,
    basis: {
      timescale: row.timescale,
      maPeriod: row.ma_period || null,
      direction: row.direction,
      strength: row.signal_strength,
      scoreComponent: row.score_component,
      close,
      high,
      low,
      ma,
      volumeRatio,
      raw: value,
    },
  }
}

async function deleteServingDates(table: string, dateColumn: string, dates: string[]): Promise<void> {
  if (dates.length === 0) return
  for (let i = 0; i < dates.length; i += CHUNK) {
    const chunk = dates.slice(i, i + CHUNK)
    await execRun(
      `DELETE FROM ${table} WHERE ${dateColumn} IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    )
  }
}

async function loadSummaryChunk(dates: string[]): Promise<SummaryAggregateRow[]> {
  if (dates.length === 0) return []
  return execAll<SummaryAggregateRow>(
    `
    SELECT
      mf.date,
      fe.horizon_days,
      COUNT(*) AS count,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN 1 ELSE 0 END) AS signal_count,
      SUM(fe.hit_10) AS hit_10_sum,
      SUM(fe.hit_20) AS hit_20_sum,
      SUM(fe.hit_40) AS hit_40_sum,
      SUM(COALESCE(fe.max_return_pct, 0)) AS max_return_sum,
      SUM(COALESCE(fe.min_return_pct, 0)) AS min_return_sum,
      SUM(COALESCE(fe.days_to_max, 0)) AS days_to_max_sum,
      SUM(CASE WHEN fe.days_to_max IS NULL THEN 0 ELSE 1 END) AS days_to_max_count,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN fe.hit_10 ELSE 0 END) AS signal_hit_10_sum,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN fe.hit_20 ELSE 0 END) AS signal_hit_20_sum,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN fe.hit_40 ELSE 0 END) AS signal_hit_40_sum,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN COALESCE(fe.max_return_pct, 0) ELSE 0 END) AS signal_max_return_sum,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN COALESCE(fe.min_return_pct, 0) ELSE 0 END) AS signal_min_return_sum,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN COALESCE(fe.days_to_max, 0) ELSE 0 END) AS signal_days_to_max_sum,
      SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' AND fe.days_to_max IS NOT NULL THEN 1 ELSE 0 END) AS signal_days_to_max_count
    FROM model_features mf
    INNER JOIN forward_extrema fe ON fe.ticker = mf.ticker AND fe.date = mf.date
    WHERE mf.date IN (${dates.map(() => '?').join(', ')})
    GROUP BY mf.date, fe.horizon_days
    `,
    dates,
  )
}

async function buildBacktestSummaries(dates: string[]): Promise<void> {
  if (DATE_LIMIT === 0) await execRun(`DELETE FROM serving_backtest_summaries`)
  else await deleteServingDates('serving_backtest_summaries', 'date', dates)

  const statements: Array<{ sql: string; args: Array<string | number> }> = []
  const started = Date.now()
  const totalChunks = Math.ceil(dates.length / SUMMARY_DATE_CHUNK)

  for (let i = 0; i < dates.length; i += SUMMARY_DATE_CHUNK) {
    const chunkDates = dates.slice(i, i + SUMMARY_DATE_CHUNK)
    const rows = await loadSummaryChunk(chunkDates)
    for (const row of rows) {
      if (!HORIZONS.includes(Number(row.horizon_days) as typeof HORIZONS[number])) continue
      for (const condition of ['all', 'with_signals'] as const) {
        const summary = summaryPayload(row, condition)
        if (summary.count === 0) continue
        statements.push({
          sql: `
            INSERT OR REPLACE INTO serving_backtest_summaries
              (date, horizon_days, condition_key, payload_json, computed_at)
            VALUES (?, ?, ?, ?, unixepoch())
          `,
          args: [row.date, row.horizon_days, condition, JSON.stringify(summary)],
        })
        if (statements.length >= CHUNK) {
          await execBatch(statements.splice(0, statements.length))
        }
      }
    }

    const chunkNo = Math.floor(i / SUMMARY_DATE_CHUNK) + 1
    if (chunkNo % 10 === 0 || chunkNo === totalChunks) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`serving_backtest_summaries chunk ${chunkNo}/${totalChunks} elapsed=${elapsed}m`)
    }
  }
  if (statements.length > 0) await execBatch(statements)
  console.log(`serving_backtest_summaries: dates=${dates.length}`)
}

async function buildBacktestResults(dates: string[]): Promise<void> {
  if (DATE_LIMIT === 0) await execRun(`DELETE FROM serving_backtest_results`)
  else await deleteServingDates('serving_backtest_results', 'date', dates)

  const started = Date.now()
  let inserted = 0
  const totalChunks = Math.ceil(dates.length / RESULT_DATE_CHUNK)
  for (let i = 0; i < dates.length; i += RESULT_DATE_CHUNK) {
    const chunkDates = dates.slice(i, i + RESULT_DATE_CHUNK)
    const rows = await execAll<BacktestServingRow>(
      `
      SELECT
        mf.date,
        fe.horizon_days,
        mf.ticker,
        u.name,
        sm.sector_large,
        sm.sector_small,
        sm.market_segment,
        mf.pattern_code,
        mf.daily_a_stage,
        mf.daily_b_stage,
        mf.weekly_a_stage,
        mf.weekly_b_stage,
        mf.monthly_a_stage,
        mf.monthly_b_stage,
        o.open,
        o.high,
        o.low,
        COALESCE(mf.close, o.close) AS close,
        COALESCE(mf.volume, o.volume) AS volume,
        mf.volume_ratio_20,
        mf.range_pct,
        mf.atr20_pct,
        mf.ma5_pos_pct,
        mf.ma25_pos_pct,
        mf.ma75_pos_pct,
        mf.signal_codes,
        fe.return_pct,
        fe.max_return_pct,
        fe.max_return_date,
        fe.days_to_max,
        fe.min_return_pct,
        fe.min_return_date,
        fe.days_to_min,
        fe.hit_10,
        fe.hit_20,
        fe.hit_40
      FROM model_features mf
      INNER JOIN forward_extrema fe ON fe.ticker = mf.ticker AND fe.date = mf.date
      LEFT JOIN ohlcv_daily o ON o.ticker = mf.ticker AND o.date = mf.date
      LEFT JOIN ticker_universe u ON u.ticker = mf.ticker
      LEFT JOIN sector_master sm ON sm.ticker = mf.ticker
      WHERE mf.date IN (${chunkDates.map(() => '?').join(', ')})
      `,
      chunkDates,
    )
    for (let j = 0; j < rows.length; j += CHUNK) {
      await execBatch(rows.slice(j, j + CHUNK).map((row) => ({
        sql: `
          INSERT OR REPLACE INTO serving_backtest_results
            (date, horizon_days, ticker, name, sector_large, sector_small, market_segment,
             pattern_code, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
             monthly_a_stage, monthly_b_stage, open, high, low, close, volume,
             volume_ratio_20, range_pct, atr20_pct, ma5_pos_pct, ma25_pos_pct, ma75_pos_pct,
             signal_codes, return_pct, max_return_pct, max_return_date, days_to_max,
             min_return_pct, min_return_date, days_to_min, hit_10, hit_20, hit_40, computed_at)
          VALUES (${Array.from({ length: 36 }, () => '?').join(', ')}, unixepoch())
        `,
        args: [
          row.date, row.horizon_days, row.ticker, row.name, row.sector_large, row.sector_small, row.market_segment,
          row.pattern_code, row.daily_a_stage, row.daily_b_stage, row.weekly_a_stage, row.weekly_b_stage,
          row.monthly_a_stage, row.monthly_b_stage, row.open, row.high, row.low, row.close, row.volume,
          row.volume_ratio_20, row.range_pct, row.atr20_pct, row.ma5_pos_pct, row.ma25_pos_pct, row.ma75_pos_pct,
          row.signal_codes, row.return_pct, row.max_return_pct, row.max_return_date, row.days_to_max,
          row.min_return_pct, row.min_return_date, row.days_to_min, row.hit_10, row.hit_20, row.hit_40,
        ],
      })))
      inserted += Math.min(CHUNK, rows.length - j)
    }

    const chunkNo = Math.floor(i / RESULT_DATE_CHUNK) + 1
    if (chunkNo % 10 === 0 || chunkNo === totalChunks) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`serving_backtest_results chunk ${chunkNo}/${totalChunks} rows=${inserted.toLocaleString()} elapsed=${elapsed}m`)
    }
  }
}

async function buildSignalEvidence(dates: string[]): Promise<void> {
  if (DATE_LIMIT === 0) await execRun(`DELETE FROM serving_signal_evidence`)
  else await deleteServingDates('serving_signal_evidence', 'date', dates)

  let inserted = 0
  const totalChunks = Math.ceil(dates.length / EVIDENCE_DATE_CHUNK)
  for (let i = 0; i < dates.length; i += EVIDENCE_DATE_CHUNK) {
    const chunkDates = dates.slice(i, i + EVIDENCE_DATE_CHUNK)
    const rows = await execAll<TechnicalSignalRow>(
      `
      SELECT ticker, date, timescale, ma_period, signal_code, signal_strength,
             direction, label, score_component, value_json
      FROM technical_signals
      WHERE date IN (${chunkDates.map(() => '?').join(', ')})
      `,
      chunkDates,
    )
    for (let j = 0; j < rows.length; j += CHUNK) {
      await execBatch(rows.slice(j, j + CHUNK).map((row) => ({
        sql: `
          INSERT OR REPLACE INTO serving_signal_evidence
            (ticker, date, signal_code, label, reason_json, computed_at)
          VALUES (?, ?, ?, ?, ?, unixepoch())
        `,
        args: [row.ticker, row.date, row.signal_code, row.label, JSON.stringify(reasonForSignal(row))],
      })))
      inserted += Math.min(CHUNK, rows.length - j)
    }
    const chunkNo = Math.floor(i / EVIDENCE_DATE_CHUNK) + 1
    if (chunkNo % 20 === 0 || chunkNo === totalChunks) {
      console.log(`serving_signal_evidence chunk ${chunkNo}/${totalChunks} rows=${inserted.toLocaleString()}`)
    }
  }
}

async function buildBacktestDetails(dates: string[]): Promise<void> {
  if (DETAIL_PER_DATE_HORIZON === 0) {
    console.log('serving_backtest_details: skipped (SERVING_DETAIL_PER_DATE_HORIZON=0)')
    return
  }
  if (DATE_LIMIT === 0) await execRun(`DELETE FROM serving_backtest_details`)
  else await deleteServingDates('serving_backtest_details', 'date', dates)

  let inserted = 0
  for (let i = 0; i < dates.length; i += RESULT_DATE_CHUNK) {
    const chunkDates = dates.slice(i, i + RESULT_DATE_CHUNK)
    const rows = await execAll<BacktestServingRow & { rn: number }>(
      `
      SELECT *
      FROM (
        SELECT
          r.*,
          ROW_NUMBER() OVER (
            PARTITION BY r.date, r.horizon_days
            ORDER BY COALESCE(r.max_return_pct, -999999) DESC
          ) AS rn
        FROM serving_backtest_results r
        WHERE r.date IN (${chunkDates.map(() => '?').join(', ')})
      )
      WHERE rn <= ?
      `,
      [...chunkDates, DETAIL_PER_DATE_HORIZON],
    )
    for (let j = 0; j < rows.length; j += CHUNK) {
      await execBatch(rows.slice(j, j + CHUNK).map((row) => ({
        sql: `
          INSERT OR REPLACE INTO serving_backtest_details
            (date, horizon_days, ticker, detail_json, computed_at)
          VALUES (?, ?, ?, ?, unixepoch())
        `,
        args: [
          row.date,
          row.horizon_days,
          row.ticker,
          JSON.stringify({
            basis: {
              date: row.date,
              close: row.close,
              volume: row.volume,
              volumeRatio20: row.volume_ratio_20,
              patternCode: row.pattern_code,
              signalCodes: (row.signal_codes ?? '').split(',').filter(Boolean),
            },
            outcome: {
              horizonDays: row.horizon_days,
              returnPct: row.return_pct,
              maxReturnPct: row.max_return_pct,
              maxReturnDate: row.max_return_date,
              daysToMax: row.days_to_max,
              minReturnPct: row.min_return_pct,
              minReturnDate: row.min_return_date,
              daysToMin: row.days_to_min,
              hit10: Boolean(row.hit_10),
              hit20: Boolean(row.hit_20),
              hit40: Boolean(row.hit_40),
            },
            note: 'この詳細はTurso配信用に圧縮済みです。ステージ遷移の完全系列はdaily_snapshots同期後に詳細APIで補完します。',
          }),
        ],
      })))
      inserted += Math.min(CHUNK, rows.length - j)
    }
  }
  console.log(`serving_backtest_details: ${inserted.toLocaleString()} rows`)
}

async function buildSimilarCases(date: string): Promise<void> {
  if (SIMILAR_SOURCE_LIMIT === 0) {
    console.log('serving_similar_cases: skipped (SERVING_SIMILAR_SOURCE_LIMIT=0)')
    return
  }
  await execRun(`DELETE FROM serving_similar_cases WHERE source_date = ?`, [date])
  const sources = await execAll<{
    ticker: string
    date: string
    pattern_code: string | null
    ma25_pos_pct: number | null
    volume_ratio_20: number | null
  }>(
    `
    SELECT mf.ticker, mf.date, mf.pattern_code, mf.ma25_pos_pct, mf.volume_ratio_20
    FROM model_features mf
    INNER JOIN serving_latest_signals s ON s.ticker = mf.ticker AND s.date = mf.date
    WHERE mf.date = ?
    ORDER BY s.rank
    LIMIT ?
    `,
    [date, SIMILAR_SOURCE_LIMIT],
  )

  const statements: Array<{ sql: string; args: Array<string | number> }> = []
  for (const source of sources) {
    if (!source.pattern_code) continue
    const cases = await execAll<{
      ticker: string
      date: string
      max_return_pct: number | null
      days_to_max: number | null
      ma25_pos_pct: number | null
      volume_ratio_20: number | null
    }>(
      `
      SELECT mf.ticker, mf.date, fe.max_return_pct, fe.days_to_max, mf.ma25_pos_pct, mf.volume_ratio_20
      FROM model_features mf
      INNER JOIN forward_extrema fe ON fe.ticker = mf.ticker AND fe.date = mf.date AND fe.horizon_days = 40
      WHERE mf.pattern_code = ?
        AND mf.date < ?
        AND mf.ticker <> ?
      ORDER BY fe.max_return_pct DESC
      LIMIT 8
      `,
      [source.pattern_code, source.date, source.ticker],
    )
    for (const [index, row] of cases.entries()) {
      const distance =
        Math.abs((source.ma25_pos_pct ?? 0) - (row.ma25_pos_pct ?? 0)) +
        Math.abs((source.volume_ratio_20 ?? 1) - (row.volume_ratio_20 ?? 1))
      const similarity = Math.max(0, 1 - distance / 20)
      statements.push({
        sql: `
          INSERT OR REPLACE INTO serving_similar_cases
            (source_ticker, source_date, rank, similar_ticker, similar_date, similarity_score, payload_json, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [
          source.ticker,
          source.date,
          index + 1,
          row.ticker,
          row.date,
          Number(similarity.toFixed(4)),
          JSON.stringify(row),
        ],
      })
    }
  }
  for (let i = 0; i < statements.length; i += CHUNK) {
    await execBatch(statements.slice(i, i + CHUNK))
  }
  console.log(`serving_similar_cases: ${statements.length} rows`)
}

async function main() {
  const date = await latestDate()
  if (!date) {
    console.log('model_features is empty; skip serving build')
    return
  }
  console.log(`serving build for ${date}: date_limit=${DATE_LIMIT || 'all'}, summary_date_chunk=${SUMMARY_DATE_CHUNK}`)
  await buildLatestSignals(date)
  await buildSignalStats()
  const dates = await buildBacktestDates()
  await buildBacktestSummaries(dates)
  await buildBacktestResults(dates)
  await buildSignalEvidence(dates)
  await buildBacktestDetails(dates)
  await buildSimilarCases(date)
  console.log('serving build complete')
}

main().catch((error) => {
  console.error('build-serving-backtest failed:', error)
  process.exit(1)
})
