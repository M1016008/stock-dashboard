import { execAll, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { NIKKEI225_TICKERS, parseUniverseFilter, universeSqlCondition } from '@/lib/market-universe'
import { getCurrentSimilars } from '@/lib/queries/ml-insights'
import type {
  AssistantPlannedToolCall,
  AssistantResultRow,
  AssistantToolResult,
} from '@/lib/assistant/types'

type SearchRow = {
  ticker: string
  name: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
}

type StockOverviewRow = SearchRow & {
  date: string | null
  close: number | null
  prev_close: number | null
  volume: number | null
  avg_volume_30d: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  physics_up_rank: number | null
  physics_up_score: number | null
  physics_down_rank: number | null
  physics_down_score: number | null
  classic_up_rank: number | null
  classic_down_rank: number | null
}

type ScreenRow = StockOverviewRow

type EarningsRow = {
  ticker: string
  name: string | null
  announce_date: string
  fiscal_period: string | null
  close: number | null
  volume: number | null
  avg_volume_30d: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
}

type VectorRow = {
  ticker: string
  date: string
  stage_code: string | null
  vector_json: string
  feature_json: string | null
  name: string | null
  sector17_name: string | null
  sector33_name: string | null
}

function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ticker = value.trim().toUpperCase().replace(/\.T$/i, '')
  return /^[0-9A-Z]{1,8}$/.test(ticker) ? ticker : null
}

function clampLimit(value: unknown, fallback = 8, max = 30): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(1, Math.floor(n)))
}

function stageCode(row: {
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}): string | null {
  const values = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  if (values.every((v) => v == null)) return null
  return values.map((v) => (v == null ? '-' : String(v))).join('')
}

function pctChange(close: number | null, prevClose: number | null): number | null {
  if (close == null || prevClose == null || prevClose <= 0) return null
  return ((close - prevClose) / prevClose) * 100
}

function fmtPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function vectorDistance(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let sum = 0
  let used = 0
  for (let i = 0; i < length; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    const diff = a[i] - b[i]
    sum += diff * diff
    used += 1
  }
  return used === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sum / used)
}

function stockHref(ticker: string): string {
  return `/stock/${encodeURIComponent(ticker)}`
}

function rowFromOverview(row: StockOverviewRow): AssistantResultRow {
  const code = stageCode(row)
  const changePct = pctChange(row.close, row.prev_close)
  const reasonParts = [
    code ? `6桁ステージ ${code}` : null,
    row.physics_up_rank ? `物理ML上昇#${row.physics_up_rank}` : null,
    row.physics_down_rank ? `物理ML下落#${row.physics_down_rank}` : null,
    row.avg_volume_30d ? `30日平均出来高 ${Math.round(row.avg_volume_30d).toLocaleString()}` : null,
  ].filter(Boolean)
  return {
    ticker: row.ticker,
    name: row.name,
    href: stockHref(row.ticker),
    date: row.date,
    price: row.close,
    changePct,
    volume: row.volume,
    avgVolume30d: row.avg_volume_30d,
    stageCode: code,
    sector17Name: row.sector17_name,
    sector33Name: row.sector33_name,
    marketSegment: row.market_segment,
    marginType: row.margin_type,
    score: row.physics_up_score ?? row.physics_down_score ?? null,
    reason: reasonParts.join(' / ') || null,
  }
}

async function latestSnapshotDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM daily_snapshots`))?.date ?? null
}

async function latestPhysicsDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM serving_ml_physics_candidates`))?.date ?? null
}

async function latestClassicMlDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM serving_ml_candidates`))?.date ?? null
}

export async function searchStocks(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const query = (call.query ?? call.ticker ?? '').trim()
  if (!query) {
    return { tool: 'search_stocks', title: '銘柄検索', summary: '検索語が不足しています。', rows: [] }
  }
  const escaped = query.replace(/[%_]/g, (m) => `\\${m}`)
  const rows = await execAll<SearchRow>(
    `
    SELECT ticker, name, sector17_name, sector33_name, market_segment, margin_type
    FROM ticker_universe
    WHERE active = 1
      AND (ticker LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
    ORDER BY CASE WHEN ticker = ? THEN 0 ELSE 1 END, ticker ASC
    LIMIT ?
    `,
    [`%${escaped}%`, `%${escaped}%`, query, clampLimit(call.limit, 8, 20)],
  )
  return {
    tool: 'search_stocks',
    title: '銘柄検索',
    summary: `${query} に一致する銘柄を ${rows.length} 件見つけました。`,
    rows: rows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      href: stockHref(row.ticker),
      sector17Name: row.sector17_name,
      sector33Name: row.sector33_name,
      marketSegment: row.market_segment,
      marginType: row.margin_type,
      reason: [row.sector17_name, row.sector33_name, row.margin_type].filter(Boolean).join(' / ') || null,
    })),
  }
}

export async function getStockOverview(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const ticker = normalizeTicker(call.ticker)
  if (!ticker) {
    return { tool: 'get_stock_overview', title: '個別銘柄分析', summary: '銘柄コードが不足しています。', rows: [] }
  }
  const [snapshotDate, physicsDate, classicDate] = await Promise.all([
    latestSnapshotDate(),
    latestPhysicsDate(),
    latestClassicMlDate(),
  ])
  if (!snapshotDate) {
    return { tool: 'get_stock_overview', title: '個別銘柄分析', summary: '日次スナップショットが未作成です。', rows: [] }
  }
  const row = await execGet<StockOverviewRow>(
    `
    WITH prev_date AS (
      SELECT MAX(date) AS date FROM ohlcv_daily WHERE ticker = ? AND date < ?
    ),
    avg_volume AS (
      SELECT AVG(volume) AS avg_volume_30d
      FROM (
        SELECT volume
        FROM ohlcv_daily
        WHERE ticker = ? AND date <= ?
        ORDER BY date DESC
        LIMIT 30
      )
    )
    SELECT
      u.ticker,
      u.name,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type,
      ds.date,
      od.close,
      prev.close AS prev_close,
      od.volume,
      avg_volume.avg_volume_30d,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      ds.ma_5,
      ds.ma_25,
      ds.ma_75,
      ds.ma_300,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      c_up.rank AS classic_up_rank,
      c_down.rank AS classic_down_rank
    FROM ticker_universe u
    LEFT JOIN daily_snapshots ds ON ds.ticker = u.ticker AND ds.date = ?
    LEFT JOIN ohlcv_daily od ON od.ticker = u.ticker AND od.date = ds.date
    LEFT JOIN prev_date pd ON 1 = 1
    LEFT JOIN ohlcv_daily prev ON prev.ticker = u.ticker AND prev.date = pd.date
    LEFT JOIN avg_volume ON 1 = 1
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = u.ticker AND p_up.as_of_date = ? AND p_up.horizon_days = ? AND p_up.direction = 'up'
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = u.ticker AND p_down.as_of_date = ? AND p_down.horizon_days = ? AND p_down.direction = 'down'
    LEFT JOIN serving_ml_candidates c_up
      ON c_up.ticker = u.ticker AND c_up.as_of_date = ? AND c_up.direction = 'up'
    LEFT JOIN serving_ml_candidates c_down
      ON c_down.ticker = u.ticker AND c_down.as_of_date = ? AND c_down.direction = 'down'
    WHERE u.ticker = ?
    LIMIT 1
    `,
    [
      ticker,
      snapshotDate,
      ticker,
      snapshotDate,
      snapshotDate,
      physicsDate ?? '',
      Number(call.horizonDays ?? 20),
      physicsDate ?? '',
      Number(call.horizonDays ?? 20),
      classicDate ?? '',
      classicDate ?? '',
      ticker,
    ],
  )
  if (!row) {
    return { tool: 'get_stock_overview', title: '個別銘柄分析', summary: `${ticker} は見つかりませんでした。`, rows: [] }
  }
  const result = rowFromOverview(row)
  const directionNote = row.physics_down_rank && (!row.physics_up_rank || row.physics_down_rank < row.physics_up_rank)
    ? `下落警戒の物理ML順位が強めです。`
    : row.physics_up_rank
      ? `上昇候補の物理ML順位があります。`
      : `物理ML候補には入っていません。`
  return {
    tool: 'get_stock_overview',
    title: `${ticker} 個別分析`,
    summary: `${row.name ?? ticker} は ${snapshotDate} 時点で ${result.stageCode ?? 'ステージ未判定'}。${directionNote}`,
    href: stockHref(ticker),
    rows: [result],
    meta: { snapshotDate, physicsDate, classicDate },
  }
}

export async function screenJpStocks(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const [snapshotDate, physicsDate, classicDate] = await Promise.all([
    latestSnapshotDate(),
    latestPhysicsDate(),
    latestClassicMlDate(),
  ])
  if (!snapshotDate) {
    return { tool: 'screen_jp_stocks', title: 'スクリーニング', summary: '日次スナップショットが未作成です。', rows: [] }
  }

  const direction = call.direction === 'down' ? 'down' : call.direction === 'neutral' ? 'neutral' : 'up'
  const horizonDays = Number(call.horizonDays ?? 20)
  const limit = clampLimit(call.limit, 10, 30)
  const where: string[] = ['ds.date = ?', 'u.active = 1', "COALESCE(u.market_segment, '') <> 'その他'"]
  const args: Array<string | number> = [snapshotDate]
  const universe = universeSqlCondition('ds.ticker', parseUniverseFilter(call.universe))
  if (universe.sql) {
    where.push(universe.sql)
    args.push(...universe.params)
  }
  if (call.marginType?.trim()) {
    where.push('u.margin_type = ?')
    args.push(call.marginType.trim())
  }
  if (call.sector17?.trim()) {
    where.push('u.sector17_name = ?')
    args.push(call.sector17.trim())
  }
  if (call.stageCode?.trim() && /^[1-6-]{1,6}$/.test(call.stageCode.trim())) {
    const code = call.stageCode.trim()
    const cols = ['daily_a_stage', 'daily_b_stage', 'weekly_a_stage', 'weekly_b_stage', 'monthly_a_stage', 'monthly_b_stage']
    code.split('').forEach((ch, index) => {
      if (ch === '-' || !cols[index]) return
      where.push(`ds.${cols[index]} = ?`)
      args.push(Number(ch))
    })
  }
  const minAvgVolume = Number(call.minAvgVolume ?? 0)
  if (Number.isFinite(minAvgVolume) && minAvgVolume > 0) {
    where.push('avg_volume.avg_volume_30d >= ?')
    args.push(minAvgVolume)
  }
  if (direction === 'up') where.push('p_up.rank IS NOT NULL')
  if (direction === 'down') where.push('p_down.rank IS NOT NULL')

  const orderBy = direction === 'down'
    ? 'p_down.rank ASC, p_down.candidate_score DESC, avg_volume.avg_volume_30d DESC'
    : direction === 'up'
      ? 'p_up.rank ASC, p_up.candidate_score DESC, avg_volume.avg_volume_30d DESC'
      : call.sort === 'volume'
        ? 'avg_volume.avg_volume_30d DESC'
        : 'ABS(COALESCE(od.close - prev.close, 0)) DESC'

  const rows = await execAll<ScreenRow>(
    `
    WITH prev_dates AS (
      SELECT ticker, MAX(date) AS prev_date
      FROM ohlcv_daily
      WHERE date < ?
      GROUP BY ticker
    ),
    avg_volume AS (
      SELECT ticker, AVG(volume) AS avg_volume_30d
      FROM (
        SELECT ticker, volume, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
        FROM ohlcv_daily
        WHERE date <= ?
      )
      WHERE rn <= 30
      GROUP BY ticker
    )
    SELECT
      u.ticker,
      u.name,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type,
      ds.date,
      od.close,
      prev.close AS prev_close,
      od.volume,
      avg_volume.avg_volume_30d,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      ds.ma_5,
      ds.ma_25,
      ds.ma_75,
      ds.ma_300,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      c_up.rank AS classic_up_rank,
      c_down.rank AS classic_down_rank
    FROM daily_snapshots ds
    INNER JOIN ticker_universe u ON u.ticker = ds.ticker
    LEFT JOIN ohlcv_daily od ON od.ticker = ds.ticker AND od.date = ds.date
    LEFT JOIN prev_dates pd ON pd.ticker = ds.ticker
    LEFT JOIN ohlcv_daily prev ON prev.ticker = ds.ticker AND prev.date = pd.prev_date
    LEFT JOIN avg_volume ON avg_volume.ticker = ds.ticker
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = ds.ticker AND p_up.as_of_date = ? AND p_up.horizon_days = ? AND p_up.direction = 'up'
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = ds.ticker AND p_down.as_of_date = ? AND p_down.horizon_days = ? AND p_down.direction = 'down'
    LEFT JOIN serving_ml_candidates c_up
      ON c_up.ticker = ds.ticker AND c_up.as_of_date = ? AND c_up.direction = 'up'
    LEFT JOIN serving_ml_candidates c_down
      ON c_down.ticker = ds.ticker AND c_down.as_of_date = ? AND c_down.direction = 'down'
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}, ds.ticker ASC
    LIMIT ?
    `,
    [
      snapshotDate,
      snapshotDate,
      physicsDate ?? '',
      horizonDays,
      physicsDate ?? '',
      horizonDays,
      classicDate ?? '',
      classicDate ?? '',
      ...args,
      limit,
    ],
  )
  const hrefParams = new URLSearchParams()
  hrefParams.set('limit', String(limit))
  if (call.universe) hrefParams.set('universe', call.universe)
  if (call.marginType) hrefParams.set('marginType', call.marginType)
  if (minAvgVolume > 0) hrefParams.set('volumeMin', String(Math.floor(minAvgVolume)))
  hrefParams.set('sort', call.sort === 'volume' ? 'avgVolume30d' : 'volume')
  hrefParams.set('dir', 'desc')
  const title = direction === 'down' ? '下落警戒候補' : direction === 'up' ? '上昇候補' : 'スクリーニング候補'
  return {
    tool: 'screen_jp_stocks',
    title,
    summary: `${snapshotDate} 時点で ${title} を ${rows.length} 件抽出しました。${call.universe ? '日経225に限定しています。' : ''}`,
    href: `/screener?${hrefParams.toString()}`,
    rows: rows.map((row) => ({
      ...rowFromOverview(row),
      rank: direction === 'down' ? row.physics_down_rank : row.physics_up_rank,
      direction,
      score: direction === 'down' ? row.physics_down_score : row.physics_up_score,
    })),
    meta: { snapshotDate, physicsDate, classicDate, horizonDays },
  }
}

export async function getMlSimilars(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const ticker = normalizeTicker(call.ticker)
  if (!ticker) {
    return { tool: 'get_ml_similars', title: 'ML類似銘柄', summary: '銘柄コードが不足しています。', rows: [] }
  }
  const result = await getCurrentSimilars({ ticker, limit: clampLimit(call.limit, 8, 20) })
  let rows: AssistantResultRow[] = result.rows.map((row) => {
    const payload = row.payload as Record<string, unknown>
    const reason = row.reason as Record<string, unknown>
    return {
      ticker: row.similarTicker,
      name: typeof payload.name === 'string' ? payload.name : null,
      href: stockHref(row.similarTicker),
      rank: row.rank,
      score: row.similarityScore,
      direction: row.similarDirection,
      stageCode: typeof payload.stageCode === 'string' ? payload.stageCode : null,
      sector17Name: typeof payload.sector17Name === 'string' ? payload.sector17Name : null,
      reason: typeof reason.summary === 'string'
        ? reason.summary
        : `類似度 ${Math.round(row.similarityScore * 100)}%`,
    }
  })
  let source = 'serving_current_similars'
  let asOfDate = result.asOfDate
  if (rows.length === 0) {
    const fallback = await getMlSimilarsFromVectors(ticker, clampLimit(call.limit, 8, 20))
    rows = fallback.rows
    source = fallback.source
    asOfDate = fallback.asOfDate ?? asOfDate
  }
  return {
    tool: 'get_ml_similars',
    title: `${ticker} に似た現在銘柄`,
    summary: asOfDate
      ? `${asOfDate} 時点の物理特徴量・ステージ類似で ${rows.length} 件見つけました。`
      : 'ML類似データがまだ生成されていません。',
    href: `/stock/${ticker}`,
    rows,
    meta: { asOfDate, source },
  }
}

async function getMlSimilarsFromVectors(ticker: string, limit: number): Promise<{ asOfDate: string | null; source: string; rows: AssistantResultRow[] }> {
  const date = (await execGet<{ date: string | null }>(
    `
    SELECT MAX(date) AS date
    FROM ml_feature_vectors_v2
    WHERE feature_set = ? AND ticker = ?
    `,
    [ML_PHYSICS_FEATURE_SET, ticker],
  ))?.date ?? null
  if (!date) return { asOfDate: null, source: 'ml_feature_vectors_v2_fallback', rows: [] }
  const base = await execGet<VectorRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.vector_json, f.feature_json,
           u.name, u.sector17_name, u.sector33_name
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.feature_set = ? AND f.ticker = ? AND f.date = ?
    LIMIT 1
    `,
    [ML_PHYSICS_FEATURE_SET, ticker, date],
  )
  const baseVector = parseJson<number[]>(base?.vector_json, [])
  if (baseVector.length === 0) return { asOfDate: date, source: 'ml_feature_vectors_v2_fallback', rows: [] }
  const candidates = await execAll<VectorRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.vector_json, f.feature_json,
           u.name, u.sector17_name, u.sector33_name
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.feature_set = ? AND f.date = ? AND f.ticker <> ?
    LIMIT 8000
    `,
    [ML_PHYSICS_FEATURE_SET, date, ticker],
  )
  const ranked = candidates
    .map((row) => {
      const distance = vectorDistance(baseVector, parseJson<number[]>(row.vector_json, []))
      const feature = parseJson<Record<string, unknown>>(row.feature_json, {})
      return { row, distance, score: Number.isFinite(distance) ? 1 / (1 + distance) : 0, feature }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return {
    asOfDate: date,
    source: 'ml_feature_vectors_v2_fallback',
    rows: ranked.map((item, index) => ({
      ticker: item.row.ticker,
      name: item.row.name,
      href: stockHref(item.row.ticker),
      rank: index + 1,
      score: item.score,
      stageCode: typeof item.feature.stageCode === 'string' ? item.feature.stageCode : item.row.stage_code,
      sector17Name: item.row.sector17_name,
      sector33Name: item.row.sector33_name,
      reason: `オンデマンド類似度 ${Math.round(item.score * 100)}% / 距離 ${item.distance.toFixed(3)}`,
    })),
  }
}

function jstToday(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`
}

export async function getEarningsCandidates(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  const snapshotDate = await latestSnapshotDate()
  if (!snapshotDate) {
    return { tool: 'get_earnings_candidates', title: '決算候補', summary: '日次スナップショットが未作成です。', rows: [] }
  }
  const today = jstToday()
  const daysAhead = Math.min(90, Math.max(1, Number(call.daysAhead ?? 14)))
  const limit = clampLimit(call.limit, 10, 30)
  const where: string[] = ['e.announce_date >= ?', "COALESCE(u.market_segment, '') <> 'その他'"]
  const args: Array<string | number> = [today]
  const universe = universeSqlCondition('e.ticker', parseUniverseFilter(call.universe))
  if (universe.sql) {
    where.push(universe.sql)
    args.push(...universe.params)
  }
  if (call.marginType?.trim()) {
    where.push('u.margin_type = ?')
    args.push(call.marginType.trim())
  }
  const minAvgVolume = Number(call.minAvgVolume ?? 0)
  if (Number.isFinite(minAvgVolume) && minAvgVolume > 0) {
    where.push('avg_volume.avg_volume_30d >= ?')
    args.push(minAvgVolume)
  }
  where.push(`e.announce_date <= date(?, '+' || ? || ' day')`)
  args.push(today, daysAhead)

  const rows = await execAll<EarningsRow>(
    `
    WITH avg_volume AS (
      SELECT ticker, AVG(volume) AS avg_volume_30d
      FROM (
        SELECT ticker, volume, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
        FROM ohlcv_daily
        WHERE date <= ?
      )
      WHERE rn <= 30
      GROUP BY ticker
    )
    SELECT
      e.ticker,
      COALESCE(e.company_name, u.name) AS name,
      e.announce_date,
      e.fiscal_period,
      od.close,
      od.volume,
      avg_volume.avg_volume_30d,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type
    FROM earnings_calendar e
    LEFT JOIN ticker_universe u ON u.ticker = e.ticker
    LEFT JOIN daily_snapshots ds ON ds.ticker = e.ticker AND ds.date = ?
    LEFT JOIN ohlcv_daily od ON od.ticker = e.ticker AND od.date = ds.date
    LEFT JOIN avg_volume ON avg_volume.ticker = e.ticker
    WHERE ${where.join(' AND ')}
    ORDER BY e.announce_date ASC, avg_volume.avg_volume_30d DESC, e.ticker ASC
    LIMIT ?
    `,
    [snapshotDate, snapshotDate, ...args, limit],
  )
  const params = new URLSearchParams({ date: today, days: String(daysAhead), sort: 'avgVolume30', dir: 'desc', limit: String(limit) })
  if (call.universe) params.set('universe', call.universe)
  if (call.marginType) params.set('marginType', call.marginType)
  if (minAvgVolume > 0) params.set('avgVolumeMin', String(Math.floor(minAvgVolume)))
  return {
    tool: 'get_earnings_candidates',
    title: '決算候補',
    summary: `${today} から ${daysAhead} 日以内の決算予定を ${rows.length} 件抽出しました。`,
    href: `/earnings?${params.toString()}`,
    rows: rows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      href: stockHref(row.ticker),
      date: row.announce_date,
      price: row.close,
      volume: row.volume,
      avgVolume30d: row.avg_volume_30d,
      stageCode: stageCode(row),
      sector17Name: row.sector17_name,
      sector33Name: row.sector33_name,
      marketSegment: row.market_segment,
      marginType: row.margin_type,
      reason: `${row.announce_date}${row.fiscal_period ? ` / ${row.fiscal_period}` : ''} / 30日平均出来高 ${row.avg_volume_30d ? Math.round(row.avg_volume_30d).toLocaleString() : '-'}`,
    })),
    meta: { snapshotDate, today, daysAhead },
  }
}

export async function runAssistantTool(call: AssistantPlannedToolCall): Promise<AssistantToolResult> {
  switch (call.tool) {
    case 'search_stocks':
      return searchStocks(call)
    case 'get_stock_overview':
      return getStockOverview(call)
    case 'screen_jp_stocks':
      return screenJpStocks(call)
    case 'get_ml_similars':
      return getMlSimilars(call)
    case 'get_earnings_candidates':
      return getEarningsCandidates(call)
    default:
      return {
        tool: 'search_stocks',
        title: '未対応の操作',
        summary: 'この操作はまだAIアシスタントに登録されていません。',
        rows: [],
      }
  }
}

export function buildNavigateActions(results: AssistantToolResult[]) {
  return results
    .filter((result) => result.href)
    .slice(0, 4)
    .map((result) => ({
      type: 'navigate' as const,
      label: `${result.title}を開く`,
      href: result.href as string,
    }))
}

export function describeResults(results: AssistantToolResult[]): string {
  const totalRows = results.reduce((sum, result) => sum + result.rows.length, 0)
  if (results.length === 0) return '条件に合う機能を特定できませんでした。銘柄コードや条件を少し具体化してください。'
  if (totalRows === 0) return results.map((result) => result.summary).join(' ')
  const titles = results.map((result) => `${result.title}${result.rows.length ? ` ${result.rows.length}件` : ''}`).join('、')
  return `${titles}を表示しました。候補の根拠は各カードのステージ、物理ML順位、出来高、決算日を確認してください。`
}

export const assistantToolDescriptions = `
利用可能ツール:
- search_stocks: 銘柄名またはコードを検索する。
- get_stock_overview: 1銘柄の6ステージ、価格、出来高、ML候補状況を確認する。
- screen_jp_stocks: 日本株を6ステージ、物理ML上昇/下落、日経225、貸借、出来高で抽出する。
- get_ml_similars: 指定銘柄に似た現在銘柄をML類似で探す。
- get_earnings_candidates: 近い決算予定銘柄を抽出する。
日経225指定は universe=nikkei225。貸借指定は marginType=貸借。空売り/下落警戒は direction=down。上昇候補は direction=up。
日経225の候補数は ${NIKKEI225_TICKERS.length}。
`
