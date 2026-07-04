import { NextRequest, NextResponse } from 'next/server'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { ML_PHYSICS_FEATURE_SET, ML_PHYSICS_MODEL_TYPE } from '@/lib/backtest/ml-physics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

type RouteContext = {
  params: Promise<{ ticker: string }>
}

type StatusTone = 'ok' | 'info' | 'warn' | 'missing'

type StatusItem = {
  key: string
  label: string
  status: StatusTone
  badge: string
  date: string | null
  count: number | null
  detail: string
  evidence: string[]
}

type CountRow = {
  count: number | null
}

type SqlArg = string | number | null

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase()
}

function numeric(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function countValue(row: CountRow | undefined): number | null {
  return numeric(row?.count)
}

function dateState(actual: string | null, expected: string | null): StatusTone {
  if (!actual) return 'missing'
  if (!expected) return 'ok'
  return actual >= expected ? 'ok' : 'warn'
}

function dateBadge(actual: string | null, expected: string | null, ok = '反映済み'): string {
  if (!actual) return '未生成'
  if (!expected || actual >= expected) return ok
  return '鮮度差あり'
}

function fmtCount(value: number | null): string {
  if (value == null) return '-'
  return value.toLocaleString('en-US')
}

function trainedAtText(epoch: number | null): string | null {
  if (!epoch) return null
  const date = new Date(epoch * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

async function safeGet<T = Record<string, unknown>>(sql: string, args: readonly SqlArg[] = []): Promise<T | undefined> {
  try {
    return await execUsAnalyticsGet<T>(sql, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('no such index')) return undefined
    throw error
  }
}

async function safeAll<T = Record<string, unknown>>(sql: string, args: readonly SqlArg[] = []): Promise<T[]> {
  try {
    return await execUsAnalyticsAll<T>(sql, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('no such index')) return []
    throw error
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { ticker: rawTicker } = await context.params
  const ticker = normalizeTicker(rawTicker)
  const requestedDate = request.nextUrl.searchParams.get('date')?.trim()
  const asOfDate = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : null

  if (!hasUsAnalyticsDb()) {
    return NextResponse.json({
      ok: true,
      market: 'US',
      ticker,
      dbAvailable: false,
      featureSet: ML_PHYSICS_FEATURE_SET,
      modelType: ML_PHYSICS_MODEL_TYPE,
      summary: {
        status: 'missing',
        label: 'US分析DB未接続',
        detail: 'US MLステータスを表示するためのUS分析DBが見つかりません。',
      },
      items: [] satisfies StatusItem[],
    })
  }

  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const asOfArgs = asOfDate ? [asOfDate] : []
  const tickerDateArgs = asOfDate ? [ticker, asOfDate] : [ticker]

  const [
    globalPriceDate,
    tickerPrice,
    tickerSnapshot,
    tickerMomentum,
    globalMomentumDate,
    tickerFeature,
    globalFeature,
    candidateLatest,
    similarLatest,
    evalSummary,
    modelSummary,
    rlSummary,
    latestHealthCheckDate,
  ] = await Promise.all([
    safeGet<{ date: string | null }>(
      `SELECT date FROM ohlcv_daily INDEXED BY ohlcv_date_idx WHERE 1 = 1 ${dateFilter} ORDER BY date DESC LIMIT 1`,
      asOfArgs,
    ),
    safeGet<{ date: string | null; close: number | null; volume: number | null }>(
      `
        SELECT date, close, volume
        FROM ohlcv_daily
        WHERE ticker = ?
          ${dateFilter}
        ORDER BY date DESC
        LIMIT 1
      `,
      tickerDateArgs,
    ),
    safeGet<{ date: string | null }>(
      `
        SELECT date
        FROM daily_snapshots
        WHERE ticker = ?
          ${dateFilter}
        ORDER BY date DESC
        LIMIT 1
      `,
      tickerDateArgs,
    ),
    safeGet<{
      date: string | null
      physicalMomentumScore: number | null
      physicalForceScore: number | null
      physicalEnergyScore: number | null
    }>(
      `
        SELECT
          date,
          physical_momentum_score AS physicalMomentumScore,
          physical_force_score AS physicalForceScore,
          physical_energy_score AS physicalEnergyScore
        FROM physical_momentum_metrics
        WHERE market = 'US'
          AND symbol = ?
          ${dateFilter}
          AND physical_momentum_score IS NOT NULL
        ORDER BY date DESC
        LIMIT 1
      `,
      tickerDateArgs,
    ),
    safeGet<{ date: string | null }>(
      `
        SELECT date
        FROM physical_momentum_metrics INDEXED BY physical_momentum_market_date_idx
        WHERE market = 'US'
          ${dateFilter}
        ORDER BY date DESC
        LIMIT 1
      `,
      asOfArgs,
    ),
    safeGet<{ date: string | null; stageCode: string | null }>(
      `
        SELECT date, stage_code AS stageCode
        FROM ml_feature_vectors_v2
        WHERE feature_set = ?
          AND ticker = ?
          ${dateFilter}
        ORDER BY date DESC
        LIMIT 1
      `,
      asOfDate ? [ML_PHYSICS_FEATURE_SET, ticker, asOfDate] : [ML_PHYSICS_FEATURE_SET, ticker],
    ),
    safeGet<{ date: string | null; count: number | null }>(
      `
        WITH latest AS (
          SELECT date
          FROM ml_feature_vectors_v2 INDEXED BY ml_feature_vectors_v2_date_idx
          WHERE feature_set = ?
            ${dateFilter}
          ORDER BY date DESC
          LIMIT 1
        )
        SELECT latest.date, COUNT(f.ticker) AS count
        FROM latest
        LEFT JOIN ml_feature_vectors_v2 f
          ON f.feature_set = ?
         AND f.date = latest.date
        GROUP BY latest.date
      `,
      asOfDate ? [ML_PHYSICS_FEATURE_SET, asOfDate, ML_PHYSICS_FEATURE_SET] : [ML_PHYSICS_FEATURE_SET, ML_PHYSICS_FEATURE_SET],
    ),
    safeGet<{ asOfDate: string | null; count: number | null }>(
      `
        WITH latest AS (
          SELECT as_of_date
          FROM serving_ml_physics_candidates
          ${asOfDate ? 'WHERE as_of_date <= ?' : ''}
          ORDER BY as_of_date DESC
          LIMIT 1
        )
        SELECT latest.as_of_date AS asOfDate, COUNT(c.ticker) AS count
        FROM latest
        LEFT JOIN serving_ml_physics_candidates c
          ON c.as_of_date = latest.as_of_date
        GROUP BY latest.as_of_date
      `,
      asOfArgs,
    ),
    safeGet<{ asOfDate: string | null; bases: number | null; rows: number | null }>(
      `
        WITH latest AS (
          SELECT as_of_date
          FROM serving_current_similars
          ${asOfDate ? 'WHERE as_of_date <= ?' : ''}
          ORDER BY as_of_date DESC
          LIMIT 1
        )
        SELECT latest.as_of_date AS asOfDate, COUNT(DISTINCT s.base_ticker) AS bases, COUNT(s.rank) AS rows
        FROM latest
        LEFT JOIN serving_current_similars s
          ON s.as_of_date = latest.as_of_date
        GROUP BY latest.as_of_date
      `,
      asOfArgs,
    ),
    safeGet<{ evaluationDate: string | null; endDate: string | null; horizons: number | null; rows: number | null; samples: number | null }>(
      `
        SELECT
          MAX(evaluation_date) AS evaluationDate,
          MAX(end_date) AS endDate,
          COUNT(DISTINCT horizon_days) AS horizons,
          COUNT(*) AS rows,
          SUM(sample_count) AS samples
        FROM ml_physics_status_evaluations
        WHERE feature_set = ?
          AND sample_count > 0
          ${asOfDate ? 'AND evaluation_date <= ?' : ''}
      `,
      asOfDate ? [ML_PHYSICS_FEATURE_SET, asOfDate] : [ML_PHYSICS_FEATURE_SET],
    ),
    safeGet<{ trainedAt: number | null; rows: number | null; horizons: number | null }>(
      `
        SELECT MAX(trained_at) AS trainedAt, COUNT(*) AS rows, COUNT(DISTINCT horizon_days) AS horizons
        FROM ml_models
        WHERE model_type = ?
      `,
      [ML_PHYSICS_MODEL_TYPE],
    ),
    safeGet<{ evaluationDate: string | null; endDate: string | null; horizons: number | null; rows: number | null }>(
      `
        SELECT MAX(evaluation_date) AS evaluationDate, MAX(end_date) AS endDate, COUNT(DISTINCT horizon_days) AS horizons, COUNT(*) AS rows
        FROM ml_rl_policy_evaluations
        WHERE policy_name = 'physics_rule_policy_v1'
          ${asOfDate ? 'AND evaluation_date <= ?' : ''}
      `,
      asOfArgs,
    ),
    safeGet<{ checkDate: string | null }>(
      `SELECT MAX(check_date) AS checkDate FROM ml_feature_health_checks`,
    ),
  ])

  const expectedDate = tickerPrice?.date ?? globalPriceDate?.date ?? null
  const momentumCount = globalMomentumDate?.date
    ? countValue(await safeGet<CountRow>(
      `
        SELECT COUNT(*) AS count
        FROM physical_momentum_metrics
        WHERE market = 'US'
          AND date = ?
          AND physical_momentum_score IS NOT NULL
      `,
      [globalMomentumDate.date],
    ))
    : null
  const tickerCandidates = candidateLatest?.asOfDate
    ? await safeAll<{
        direction: string
        horizonDays: number
        rank: number
        candidateScore: number
      }>(
      `
        SELECT direction, horizon_days AS horizonDays, rank, candidate_score AS candidateScore
        FROM serving_ml_physics_candidates
        WHERE as_of_date = ?
          AND ticker = ?
        ORDER BY horizon_days, rank
      `,
      [candidateLatest.asOfDate, ticker],
    )
    : []
  const tickerSimilarCount = similarLatest?.asOfDate
    ? countValue(await safeGet<CountRow>(
      `
        SELECT COUNT(*) AS count
        FROM serving_current_similars
        WHERE as_of_date = ?
          AND base_ticker = ?
      `,
      [similarLatest.asOfDate, ticker],
    ))
    : null
  const healthRows = latestHealthCheckDate?.checkDate
    ? await safeAll<{ checkKey: string; status: string; actualDate: string | null; actualCount: number | null }>(
      `
        SELECT check_key AS checkKey, status, actual_date AS actualDate, actual_count AS actualCount
        FROM ml_feature_health_checks
        WHERE check_date = ?
          AND check_key LIKE 'us_%'
        ORDER BY check_key
        LIMIT 20
      `,
      [latestHealthCheckDate.checkDate],
    )
    : []

  const items: StatusItem[] = []

  items.push({
    key: 'price',
    label: '価格・チャート',
    status: dateState(tickerPrice?.date ?? null, globalPriceDate?.date ?? null),
    badge: dateBadge(tickerPrice?.date ?? null, globalPriceDate?.date ?? null),
    date: tickerPrice?.date ?? null,
    count: null,
    detail: tickerPrice?.date
      ? `OHLCVは${tickerPrice.date}まで取得済み。チャート・出来高・価格表示の基準です。`
      : 'この銘柄のUS日足が見つかりません。',
    evidence: [
      `最新市場日 ${globalPriceDate?.date ?? '-'}`,
      `終値 ${tickerPrice?.close == null ? '-' : Number(tickerPrice.close).toFixed(2)}`,
      `出来高 ${tickerPrice?.volume == null ? '-' : fmtCount(numeric(tickerPrice.volume))}`,
    ],
  })

  items.push({
    key: 'stage',
    label: '6ステージ・MA',
    status: dateState(tickerSnapshot?.date ?? null, expectedDate),
    badge: dateBadge(tickerSnapshot?.date ?? null, expectedDate),
    date: tickerSnapshot?.date ?? null,
    count: null,
    detail: tickerSnapshot?.date
      ? '日足/週足/月足のステージ、MA、チャート上部の分析表示に反映しています。'
      : 'この銘柄のステージスナップショットが未生成です。',
    evidence: [`期待日 ${expectedDate ?? '-'}`],
  })

  items.push({
    key: 'physical_momentum',
    label: 'PMS/PFS/PES',
    status: dateState(tickerMomentum?.date ?? null, expectedDate),
    badge: dateBadge(tickerMomentum?.date ?? null, expectedDate),
    date: tickerMomentum?.date ?? null,
    count: momentumCount,
    detail: tickerMomentum?.date
      ? 'Physical MomentumセクションとUSスクリーナーのPMS/PFS/PESソートへ反映済みです。'
      : 'この銘柄のPhysical Momentumが未生成です。',
    evidence: [
      `PMS ${tickerMomentum?.physicalMomentumScore == null ? '-' : Number(tickerMomentum.physicalMomentumScore).toFixed(2)}`,
      `PFS ${tickerMomentum?.physicalForceScore == null ? '-' : Number(tickerMomentum.physicalForceScore).toFixed(2)}`,
      `PES ${tickerMomentum?.physicalEnergyScore == null ? '-' : Number(tickerMomentum.physicalEnergyScore).toFixed(2)}`,
    ],
  })

  items.push({
    key: 'features',
    label: '物理ML特徴量',
    status: dateState(tickerFeature?.date ?? null, expectedDate),
    badge: dateBadge(tickerFeature?.date ?? null, expectedDate),
    date: tickerFeature?.date ?? null,
    count: countValue(globalFeature),
    detail: tickerFeature?.date
      ? `特徴量セット ${ML_PHYSICS_FEATURE_SET} を観察プラン・類似検索・候補生成に使用しています。`
      : `特徴量セット ${ML_PHYSICS_FEATURE_SET} がこの銘柄では未生成です。`,
    evidence: [
      `全体 ${fmtCount(countValue(globalFeature))}件`,
      `ステージ ${tickerFeature?.stageCode ?? '-'}`,
    ],
  })

  items.push({
    key: 'similar',
    label: 'ML類似候補',
    status: tickerSimilarCount && tickerSimilarCount > 0 ? 'ok' : similarLatest?.asOfDate ? 'warn' : 'missing',
    badge: tickerSimilarCount && tickerSimilarCount > 0 ? '反映済み' : similarLatest?.asOfDate ? '個別未生成' : '未生成',
    date: similarLatest?.asOfDate ?? null,
    count: tickerSimilarCount,
    detail: tickerSimilarCount && tickerSimilarCount > 0
      ? 'この銘柄を起点にした現在類似候補を個別ページ/AI分析で使えます。'
      : 'US全体の類似候補基盤はありますが、この銘柄のbase候補は未生成または対象外です。',
    evidence: [
      `全体base ${fmtCount(numeric(similarLatest?.bases))}`,
      `全体行数 ${fmtCount(numeric(similarLatest?.rows))}`,
    ],
  })

  const candidatePreview = tickerCandidates
    .slice(0, 4)
    .map((row) => `${row.horizonDays}日${row.direction === 'up' ? '上昇' : row.direction === 'down' ? '下落' : '待機'}#${row.rank}`)
  items.push({
    key: 'physics_candidates',
    label: '物理ML候補ランキング',
    status: tickerCandidates.length > 0 ? 'ok' : candidateLatest?.asOfDate ? 'info' : 'missing',
    badge: tickerCandidates.length > 0 ? '上位候補入り' : candidateLatest?.asOfDate ? '基盤生成済み' : '未生成',
    date: candidateLatest?.asOfDate ?? null,
    count: numeric(candidateLatest?.count),
    detail: tickerCandidates.length > 0
      ? 'この銘柄は最新の物理MLトップ候補に入っています。'
      : '候補ランキング基盤は生成済みです。この銘柄は最新トップ120候補外として扱います。',
    evidence: candidatePreview.length > 0 ? candidatePreview : [
      `全体 ${fmtCount(numeric(candidateLatest?.count))}候補`,
      '上位外でも特徴量・PMS・観察プランは利用可能',
    ],
  })

  items.push({
    key: 'evaluation',
    label: '過去検証・的中率',
    status: evalSummary?.evaluationDate ? 'ok' : 'missing',
    badge: evalSummary?.evaluationDate ? '検証済み' : '未生成',
    date: evalSummary?.evaluationDate ?? null,
    count: numeric(evalSummary?.rows),
    detail: evalSummary?.evaluationDate
      ? '短期・中期・長期の観察プランに、物理状態別のhit rate/lift/逆行統計を反映しています。'
      : '物理状態別の過去検証が未生成です。',
    evidence: [
      `検証終端 ${evalSummary?.endDate ?? '-'}`,
      `horizon ${fmtCount(numeric(evalSummary?.horizons))}`,
      `sample ${fmtCount(numeric(evalSummary?.samples))}`,
    ],
  })

  items.push({
    key: 'models',
    label: '物理MLモデル',
    status: numeric(modelSummary?.rows) && numeric(modelSummary?.rows)! >= 12 ? 'ok' : modelSummary?.trainedAt ? 'warn' : 'missing',
    badge: modelSummary?.trainedAt ? '学習済み' : '未学習',
    date: trainedAtText(numeric(modelSummary?.trainedAt)),
    count: numeric(modelSummary?.rows),
    detail: modelSummary?.trainedAt
      ? `${ML_PHYSICS_MODEL_TYPE} をUS DB側で学習済みです。`
      : `${ML_PHYSICS_MODEL_TYPE} がUS DB側で未学習です。`,
    evidence: [
      `horizon ${fmtCount(numeric(modelSummary?.horizons))}`,
      `model rows ${fmtCount(numeric(modelSummary?.rows))}`,
    ],
  })

  items.push({
    key: 'rl_policy',
    label: '反復学習/RL評価',
    status: rlSummary?.evaluationDate ? 'ok' : 'missing',
    badge: rlSummary?.evaluationDate ? '評価済み' : '未生成',
    date: rlSummary?.evaluationDate ?? null,
    count: numeric(rlSummary?.rows),
    detail: rlSummary?.evaluationDate
      ? '物理状態から上昇/下落/待機を選ぶルール政策の検証を、US側にも保持しています。'
      : 'US側の反復学習/RL評価が未生成です。',
    evidence: [
      `検証終端 ${rlSummary?.endDate ?? '-'}`,
      `horizon ${fmtCount(numeric(rlSummary?.horizons))}`,
    ],
  })

  items.push({
    key: 'plan',
    label: '観察プラン連携',
    status: tickerFeature?.date && tickerMomentum?.date && evalSummary?.evaluationDate ? 'ok' : 'warn',
    badge: tickerFeature?.date && tickerMomentum?.date && evalSummary?.evaluationDate ? '連携済み' : '一部不足',
    date: tickerFeature?.date ?? tickerMomentum?.date ?? null,
    count: null,
    detail: '短期・中期・長期の観察プランは、特徴量・PMS・物理ML候補・過去検証を統合して表示します。',
    evidence: [
      `特徴量 ${tickerFeature?.date ?? '-'}`,
      `PMS ${tickerMomentum?.date ?? '-'}`,
      `検証 ${evalSummary?.evaluationDate ?? '-'}`,
    ],
  })

  const issueCount = items.filter((item) => item.status === 'missing' || item.status === 'warn').length
  const summaryStatus: StatusTone = issueCount === 0 ? 'ok' : issueCount <= 2 ? 'warn' : 'missing'
  const summaryLabel =
    summaryStatus === 'ok' ? 'US MLは主要機能へ反映済み'
      : summaryStatus === 'warn' ? 'US MLは一部に注意あり'
        : 'US MLの反映不足あり'

  return NextResponse.json({
    ok: true,
    market: 'US',
    ticker,
    dbAvailable: true,
    requestedDate: asOfDate,
    featureSet: ML_PHYSICS_FEATURE_SET,
    modelType: ML_PHYSICS_MODEL_TYPE,
    summary: {
      status: summaryStatus,
      label: summaryLabel,
      detail: `${items.length - issueCount}/${items.length}項目が正常または情報表示です。`,
      latestMarketDate: globalPriceDate?.date ?? null,
      healthCheckDate: latestHealthCheckDate?.checkDate ?? null,
    },
    healthChecks: healthRows,
    items,
  })
}
