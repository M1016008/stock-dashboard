import { NextRequest, NextResponse } from 'next/server'
import { DEFAULT_ASSISTANT_MODEL, isPlaceholderOpenAIKey } from '@/lib/assistant/config'
import { execAll, execGet } from '@/lib/db/client'
import {
  buildChartWindowWithMa,
  buildMaAnalysis,
  buildMovePeriod,
  buildTemplateComment,
  buildVolumeSummary,
  type AnalysisComment,
  type MaCandidateAnalysis,
  type MlCandidate,
  type MoveDirection,
  type OhlcvPoint,
  type SimilarPatternStats,
} from '@/lib/backtest/detail-analysis'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type ServingResult = {
  date: string
  horizon_days: number
  ticker: string
  close: number | null
  volume: number | null
  volume_ratio_20: number | null
  ma25_pos_pct: number | null
  pattern_code: string | null
  signal_codes: string | null
  return_pct: number | null
  max_return_pct: number | null
  max_return_date: string | null
  days_to_max: number | null
  min_return_pct: number | null
  min_return_date: string | null
  days_to_min: number | null
}

type StageRow = {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type SimilarRow = {
  ticker: string
  date: string
  pattern_code: string | null
  max_return_pct: number | null
  min_return_pct: number | null
  days_to_max: number | null
}

type CandidateRow = {
  as_of_date: string
  direction: 'up' | 'down'
  rank: number
  ticker: string
  name: string | null
  sector_large: string | null
  candidate_score: number
  feature_json: string
  reason_json: string
  explanation_json: string
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function compactSignals(signalCodes: string | null): string[] {
  if (!signalCodes) return []
  return signalCodes.split(',').map((code) => code.trim()).filter(Boolean)
}

function normalizeSignalLabel(signalCode: string, label: string | null): string | null {
  if (signalCode.includes('ma_cross_down')) return label?.replace('MA下割れ', 'MA下抜け') ?? 'MA下抜け'
  return label
}

function stageCode(row: StageRow): string {
  const values = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  if (values.every((value) => value == null)) return '------'
  return values.map((value) => value == null ? '-' : String(value)).join('')
}

function boundedMove(value: string | null): MoveDirection {
  return value === 'down' ? 'down' : 'up'
}

async function stagePath(ticker: string, startDate: string, endDate: string | null): Promise<Array<{ date: string; code: string }>> {
  if (!endDate) return []
  const rows = await execAll<StageRow>(
    `
    SELECT date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
    FROM daily_snapshots
    WHERE ticker = ? AND date >= ? AND date <= ?
    ORDER BY date
    `,
    [ticker, startDate, endDate],
  )
  const path: Array<{ date: string; code: string }> = []
  for (const row of rows) {
    const code = stageCode(row)
    if (code === '------') continue
    if (path[path.length - 1]?.code !== code) path.push({ date: row.date, code })
  }
  if (path.length <= 12) return path
  return [
    ...path.slice(0, 4),
    ...path.slice(Math.max(4, Math.floor(path.length / 2) - 2), Math.floor(path.length / 2) + 2),
    ...path.slice(-4),
  ]
}

async function tickerHistory(ticker: string): Promise<OhlcvPoint[]> {
  return execAll<OhlcvPoint>(
    `
    SELECT date, open, high, low, close, volume
    FROM ohlcv_daily
    WHERE ticker = ?
    ORDER BY date
    `,
    [ticker],
  )
}

async function similarPatternStats(result: ServingResult): Promise<SimilarPatternStats> {
  if (!result.pattern_code) {
    return { sampleSize: 0, upRate: null, downRate: null, avgMaxReturnPct: null, avgMinReturnPct: null, cases: [] }
  }

  const rows = await execAll<SimilarRow>(
    `
    SELECT mf.ticker, mf.date, mf.pattern_code, fe.max_return_pct, fe.min_return_pct, fe.days_to_max
    FROM model_features mf
    INNER JOIN forward_extrema fe ON fe.ticker = mf.ticker AND fe.date = mf.date AND fe.horizon_days = ?
    WHERE mf.pattern_code = ?
      AND mf.date < ?
      AND mf.ticker <> ?
    ORDER BY
      ABS(COALESCE(mf.ma25_pos_pct, 0) - ?) +
      ABS(COALESCE(mf.volume_ratio_20, 1) - ?) ASC,
      fe.max_return_pct DESC
    LIMIT 80
    `,
    [
      result.horizon_days,
      result.pattern_code,
      result.date,
      result.ticker,
      result.ma25_pos_pct ?? 0,
      result.volume_ratio_20 ?? 1,
    ],
  )
  const sampleSize = rows.length
  if (sampleSize === 0) {
    return { sampleSize: 0, upRate: null, downRate: null, avgMaxReturnPct: null, avgMinReturnPct: null, cases: [] }
  }
  const avg = (values: number[]) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    sampleSize,
    upRate: rows.filter((row) => (row.max_return_pct ?? -Infinity) >= 10).length / sampleSize,
    downRate: rows.filter((row) => (row.min_return_pct ?? Infinity) <= -5).length / sampleSize,
    avgMaxReturnPct: avg(rows.map((row) => row.max_return_pct).filter((value): value is number => value != null)),
    avgMinReturnPct: avg(rows.map((row) => row.min_return_pct).filter((value): value is number => value != null)),
    cases: rows.slice(0, 8).map((row) => ({
      ticker: row.ticker,
      date: row.date,
      patternCode: row.pattern_code,
      maxReturnPct: row.max_return_pct,
      minReturnPct: row.min_return_pct,
      daysToMax: row.days_to_max,
    })),
  }
}

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
  if (typeof root.output_text === 'string') return root.output_text
  for (const item of root.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text
    }
  }
  return null
}

function normalizeComment(value: unknown, fallback: AnalysisComment, source: AnalysisComment['source']): AnalysisComment {
  if (!value || typeof value !== 'object') return fallback
  const raw = value as Partial<Omit<AnalysisComment, 'source'>>
  const candidateComment = typeof raw.candidateComment === 'string' && raw.candidateComment.trim()
    ? raw.candidateComment
    : fallback.candidateComment
  return {
    source,
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : fallback.summary,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((item): item is string => typeof item === 'string').slice(0, 5) : fallback.evidence,
    watchPoints: Array.isArray(raw.watchPoints) ? raw.watchPoints.filter((item): item is string => typeof item === 'string').slice(0, 5) : fallback.watchPoints,
    riskNotes: Array.isArray(raw.riskNotes) ? raw.riskNotes.filter((item): item is string => typeof item === 'string').slice(0, 4) : fallback.riskNotes,
    candidateComment,
    similarPatternComment: typeof raw.similarPatternComment === 'string' && raw.similarPatternComment.trim()
      ? raw.similarPatternComment
      : candidateComment,
  }
}

function candidateFromRow(row: CandidateRow): MlCandidate {
  const feature = parseJson<Record<string, unknown>>(row.feature_json, {})
  const reason = parseJson<MlCandidate['reason']>(row.reason_json, {
    stage: '',
    maAngle: '',
    maDistance: '',
    pricePosition: '',
    mlEvidence: '',
  })
  const explanation = parseJson<{ confidenceLabel?: string; watchPoints?: string[] }>(row.explanation_json, {})
  return {
    ticker: row.ticker,
    name: row.name,
    sectorLarge: row.sector_large,
    direction: row.direction,
    rank: row.rank,
    asOfDate: row.as_of_date,
    close: typeof feature.close === 'number' ? feature.close : null,
    confidenceLabel: explanation.confidenceLabel ?? '要確認',
    stageCode: typeof feature.stageCode === 'string' ? feature.stageCode : null,
    maOrder: typeof feature.maOrder === 'string' ? feature.maOrder : null,
    reason,
    watchPoints: Array.isArray(explanation.watchPoints) ? explanation.watchPoints.filter((item): item is string => typeof item === 'string').slice(0, 3) : [],
  }
}

async function maCandidateAnalysis(limit = 6): Promise<MaCandidateAnalysis> {
  const latest = await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM serving_ml_candidates`)
  if (!latest?.date) {
    return {
      asOfDate: null,
      up: [],
      down: [],
      comment: '最新データのMA候補はまだ生成されていません。batch:ml-features、batch:ml-train、batch:ml-candidates の順に実行すると表示されます。',
    }
  }
  const rows = await execAll<CandidateRow>(
    `
    SELECT c.as_of_date, c.direction, c.rank, c.ticker, COALESCE(c.name, u.name) AS name,
           COALESCE(u.sector17_name, c.sector_large) AS sector_large,
           c.candidate_score, c.feature_json, c.reason_json, c.explanation_json
    FROM serving_ml_candidates c
    LEFT JOIN ticker_universe u ON u.ticker = c.ticker
    WHERE c.as_of_date = ? AND c.rank <= ?
    ORDER BY c.direction, c.rank
    `,
    [latest.date, limit],
  )
  const candidates = rows.map(candidateFromRow)
  const up = candidates.filter((item) => item.direction === 'up')
  const down = candidates.filter((item) => item.direction === 'down')
  return {
    asOfDate: latest.date,
    up,
    down,
    comment: `${latest.date}時点の最新データから、6桁ステージとMA形状を基準に上昇候補${up.length}件、下落警戒${down.length}件を抽出しています。`,
  }
}

async function analysisComment(facts: Record<string, unknown>, fallback: AnalysisComment): Promise<AnalysisComment> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || isPlaceholderOpenAIKey(apiKey)) return fallback

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_ASSISTANT_MODEL,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: 'あなたは日本株の検証画面向け分析コメントを作るアシスタントです。渡されたJSON内の事実だけを使い、投資判断を断定せず、次に確認すべき点を小学生にも分かる平易な日本語で返してください。出来高よりも6桁ステージ、MAの角度、MA同士の距離、株価とMAの位置、最新ML候補の根拠を優先してください。数値や日付を新しく作らないでください。',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify(facts),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'market_analysis_comment',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['summary', 'evidence', 'watchPoints', 'riskNotes', 'candidateComment', 'similarPatternComment'],
              properties: {
                summary: { type: 'string' },
                evidence: { type: 'array', items: { type: 'string' } },
                watchPoints: { type: 'array', items: { type: 'string' } },
                riskNotes: { type: 'array', items: { type: 'string' } },
                candidateComment: { type: 'string' },
                similarPatternComment: { type: 'string' },
              },
            },
          },
        },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return fallback
    const payload = await response.json()
    const text = extractOutputText(payload)
    if (!text) return fallback
    return normalizeComment(JSON.parse(text), fallback, 'openai')
  } catch {
    return fallback
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const ticker = searchParams.get('ticker')?.trim()
    const date = searchParams.get('date')?.trim()
    const horizon = Number(searchParams.get('horizon') ?? 40)
    const move = boundedMove(searchParams.get('move'))
    if (!ticker || !date || !Number.isFinite(horizon)) {
      return NextResponse.json({ error: 'ticker/date/horizon are required' }, { status: 400 })
    }

    const cached = await execGet<{ detail_json: string }>(
      `
      SELECT detail_json
      FROM serving_backtest_details
      WHERE ticker = ? AND date = ? AND horizon_days = ?
      `,
      [ticker, date, horizon],
    )
    let result = await execGet<ServingResult>(
      `
      SELECT date, horizon_days, ticker, close, volume, volume_ratio_20, ma25_pos_pct, pattern_code, signal_codes,
             return_pct, max_return_pct, max_return_date, days_to_max,
             min_return_pct, min_return_date, days_to_min
      FROM serving_backtest_results
      WHERE ticker = ? AND date = ? AND horizon_days = ?
      `,
      [ticker, date, horizon],
    )
    if (!result) {
      result = await execGet<ServingResult>(
        `
        SELECT
          mf.date,
          fe.horizon_days,
          mf.ticker,
          COALESCE(mf.close, o.close) AS close,
          COALESCE(mf.volume, o.volume) AS volume,
          mf.volume_ratio_20,
          mf.ma25_pos_pct,
          mf.pattern_code,
          mf.signal_codes,
          fe.return_pct,
          fe.max_return_pct,
          fe.max_return_date,
          fe.days_to_max,
          fe.min_return_pct,
          fe.min_return_date,
          fe.days_to_min
        FROM model_features mf
        INNER JOIN forward_extrema fe ON fe.ticker = mf.ticker AND fe.date = mf.date AND fe.horizon_days = ?
        LEFT JOIN ohlcv_daily o ON o.ticker = mf.ticker AND o.date = mf.date
        WHERE mf.ticker = ? AND mf.date = ?
        `,
        [horizon, ticker, date],
      )
    }
    const signalCodes = compactSignals(result?.signal_codes ?? null)
    let evidence = signalCodes.length > 0
      ? await execAll<{ signal_code: string; label: string | null; reason_json: string }>(
        `
        SELECT signal_code, label, reason_json
        FROM serving_signal_evidence
        WHERE ticker = ? AND date = ? AND signal_code IN (${signalCodes.map(() => '?').join(', ')})
        ORDER BY signal_code
        `,
        [ticker, date, ...signalCodes],
      )
      : []
    if (evidence.length === 0 && signalCodes.length > 0) {
      const fallbackEvidence = await execAll<{ signal_code: string; label: string | null; timescale: string; ma_period: number; direction: string }>(
        `
        SELECT signal_code, label, timescale, ma_period, direction
        FROM technical_signals
        WHERE ticker = ? AND date = ? AND signal_code IN (${signalCodes.map(() => '?').join(', ')})
        ORDER BY signal_code
        `,
        [ticker, date, ...signalCodes],
      )
      evidence = fallbackEvidence.map((row) => ({
        signal_code: row.signal_code,
        label: normalizeSignalLabel(row.signal_code, row.label),
        reason_json: JSON.stringify({
          label: normalizeSignalLabel(row.signal_code, row.label),
          reason: normalizeSignalLabel(row.signal_code, row.label)
            ? `${normalizeSignalLabel(row.signal_code, row.label)}の条件を${date}時点で満たしたため抽出しました。`
            : `${row.signal_code}の条件を${date}時点で満たしたため抽出しました。`,
          basis: {
            timescale: row.timescale,
            maPeriod: row.ma_period,
            direction: row.direction,
          },
        }),
      }))
    }

    const [upStagePath, downStagePath, history] = result
      ? await Promise.all([
        stagePath(ticker, date, result.max_return_date),
        stagePath(ticker, date, result.min_return_date),
        tickerHistory(ticker),
      ])
      : [[], [], []]
    const selectedEndDate = move === 'down' ? result?.min_return_date ?? null : result?.max_return_date ?? null
    const selectedReturnPct = move === 'down' ? result?.min_return_pct ?? null : result?.max_return_pct ?? null
    const selectedDays = move === 'down' ? result?.days_to_min ?? null : result?.days_to_max ?? null
    const movePeriod = result
      ? buildMovePeriod(move, history, result.date, selectedEndDate, selectedReturnPct, selectedDays)
      : null
    const selectedStagePath = move === 'down' ? downStagePath : upStagePath
    const volumeSummary = result ? buildVolumeSummary(history, result.date, selectedEndDate) : null
    const maAnalysis = result ? buildMaAnalysis(history, result.date) : null
    const similarStats = result ? await similarPatternStats(result) : null
    const candidates = await maCandidateAnalysis()
    const fallbackComment = result && movePeriod && volumeSummary && maAnalysis && similarStats
      ? buildTemplateComment({
        ticker,
        move: movePeriod,
        stagePath: selectedStagePath,
        volume: volumeSummary,
        ma: maAnalysis,
        similar: similarStats,
        candidates,
      })
      : null
    const aiComment = fallbackComment
      ? await analysisComment({
        ticker,
        basisDate: date,
        horizonDays: horizon,
        movePeriod,
        stagePath: selectedStagePath,
        maAnalysis,
        maCandidateAnalysis: candidates,
      }, fallbackComment)
      : null

    return NextResponse.json({
      ticker,
      date,
      horizon,
      move,
      source: cached ? 'serving_backtest_details' : 'serving_backtest_results',
      cached: parseJson(cached?.detail_json, null),
      basis: result ? {
        date: result.date,
        close: result.close,
        volume: result.volume,
        volumeRatio20: result.volume_ratio_20,
        patternCode: result.pattern_code,
        signalCodes,
      } : null,
      outcome: result ? {
        horizonDays: result.horizon_days,
        returnPct: result.return_pct,
        maxReturnPct: result.max_return_pct,
        maxReturnDate: result.max_return_date,
        daysToMax: result.days_to_max,
        minReturnPct: result.min_return_pct,
        minReturnDate: result.min_return_date,
        daysToMin: result.days_to_min,
        upStagePath,
        downStagePath,
      } : null,
      movePeriod,
      chartSeries: result ? buildChartWindowWithMa(history, result.date, selectedEndDate) : [],
      selectedStagePath,
      volumeSummary,
      maAnalysis,
      similarPatternStats: similarStats,
      maCandidateAnalysis: candidates,
      analysisComment: aiComment,
      evidence: evidence.map((row) => ({
        signalCode: row.signal_code,
        label: normalizeSignalLabel(row.signal_code, row.label),
        ...parseJson(row.reason_json, {}),
      })),
    })
  } catch (error) {
    console.error('Backtest detail API error:', error)
    return NextResponse.json(
      { error: 'Backtest detail failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
