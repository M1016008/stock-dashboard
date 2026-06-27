import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { analyzePhysicsProfile, type PhysicsStatus } from '@/lib/ml/physics-analysis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ ticker: string }>
}

type FeatureRow = {
  ticker: string
  date: string
  stageCode: string | null
  featureJson: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
}

type MomentumRow = {
  date: string
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

type PriceRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type SnapshotRow = {
  date: string
  ma5: number | null
  ma25: number | null
  ma75: number | null
  ma300: number | null
}

type CalibrationRow = {
  statusLabel: string
  targetDirection: 'up' | 'down' | 'wait'
  horizonDays: number
  sampleCount: number
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  confidenceScore: number | null
  medianReturnPct: number | null
  avgReturnPct: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  adverseRate: number | null
  evaluationDate: string
}

type CandidateRow = {
  asOfDate: string
  direction: 'up' | 'down' | 'wait'
  horizonDays: number
  rank: number
  candidateScore: number
  modelName: string | null
}

type PlanTone = 'positive' | 'negative' | 'neutral' | 'warning'

type PriceLevel = {
  label: string
  value: number | null
  distancePct: number | null
}

type HorizonPriceLevels = {
  baseDate: string
  close: number
  support: PriceLevel
  resistance: PriceLevel
  breakdown: PriceLevel
}

const PLAN_HORIZONS = [
  { label: '短期', days: 5, description: '数日から1週間程度の反応を見る時間軸' },
  { label: '中期', days: 20, description: '約1か月の方向感と押し目/失速を見る時間軸' },
  { label: '長期', days: 60, description: '約3か月の地合い転換と大きな崩れを見る時間軸' },
] as const

type PlanHorizon = typeof PLAN_HORIZONS[number]

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase().replace(/\.T$/i, '')
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function pct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${(value * 100).toFixed(digits)}%`
}

function pctRaw(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function parseAsOfDate(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

function roundPrice(value: number | null | undefined): number | null {
  if (!finite(value)) return null
  if (Math.abs(value) >= 1000) return Math.round(value)
  if (Math.abs(value) >= 100) return Math.round(value * 10) / 10
  return Math.round(value * 100) / 100
}

function yen(value: number | null | undefined): string {
  const rounded = roundPrice(value)
  if (!finite(rounded)) return '未判定'
  return `${rounded.toLocaleString('ja-JP', { maximumFractionDigits: rounded >= 1000 ? 0 : 2 })}円`
}

function distancePct(value: number | null | undefined, base: number): number | null {
  if (!finite(value) || !finite(base) || base === 0) return null
  return ((value - base) / base) * 100
}

function directionLabel(direction: 'up' | 'down' | 'wait' | null | undefined): string {
  if (direction === 'up') return '上昇方向'
  if (direction === 'down') return '下落方向'
  if (direction === 'wait') return '見送り優位'
  return '方向未判定'
}

function confidenceLabel(row: CalibrationRow | null): string {
  const confidence = row?.confidenceScore
  const lift = row?.lift
  if (!finite(confidence) || !finite(lift)) return '検証不足'
  if (confidence >= 62 && lift >= 1.15) return '強め'
  if (confidence >= 52 && lift >= 1.05) return '中程度'
  if (confidence >= 42) return '参考'
  return '弱い'
}

function bestCandidate(candidates: CandidateRow[]): CandidateRow | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => a.rank - b.rank)[0] ?? null
}

function candidateLine(candidates: CandidateRow[]): string {
  if (candidates.length === 0) return '物理ML上位候補には未掲載'
  return candidates
    .sort((a, b) => a.rank - b.rank)
    .map((row) => `${directionLabel(row.direction)}#${row.rank}`)
    .join(' / ')
}

function makeLevel(label: string, value: number | null | undefined, base: number): PriceLevel {
  return {
    label,
    value: roundPrice(value),
    distancePct: distancePct(value, base),
  }
}

function levelText(level: PriceLevel | null | undefined): string {
  if (!level || !finite(level.value)) return '価格未判定'
  const distance = finite(level.distancePct) ? ` / ${pctRaw(level.distancePct)}` : ''
  return `${level.label} ${yen(level.value)}${distance}`
}

function levelPriceText(level: PriceLevel | null | undefined): string {
  if (!level || !finite(level.value)) return '価格未判定'
  return `${level.label} ${yen(level.value)}`
}

function windowRows(rows: PriceRow[], days: number): PriceRow[] {
  return rows.slice(Math.max(0, rows.length - days))
}

function minLow(rows: PriceRow[], days: number): number | null {
  const values = windowRows(rows, days).map((row) => row.low).filter(finite)
  return values.length > 0 ? Math.min(...values) : null
}

function maxHigh(rows: PriceRow[], days: number): number | null {
  const values = windowRows(rows, days).map((row) => row.high).filter(finite)
  return values.length > 0 ? Math.max(...values) : null
}

function pickNearestLevel(
  candidates: Array<{ label: string; value: number | null | undefined; priority: number }>,
  close: number,
  side: 'support' | 'resistance',
): PriceLevel {
  const usable = candidates
    .filter((item): item is { label: string; value: number; priority: number } => finite(item.value))
    .filter((item) => side === 'support' ? item.value <= close * 1.002 : item.value >= close * 0.998)
    .sort((a, b) => {
      const distanceA = Math.abs(a.value - close) / close
      const distanceB = Math.abs(b.value - close) / close
      if (Math.abs(distanceA - distanceB) > 0.0025) return distanceA - distanceB
      return a.priority - b.priority
    })

  if (usable.length > 0) return makeLevel(usable[0].label, usable[0].value, close)

  const fallback = candidates
    .filter((item): item is { label: string; value: number; priority: number } => finite(item.value))
    .sort((a, b) => Math.abs(a.value - close) - Math.abs(b.value - close))[0]
  return fallback ? makeLevel(fallback.label, fallback.value, close) : makeLevel(side === 'support' ? '支持未判定' : '抵抗未判定', null, close)
}

function buildHorizonLevels(rows: PriceRow[], snapshot: SnapshotRow | null, horizon: PlanHorizon): HorizonPriceLevels | null {
  const latest = rows[rows.length - 1]
  if (!latest || !finite(latest.close)) return null
  const close = latest.close

  const shortLow = minLow(rows, 10)
  const shortHigh = maxHigh(rows, 10)
  const midLow = minLow(rows, 25)
  const midHigh = maxHigh(rows, 25)
  const longLow = minLow(rows, 75)
  const longHigh = maxHigh(rows, 75)
  const majorLow = minLow(rows, 150)
  const majorHigh = maxHigh(rows, 150)

  const ma5 = snapshot?.ma5 ?? null
  const ma25 = snapshot?.ma25 ?? null
  const ma75 = snapshot?.ma75 ?? null
  const ma300 = snapshot?.ma300 ?? null

  const nearSupportCandidates = [
    { label: '5日線', value: ma5, priority: 1 },
    { label: '10日安値', value: shortLow, priority: 2 },
    { label: '25日線', value: ma25, priority: 3 },
    { label: '25日安値', value: midLow, priority: 4 },
    { label: '75日線', value: ma75, priority: 5 },
    { label: '75日安値', value: longLow, priority: 6 },
    { label: '300日線', value: ma300, priority: 7 },
    { label: '150日安値', value: majorLow, priority: 8 },
  ]

  const breakdownCandidates =
    horizon.days <= 5
      ? [
          { label: '5日線', value: ma5, priority: 1 },
          { label: '10日安値', value: shortLow, priority: 2 },
          { label: '25日線', value: ma25, priority: 3 },
          { label: '25日安値', value: midLow, priority: 4 },
        ]
      : horizon.days <= 20
        ? [
            { label: '25日線', value: ma25, priority: 1 },
            { label: '25日安値', value: midLow, priority: 2 },
            { label: '75日線', value: ma75, priority: 3 },
            { label: '75日安値', value: longLow, priority: 4 },
          ]
        : [
            { label: '75日線', value: ma75, priority: 1 },
            { label: '75日安値', value: longLow, priority: 2 },
            { label: '300日線', value: ma300, priority: 3 },
            { label: '150日安値', value: majorLow, priority: 4 },
          ]

  const resistanceCandidates =
    horizon.days <= 5
      ? [
          { label: '5日線', value: ma5, priority: 1 },
          { label: '10日高値', value: shortHigh, priority: 2 },
          { label: '25日線', value: ma25, priority: 3 },
          { label: '25日高値', value: midHigh, priority: 4 },
        ]
      : horizon.days <= 20
        ? [
            { label: '25日線', value: ma25, priority: 1 },
            { label: '25日高値', value: midHigh, priority: 2 },
            { label: '75日線', value: ma75, priority: 3 },
            { label: '75日高値', value: longHigh, priority: 4 },
          ]
        : [
            { label: '75日線', value: ma75, priority: 1 },
            { label: '75日高値', value: longHigh, priority: 2 },
            { label: '300日線', value: ma300, priority: 3 },
            { label: '150日高値', value: majorHigh, priority: 4 },
          ]

  const support = pickNearestLevel(nearSupportCandidates, close, 'support')
  const resistance = pickNearestLevel(resistanceCandidates, close, 'resistance')
  const breakdown = pickNearestLevel(breakdownCandidates, close, 'support')
  return {
    baseDate: latest.date,
    close: roundPrice(close) ?? close,
    support,
    resistance,
    breakdown,
  }
}

function horizonFocus(horizon: PlanHorizon): {
  focus: string
  upStance: string
  downStance: string
  neutralStance: string
  upChecklist: string[]
  downChecklist: string[]
  neutralChecklist: string[]
  upInvalidation: string
  downInvalidation: string
  neutralInvalidation: string
} {
  if (horizon.days <= 5) {
    return {
      focus: '5営業日は「初動が今日から数日で続くか」を見る時間軸です。5日線、直近安値/高値、PFSの向きだけを重く見ます',
      upStance: '打診は小さく。5日線上でPFSが保てるかを確認',
      downStance: '反発を急がず、短期線の戻り失敗を優先確認',
      neutralStance: '数日内の方向が出るまで見送り',
      upChecklist: [
        '終値が5日線上を維持し、翌日以降もPFSがプラス圏に残るかを見る',
        '直近高値を試す場面でPESが落ちず、短期の熱量が抜けないか確認する',
        '5日線を割ったら、打診ではなく一度観察へ戻す',
      ],
      downChecklist: [
        '5日線への戻りで上値が抑えられ、終値が直近安値に近づくかを見る',
        'PFSがマイナス圏で拡大するなら、短期反発より下方向の力を優先する',
        '陽線反発が出ても5日線を回復できなければ戻り売り形として扱う',
      ],
      neutralChecklist: [
        '5日線の上下どちらで終値が2営業日続くかを見る',
        'PFSがゼロ近辺から明確に傾くまで判断を急がない',
        '短期の値幅だけでなく、直近高安のどちらを先に抜くか確認する',
      ],
      upInvalidation: '5日線を終値で割り、PFSがマイナス化する場合は短期上昇シナリオを取り下げます。',
      downInvalidation: '5日線を終値で回復し、PFSがプラス圏へ戻る場合は短期下落警戒を弱めます。',
      neutralInvalidation: '5日線の片側に終値が定着し、PFSも同方向へ傾いたら見送りから方向判断へ移します。',
    }
  }

  if (horizon.days <= 20) {
    return {
      focus: '20営業日は「1か月のトレンドへ育つか」を見る時間軸です。25日線、日足6ステージ、PMSの上昇/低下を重く見ます',
      upStance: '25日線を軸に、押し目が崩れず中期上昇へつながるか確認',
      downStance: '25日線回復の失敗と日足ステージ悪化を優先確認',
      neutralStance: '25日線をまたぐ往来が続く間は中期判断を保留',
      upChecklist: [
        '25日線を終値で維持し、日足ステージが2→1または3→2へ改善するかを見る',
        'PMSが低下に転じず、短期のPFS改善が総合PMSへ波及するか確認する',
        '25日線割れ後にすぐ回復できない場合は、1か月上昇シナリオを弱める',
      ],
      downChecklist: [
        '25日線を終値で回復できず、日足ステージが4/5側へ進むかを見る',
        'PMSが低下し、PFSのマイナスが数日で解消しない場合は中期下落を優先する',
        '戻り高値が切り下がるなら、短期反発ではなく中期失速として扱う',
      ],
      neutralChecklist: [
        '25日線付近で終値が上下に振れる間は、日足ステージの連続改善/悪化を待つ',
        'PMSとPFSの向きが揃うかを見る。片方だけなら中期判断は弱い',
        '20営業日の検証liftが低い場合は、物理MLより価格の節目確認を優先する',
      ],
      upInvalidation: '25日線を終値で明確に割り、PMSも低下へ転じる場合は中期上昇シナリオを保留します。',
      downInvalidation: '25日線を終値で回復し、日足ステージが改善へ連続する場合は中期下落警戒を弱めます。',
      neutralInvalidation: '25日線の上下どちらかに定着し、日足ステージとPMSが同方向へ揃ったら中期判断へ移します。',
    }
  }

  return {
    focus: '60営業日は「大局の転換か一時的な揺れか」を見る時間軸です。週足/月足、75日線、200日線、過去検証の順行/逆行幅を重く見ます',
    upStance: '週足の悪化が止まり、75日線/200日線側へ力が伝わるか確認',
    downStance: '週足・月足の上値抵抗と75日線割れを優先確認',
    neutralStance: '大局判断は急がず、週足/月足の整合を待つ',
    upChecklist: [
      '75日線を回復または維持し、週足ステージの悪化が止まるかを見る',
      'PMS改善が数週間続き、短期だけでなく中長期線へ上向きの力が拡散するか確認する',
      '60営業日の平均順行幅に対して、逆行リスクが大きすぎないかを見る',
    ],
    downChecklist: [
      '75日線を終値で割り込み、週足/月足ステージも悪化側へ揃うかを見る',
      '反発しても200日線や週足MAで抑えられる場合は、大局下落継続として扱う',
      '60営業日の平均逆行幅が大きい場合は、短期反発より資金管理を優先する',
    ],
    neutralChecklist: [
      '75日線と200日線の間で推移する間は、大局転換の判断を急がない',
      '週足と月足の向きが揃うかを見る。日足だけの改善/悪化では長期判断を固定しない',
      '60営業日の検証サンプルとliftが弱い場合は、統計より価格帯と上位足を優先する',
    ],
    upInvalidation: '75日線を明確に割り、週足ステージも悪化へ進む場合は長期上昇シナリオを保留します。',
    downInvalidation: '75日線を回復し、週足ステージの悪化が止まる場合は長期下落警戒を弱めます。',
    neutralInvalidation: '週足/月足とPMSが同方向へ揃い、75日線または200日線を明確に抜けたら大局判断へ移します。',
  }
}

function planFrom(
  status: PhysicsStatus,
  calibration: CalibrationRow | null,
  candidates: CandidateRow[],
  momentum: MomentumRow | null,
  horizon: PlanHorizon,
  levels: HorizonPriceLevels | null,
): {
  tone: PlanTone
  stance: string
  headline: string
  summary: string
  checklist: string[]
  invalidation: string
} {
  const target = calibration?.targetDirection ?? null
  const confidence = confidenceLabel(calibration)
  const best = bestCandidate(candidates)
  const pfs = momentum?.physicalForceScore ?? null
  const pms = momentum?.physicalMomentumScore ?? null
  const focus = horizonFocus(horizon)
  const horizonScope =
    horizon.days <= 5 ? '数日内'
      : horizon.days <= 20 ? '1か月内'
        : '数週間から3か月'
  const priceSummary = levels
    ? `基準価格は${yen(levels.close)}。支持/反発候補は${levelText(levels.support)}、抵抗/反落候補は${levelText(levels.resistance)}`
    : '価格ラインは未判定'
  const evidence = [
    `${status}`,
    `${directionLabel(target)} / 信頼${confidence}`,
    candidateLine(candidates),
  ]
  const statLine = [
    finite(calibration?.hitRate) ? `的中率${pct(calibration?.hitRate)}` : null,
    finite(calibration?.lift) ? `lift ${calibration?.lift?.toFixed(2)}` : null,
    finite(calibration?.avgMaxReturnPct) ? `平均順行${pctRaw(calibration?.avgMaxReturnPct)}` : null,
    finite(calibration?.avgMinReturnPct) ? `平均逆行${pctRaw(calibration?.avgMinReturnPct)}` : null,
  ].filter(Boolean).join(' / ')

  if (target === 'down' || status === '下落加速' || status === '失速警戒') {
    const strong = confidence === '強め' || best?.direction === 'down' || (finite(pfs) && pfs <= -0.35)
    return {
      tone: strong ? 'negative' : 'warning',
      stance: strong ? focus.downStance : `${focus.downStance}。ただし統計信頼は${confidence}`,
      headline: `${horizon.label}は下方向の警戒を優先`,
      summary: `${focus.focus}。${priceSummary}。現在形状は${evidence.join('、')}。${statLine || '検証統計は不足気味です'}。`,
      checklist: levels ? [
        `${levelPriceText(levels.resistance)}前後が${horizonScope}の反落候補。戻りが止まり、陰線またはPFS再低下になるかを見る`,
        `${levelPriceText(levels.breakdown)}を終値で割ると、${horizonScope}の下方向への力の拡散を優先して警戒する`,
        `${levelPriceText(levels.resistance)}を終値で回復するなら、${horizonScope}の下落警戒はいったん弱める`,
      ] : focus.downChecklist,
      invalidation: levels ? `${levelPriceText(levels.resistance)}を終値で回復し、PFSがプラス圏へ戻る場合は下落警戒を弱めます。` : focus.downInvalidation,
    }
  }

  if (target === 'up' || ['上昇加速', '上昇継続', '押し目形成', '反発準備'].includes(status)) {
    const overheated = status === '過熱注意' || (finite(momentum?.physicalEnergyScore) && (momentum.physicalEnergyScore ?? 0) >= 1.2)
    return {
      tone: overheated ? 'warning' : 'positive',
      stance: overheated ? `追いかけず、${horizon.days <= 5 ? '数日内の押し目' : horizon.days <= 20 ? '25日線付近の押し目' : '週足の押し目'}確認型` : focus.upStance,
      headline: `${horizon.label}は上方向の形を確認`,
      summary: `${focus.focus}。${priceSummary}。現在形状は${evidence.join('、')}。${statLine || '検証統計は不足気味です'}。`,
      checklist: levels ? [
        `${levelPriceText(levels.support)}付近まで押した時に終値で守り、${horizonScope}の反発候補になるかを見る`,
        `${levelPriceText(levels.resistance)}を終値で上抜けるか。ここで上髭/陰線なら${horizonScope}の反落注意`,
        `${levelPriceText(levels.breakdown)}を終値で割る場合は、${horizonScope}の上方向シナリオをいったん保留する`,
      ] : overheated && horizon.days <= 5
          ? ['高値追いではなく、5日線付近まで熱量が冷めるかを見る', 'PESが急低下する場合は短期反落を優先する', '再加速するならPFSがプラスを維持するか確認する']
          : focus.upChecklist,
      invalidation: levels ? `${levelPriceText(levels.breakdown)}を終値で明確に割り、PFSがマイナス化する場合は強気シナリオを保留します。` : focus.upInvalidation,
    }
  }

  if (status === '過熱注意') {
    return {
      tone: 'warning',
      stance: horizon.days <= 5 ? '短期過熱の冷却待ち' : horizon.days <= 20 ? '25日線までの調整余地を確認' : '上位足で過熱が解消するまで待つ',
      headline: `${horizon.label}は上げ余地より反落余地を確認`,
      summary: `${focus.focus}。${priceSummary}。PMS ${finite(pms) ? pms.toFixed(2) : '-'}、PFS ${finite(pfs) ? pfs.toFixed(2) : '-'}。${statLine || '検証統計は不足気味です'}。`,
      checklist: levels ? [
        `${levelPriceText(levels.resistance)}付近で高値更新に失敗するなら、${horizonScope}の反落警戒を強める`,
        `${levelPriceText(levels.support)}まで冷却しても終値で守れるかを見る`,
        `${levelPriceText(levels.breakdown)}割れなら過熱終了、${levelPriceText(levels.resistance)}上抜けなら再加速として扱う`,
      ] : horizon.days <= 5
          ? ['5日線割れで急速に失速しないかを見る', '高値更新後にPFSが低下する場合は一段の買い増しを避ける', '短期熱量が冷めても終値が5日線上に残るか確認する']
          : horizon.days <= 20
            ? ['25日線までの調整で止まるかを見る', 'PMSが低下し続ける場合は中期の過熱終了として扱う', '日足ステージが悪化側へ連続しないか確認する']
            : ['週足で上髭や上値抵抗が続かないかを見る', '75日線から離れすぎている場合は平均回帰を警戒する', '月足側の勢いが鈍るなら長期過熱終了として扱う'],
      invalidation: levels ? `${levelPriceText(levels.resistance)}を終値で上抜け、PFSがプラスを維持する場合は反落警戒を弱めます。` : horizon.days <= 5 ? '過熱縮小後に5日線上で再加速し、PFSがプラスを維持する場合は短期上方向の見方を戻します。' : focus.upInvalidation,
    }
  }

  return {
    tone: 'neutral',
    stance: focus.neutralStance,
    headline: `${horizon.label}は方向感待ち`,
    summary: `${focus.focus}。${priceSummary}。過去検証では${directionLabel(target)}寄りですが、現時点では決め打ちより確認条件を待つ形です。${evidence.join('、')}。${statLine || '検証統計は不足気味です'}。`,
    checklist: levels ? [
      `${levelPriceText(levels.support)}から${levelPriceText(levels.resistance)}のレンジをどちらに抜けるかを見る`,
      `${levelPriceText(levels.resistance)}上抜けなら上方向、${levelPriceText(levels.support)}割れなら下方向へ判断を寄せる`,
      'PMS/PFSが価格の抜け方向と揃うまで、決め打ちせず観察する',
    ] : focus.neutralChecklist,
    invalidation: levels ? `${levelPriceText(levels.support)}または${levelPriceText(levels.resistance)}を終値で明確に抜け、PMS/PFSも同方向へ揃ったら見送りから方向判断へ移します。` : focus.neutralInvalidation,
  }
}

async function loadLatestFeature(ticker: string, asOfDate?: string | null): Promise<FeatureRow | null> {
  const dateFilter = asOfDate ? 'AND f.date <= ?' : ''
  return (await execGet<FeatureRow>(
    `
      SELECT
        f.ticker,
        f.date,
        f.stage_code AS stageCode,
        f.feature_json AS featureJson,
        u.name,
        u.market_segment AS marketSegment,
        u.sector17_name AS sector17Name,
        u.sector33_name AS sector33Name
      FROM ml_feature_vectors_v2 f
      LEFT JOIN ticker_universe u ON u.ticker = f.ticker
      WHERE f.feature_set = ?
        AND f.ticker = ?
        ${dateFilter}
      ORDER BY f.date DESC
      LIMIT 1
    `,
    asOfDate ? [ML_PHYSICS_FEATURE_SET, ticker, asOfDate] : [ML_PHYSICS_FEATURE_SET, ticker],
  )) ?? null
}

async function loadMomentum(ticker: string, asOfDate?: string | null): Promise<MomentumRow | null> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  return (await execGet<MomentumRow>(
    `
      SELECT
        date,
        physical_momentum_score AS physicalMomentumScore,
        physical_force_score AS physicalForceScore,
        physical_energy_score AS physicalEnergyScore
      FROM physical_momentum_metrics
      WHERE market = 'JP'
        AND symbol = ?
        ${dateFilter}
      ORDER BY date DESC
      LIMIT 1
    `,
    asOfDate ? [ticker, asOfDate] : [ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return null
    throw error
  })) ?? null
}

async function loadCalibrations(status: PhysicsStatus, asOfDate?: string | null): Promise<Map<number, CalibrationRow>> {
  const dateFilter = asOfDate ? 'AND evaluation_date <= ?' : ''
  const rows = await execAll<CalibrationRow>(
    `
      WITH latest AS (
        SELECT horizon_days, MAX(evaluation_date) AS evaluation_date
        FROM ml_physics_status_evaluations
        WHERE feature_set = ?
          AND status_label = ?
          AND horizon_days IN (${PLAN_HORIZONS.map(() => '?').join(', ')})
          ${dateFilter}
        GROUP BY horizon_days
      )
      SELECT
        e.status_label AS statusLabel,
        e.target_direction AS targetDirection,
        e.horizon_days AS horizonDays,
        e.sample_count AS sampleCount,
        e.hit_rate AS hitRate,
        e.base_rate AS baseRate,
        e.lift,
        e.confidence_score AS confidenceScore,
        e.median_return_pct AS medianReturnPct,
        e.avg_return_pct AS avgReturnPct,
        e.avg_max_return_pct AS avgMaxReturnPct,
        e.avg_min_return_pct AS avgMinReturnPct,
        e.adverse_rate AS adverseRate,
        e.evaluation_date AS evaluationDate
      FROM ml_physics_status_evaluations e
      INNER JOIN latest l
        ON l.horizon_days = e.horizon_days
       AND l.evaluation_date = e.evaluation_date
      WHERE e.feature_set = ?
        AND e.status_label = ?
    `,
    asOfDate
      ? [ML_PHYSICS_FEATURE_SET, status, ...PLAN_HORIZONS.map((h) => h.days), asOfDate, ML_PHYSICS_FEATURE_SET, status]
      : [ML_PHYSICS_FEATURE_SET, status, ...PLAN_HORIZONS.map((h) => h.days), ML_PHYSICS_FEATURE_SET, status],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return []
    throw error
  })
  return new Map(rows.map((row) => [Number(row.horizonDays), row]))
}

async function loadCandidates(ticker: string, asOfDate?: string | null): Promise<Map<number, CandidateRow[]>> {
  const dateFilter = asOfDate ? 'AND as_of_date <= ?' : ''
  const rows = await execAll<CandidateRow>(
    `
      WITH latest AS (
        SELECT horizon_days, MAX(as_of_date) AS as_of_date
        FROM serving_ml_physics_candidates
        WHERE horizon_days IN (${PLAN_HORIZONS.map(() => '?').join(', ')})
          ${dateFilter}
        GROUP BY horizon_days
      )
      SELECT
        c.as_of_date AS asOfDate,
        c.direction,
        c.horizon_days AS horizonDays,
        c.rank,
        c.candidate_score AS candidateScore,
        c.model_name AS modelName
      FROM serving_ml_physics_candidates c
      INNER JOIN latest l
        ON l.horizon_days = c.horizon_days
       AND l.as_of_date = c.as_of_date
      WHERE c.ticker = ?
      ORDER BY c.horizon_days, c.rank
    `,
    asOfDate ? [...PLAN_HORIZONS.map((h) => h.days), asOfDate, ticker] : [...PLAN_HORIZONS.map((h) => h.days), ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return []
    throw error
  })
  const map = new Map<number, CandidateRow[]>()
  for (const row of rows) {
    const list = map.get(row.horizonDays) ?? []
    list.push(row)
    map.set(row.horizonDays, list)
  }
  return map
}

async function loadPriceRows(ticker: string, asOfDate?: string | null): Promise<PriceRow[]> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const rows = await execAll<PriceRow>(
    `
      SELECT date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
        ${dateFilter}
      ORDER BY date DESC
      LIMIT 180
    `,
    asOfDate ? [ticker, asOfDate] : [ticker],
  )
  return rows.reverse()
}

async function loadSnapshot(ticker: string, asOfDate?: string | null): Promise<SnapshotRow | null> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  return (await execGet<SnapshotRow>(
    `
      SELECT
        date,
        ma_5 AS ma5,
        ma_25 AS ma25,
        ma_75 AS ma75,
        ma_300 AS ma300
      FROM daily_snapshots
      WHERE ticker = ?
        ${dateFilter}
      ORDER BY date DESC
      LIMIT 1
    `,
    asOfDate ? [ticker, asOfDate] : [ticker],
  )) ?? null
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { ticker: rawTicker } = await context.params
    const ticker = normalizeTicker(rawTicker)
    const asOfDate = parseAsOfDate(request.nextUrl.searchParams.get('date'))
    const feature = await loadLatestFeature(ticker, asOfDate)
    if (!feature) {
      return NextResponse.json({
        ok: true,
        ticker,
        available: false,
        message: '物理ML特徴量が未生成です。',
        horizons: [],
      })
    }

    const profile = parseJson<Record<string, unknown> | null>(feature.featureJson, null)
    const analysis = analyzePhysicsProfile(profile)
    const [momentum, calibrationMap, candidateMap, priceRows, snapshot] = await Promise.all([
      loadMomentum(ticker, asOfDate),
      loadCalibrations(analysis.physicsStatus, asOfDate),
      loadCandidates(ticker, asOfDate),
      loadPriceRows(ticker, asOfDate),
      loadSnapshot(ticker, asOfDate),
    ])

    const horizons = PLAN_HORIZONS.map((horizon) => {
      const calibration = calibrationMap.get(horizon.days) ?? null
      const candidates = candidateMap.get(horizon.days) ?? []
      const levels = buildHorizonLevels(priceRows, snapshot, horizon)
      const plan = planFrom(analysis.physicsStatus, calibration, candidates, momentum, horizon, levels)
      return {
        label: horizon.label,
        horizonDays: horizon.days,
        description: horizon.description,
        statusLabel: analysis.physicsStatus,
        targetDirection: calibration?.targetDirection ?? null,
        hitRate: calibration?.hitRate ?? null,
        baseRate: calibration?.baseRate ?? null,
        lift: calibration?.lift ?? null,
        confidenceScore: calibration?.confidenceScore ?? null,
        confidenceLabel: confidenceLabel(calibration),
        sampleCount: calibration?.sampleCount ?? null,
        adverseRate: calibration?.adverseRate ?? null,
        avgReturnPct: calibration?.avgReturnPct ?? null,
        avgMaxReturnPct: calibration?.avgMaxReturnPct ?? null,
        avgMinReturnPct: calibration?.avgMinReturnPct ?? null,
        medianReturnPct: calibration?.medianReturnPct ?? null,
        evaluationDate: calibration?.evaluationDate ?? null,
        candidates: candidates.map((row) => ({
          asOfDate: row.asOfDate,
          direction: row.direction,
          rank: row.rank,
          score: row.candidateScore,
          modelName: row.modelName,
        })),
        levels,
        suggestion: plan,
      }
    })

    return NextResponse.json({
      ok: true,
      ticker,
      available: true,
      featureSet: ML_PHYSICS_FEATURE_SET,
      featureAsOfDate: feature.date,
      requestedDate: asOfDate,
      priceAsOfDate: priceRows[priceRows.length - 1]?.date ?? null,
      stock: {
        ticker: feature.ticker,
        name: feature.name,
        marketSegment: feature.marketSegment,
        sector17Name: feature.sector17Name,
        sector33Name: feature.sector33Name,
        stageCode: feature.stageCode,
      },
      physicsAnalysis: analysis,
      momentum,
      horizons,
      note: `この表示は${ML_PHYSICS_FEATURE_SET}の現在形状と、過去検証統計から作る観察メモです。売買を断定するものではありません。`,
      format: {
        hitRateExample: pct(horizons[0]?.hitRate),
        avgReturnExample: pctRaw(horizons[0]?.avgReturnPct),
      },
    })
  } catch (error) {
    console.error('stock physical plan API error:', error)
    return NextResponse.json(
      { ok: false, error: 'stock physical plan failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
