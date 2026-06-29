// scripts/batch-ml-features.ts
//
// 6桁ステージとMA形状をML/RL用の特徴量・ラベルへ変換する。

import { execAll, execBatch, execRun } from '@/lib/db/client'
import { featureVector, type MlFeatureProfile } from '@/lib/backtest/ml'

type Row = {
  date: string
  close: number | null
  high: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type LabelRow = {
  date: string
  horizon_days: number
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
  days_to_max: number | null
  days_to_min: number | null
}

const CHUNK = Number(process.env.ML_BATCH_CHUNK ?? 500)
const RECENT_DAYS = Number(process.env.ML_RECENT_DAYS ?? 260)
const MIN_HISTORY_DAYS = Number(process.env.ML_MIN_HISTORY_DAYS ?? (RECENT_DAYS > 0 ? 200 : 1))
const START_DATE = process.env.ML_START_DATE?.trim() || null
const END_DATE = process.env.ML_END_DATE?.trim() || null
const TICKER_LIMIT = Number(process.env.ML_TICKER_LIMIT ?? 0)
const TICKER_START = process.env.ML_TICKER_START?.trim() || null
const TICKER_END = process.env.ML_TICKER_END?.trim() || null
const HORIZONS = (process.env.ML_HORIZONS ?? '5,10,20,40,60,90')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)

function round(value: number | null | undefined, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function pct(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null
  return ((to - from) / from) * 100
}

function stageCode(row: Row): string {
  return [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ].map((value) => value == null ? '-' : String(value)).join('')
}

function smaSeries(rows: Row[], period: number): Array<number | null> {
  const out: Array<number | null> = []
  let sum = 0
  let valid = 0
  for (let i = 0; i < rows.length; i += 1) {
    const close = rows[i]?.close
    if (close != null && Number.isFinite(close)) {
      sum += close
      valid += 1
    }
    if (i >= period) {
      const oldClose = rows[i - period]?.close
      if (oldClose != null && Number.isFinite(oldClose)) {
        sum -= oldClose
        valid -= 1
      }
    }
    out.push(i >= period - 1 && valid === period ? round(sum / period, 2) : null)
  }
  return out
}

function maOrder(sma: MlFeatureProfile['sma']): string {
  return [
    { label: '5日', value: sma.sma5 },
    { label: '25日', value: sma.sma25 },
    { label: '75日', value: sma.sma75 },
    { label: '200日', value: sma.sma200 },
  ].filter((item): item is { label: string; value: number } => item.value != null)
    .sort((a, b) => b.value - a.value)
    .map((item) => item.label)
    .join(' > ') || '-'
}

function maxHigh(rows: Row[], from: number, to: number): { date: string | null; high: number | null } {
  let date: string | null = null
  let high: number | null = null
  for (let i = Math.max(0, from); i <= Math.min(rows.length - 1, to); i += 1) {
    const value = rows[i]?.high
    if (value == null) continue
    if (high == null || value > high) {
      high = value
      date = rows[i].date
    }
  }
  return { date, high }
}

async function tickers(): Promise<string[]> {
  const where: string[] = []
  const args: string[] = []
  if (TICKER_START) {
    where.push(`ticker >= ?`)
    args.push(TICKER_START)
  }
  if (TICKER_END) {
    where.push(`ticker <= ?`)
    args.push(TICKER_END)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limitSql = TICKER_LIMIT > 0 ? ` LIMIT ${TICKER_LIMIT}` : ''
  const rows = await execAll<{ ticker: string }>(
    `SELECT ticker FROM ohlcv_daily ${whereSql} GROUP BY ticker ORDER BY ticker${limitSql}`,
    args,
  )
  return rows.map((row) => row.ticker)
}

async function history(ticker: string): Promise<Row[]> {
  return execAll<Row>(
    `
    SELECT
      o.date,
      o.close,
      o.high,
      d.daily_a_stage,
      d.daily_b_stage,
      d.weekly_a_stage,
      d.weekly_b_stage,
      d.monthly_a_stage,
      d.monthly_b_stage
    FROM ohlcv_daily o
    LEFT JOIN daily_snapshots d ON d.ticker = o.ticker AND d.date = o.date
    WHERE o.ticker = ?
    ORDER BY o.date
    `,
    [ticker],
  )
}

async function labels(ticker: string): Promise<Map<string, LabelRow[]>> {
  if (HORIZONS.length === 0) return new Map()
  const rows = await execAll<LabelRow>(
    `
    SELECT date, horizon_days, return_pct, max_return_pct, min_return_pct, days_to_max, days_to_min
    FROM forward_extrema
    WHERE ticker = ? AND horizon_days IN (${HORIZONS.map(() => '?').join(', ')})
    `,
    [ticker, ...HORIZONS],
  )
  const map = new Map<string, LabelRow[]>()
  for (const row of rows) {
    const current = map.get(row.date) ?? []
    current.push(row)
    map.set(row.date, current)
  }
  return map
}

async function buildTicker(ticker: string): Promise<{ features: number; labels: number; states: number }> {
  const rows = await history(ticker)
  if (rows.length < Math.max(1, MIN_HISTORY_DAYS)) return { features: 0, labels: 0, states: 0 }
  const labelMap = await labels(ticker)
  const ma5 = smaSeries(rows, 5)
  const ma25 = smaSeries(rows, 25)
  const ma75 = smaSeries(rows, 75)
  const ma200 = smaSeries(rows, 200)
  const stageCodes = rows.map(stageCode)
  const daysAbove5: number[] = []
  let currentAbove = 0

  const minHistoryIndex = Math.max(0, MIN_HISTORY_DAYS - 1)
  const recentIndex = RECENT_DAYS > 0 ? Math.max(minHistoryIndex, rows.length - RECENT_DAYS) : minHistoryIndex
  const startDateIndex = START_DATE ? rows.findIndex((row) => row.date >= START_DATE) : -1
  const firstIndex = Math.max(recentIndex, startDateIndex >= 0 ? startDateIndex : 0)
  const featureStmts: Array<{ sql: string; args: Array<string | number | null> }> = []
  const labelStmts: Array<{ sql: string; args: Array<string | number | null> }> = []
  const stateStmts: Array<{ sql: string; args: Array<string | number | null> }> = []

  for (let i = 0; i < rows.length; i += 1) {
    if (ma5[i] != null && rows[i].close != null && (rows[i].close ?? 0) >= (ma5[i] ?? 0)) currentAbove += 1
    else currentAbove = 0
    daysAbove5[i] = currentAbove
  }

  for (let i = firstIndex; i < rows.length; i += 1) {
    const row = rows[i]
    if (END_DATE && row.date > END_DATE) break
    const sma = { sma5: ma5[i] ?? null, sma25: ma25[i] ?? null, sma75: ma75[i] ?? null, sma200: ma200[i] ?? null }
    const priorHigh = maxHigh(rows, i - 60, i - 1)
    const recentHigh = maxHigh(rows, i - 60, i)
    const profile: MlFeatureProfile = {
      ticker,
      date: row.date,
      close: row.close,
      stageCode: stageCodes[i],
      prevStageCode: i > 0 ? stageCodes[i - 1] : null,
      maOrder: maOrder(sma),
      sma,
      slopes5: {
        sma5: round(pct(ma5[i - 5], ma5[i])),
        sma25: round(pct(ma25[i - 5], ma25[i])),
        sma75: round(pct(ma75[i - 5], ma75[i])),
        sma200: round(pct(ma200[i - 5], ma200[i])),
      },
      slopes10: {
        sma5: round(pct(ma5[i - 10], ma5[i])),
        sma25: round(pct(ma25[i - 10], ma25[i])),
        sma75: round(pct(ma75[i - 10], ma75[i])),
        sma200: round(pct(ma200[i - 10], ma200[i])),
      },
      gaps: {
        sma5To25Pct: round(pct(ma25[i], ma5[i])),
        sma25To75Pct: round(pct(ma75[i], ma25[i])),
        sma75To200Pct: round(pct(ma200[i], ma75[i])),
      },
      pricePosition: {
        sma5: round(pct(ma5[i], row.close)),
        sma25: round(pct(ma25[i], row.close)),
        sma75: round(pct(ma75[i], row.close)),
        sma200: round(pct(ma200[i], row.close)),
      },
      daysHeldAboveSma5: daysAbove5[i] || null,
      recentHighDate: recentHigh.date,
      recentHigh: recentHigh.high,
      distanceToRecentHighPct: round(pct(recentHigh.high, row.close)),
      brokeRecentHigh: priorHigh.high != null && row.close != null ? row.close > priorHigh.high : false,
    }
    const vector = featureVector(profile)
    featureStmts.push({
      sql: `
        INSERT OR REPLACE INTO ml_feature_vectors
          (ticker, date, stage_code, feature_json, vector_json, computed_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
      `,
      args: [ticker, row.date, profile.stageCode, JSON.stringify(profile), JSON.stringify(vector)],
    })

    for (const label of labelMap.get(row.date) ?? []) {
      const upLabel = (label.max_return_pct ?? -Infinity) >= 10 ? 1 : 0
      const downLabel = (label.min_return_pct ?? Infinity) <= -5 ? 1 : 0
      const reward = round((label.max_return_pct ?? label.return_pct ?? 0) + Math.min(0, label.min_return_pct ?? 0) * 0.5)
      const labelJson = JSON.stringify({
        daysToMax: label.days_to_max,
        daysToMin: label.days_to_min,
        upLabel,
        downLabel,
      })
      labelStmts.push({
        sql: `
          INSERT OR REPLACE INTO ml_training_labels
            (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct, up_label, down_label, reward_score, label_json, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [ticker, row.date, label.horizon_days, label.return_pct, label.max_return_pct, label.min_return_pct, upLabel, downLabel, reward, labelJson],
      })
      if (label.horizon_days === 40) {
        stateStmts.push({
          sql: `
            INSERT OR REPLACE INTO rl_training_states
              (ticker, date, horizon_days, action, state_json, reward, next_state_json, computed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
          `,
          args: [ticker, row.date, label.horizon_days, 'watch_up', JSON.stringify(profile), label.max_return_pct, null],
        })
        stateStmts.push({
          sql: `
            INSERT OR REPLACE INTO rl_training_states
              (ticker, date, horizon_days, action, state_json, reward, next_state_json, computed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
          `,
          args: [ticker, row.date, label.horizon_days, 'watch_down', JSON.stringify(profile), label.min_return_pct, null],
        })
      }
    }
  }

  for (let i = 0; i < featureStmts.length; i += CHUNK) await execBatch(featureStmts.slice(i, i + CHUNK))
  for (let i = 0; i < labelStmts.length; i += CHUNK) await execBatch(labelStmts.slice(i, i + CHUNK))
  for (let i = 0; i < stateStmts.length; i += CHUNK) await execBatch(stateStmts.slice(i, i + CHUNK))
  return { features: featureStmts.length, labels: labelStmts.length, states: stateStmts.length }
}

async function main() {
  await execRun(`DELETE FROM ml_models WHERE model_name LIKE 'stale_schema_probe_never_used'`)
  const codes = await tickers()
  let featureCount = 0
  let labelCount = 0
  let stateCount = 0
  const started = Date.now()
  console.log(
    `ml feature build: tickers=${codes.length}, recent_days=${RECENT_DAYS || 'all'}, min_history_days=${MIN_HISTORY_DAYS}, start=${START_DATE ?? '-'}, end=${END_DATE ?? '-'}, horizons=${HORIZONS.join('/')}`,
  )
  if (TICKER_START || TICKER_END) console.log(`ml feature ticker range: ${TICKER_START ?? '-'}..${TICKER_END ?? '-'}`)

  for (const [index, ticker] of codes.entries()) {
    const result = await buildTicker(ticker)
    featureCount += result.features
    labelCount += result.labels
    stateCount += result.states
    if ((index + 1) % 100 === 0 || index === codes.length - 1) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      console.log(`ml features ${index + 1}/${codes.length}: features=${featureCount.toLocaleString()} labels=${labelCount.toLocaleString()} states=${stateCount.toLocaleString()} elapsed=${elapsed}m`)
    }
  }
}

main().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
