// JP/US 個別銘柄ページ共通の表示専用ヘルパー(テクニカル・概要タブ)。
// 判定ロジック・閾値は両市場で同一の式で、新しいスコアや閾値は追加していない。
// 市場ごとに異なる応答型・文言・判定(JP buildShortTermEvidence、US us-technical-view.ts など)は各市場側に置く。
import type { PhysicalMomentumTone } from '@/lib/physical-momentum-view'

/** stage-history API の1行(日足・count=1)。終値とMAは「終値の位置」、6軸は6ステージに使う */
export interface StageEntry {
  date: string
  close: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

export type StageKey =
  | 'daily_a_stage'
  | 'daily_b_stage'
  | 'weekly_a_stage'
  | 'weekly_b_stage'
  | 'monthly_a_stage'
  | 'monthly_b_stage'

export const STAGE_KEYS: { key: StageKey; label: string }[] = [
  { key: 'daily_a_stage', label: '日A' },
  { key: 'daily_b_stage', label: '日B' },
  { key: 'weekly_a_stage', label: '週A' },
  { key: 'weekly_b_stage', label: '週B' },
  { key: 'monthly_a_stage', label: '月A' },
  { key: 'monthly_b_stage', label: '月B' },
]

export const STAGE_TIMEFRAME_LABELS = ['日足', '週足', '月足'] as const

// ---------- 数値の表示 ----------

export function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function fmtRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(0)}%`
}

export function fmtLift(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(2)}x`
}

export function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

export function formatDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

export function fmtDeg(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}°`
}

type MomentumTrend = 'rising' | 'falling' | 'flat' | null

export function trendText(trend: MomentumTrend): string {
  return trend === 'rising' ? '上昇中' : trend === 'falling' ? '低下中' : trend === 'flat' ? '横ばい' : '推移未判定'
}

export function trendArrow(trend: MomentumTrend): string {
  return trend === 'rising' ? '↗' : trend === 'falling' ? '↘' : trend === 'flat' ? '→' : '·'
}

export function trendLabelFromDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '判定保留'
  if (value >= 0.35) return '改善'
  if (value <= -0.35) return '悪化'
  return '横ばい'
}

export function scoreLevelLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'PMS未判定'
  if (value >= 1) return '市場より強い'
  if (value >= 0.35) return 'やや強い'
  if (value <= -1) return '市場より弱い'
  if (value <= -0.35) return 'やや弱い'
  return '市場平均付近'
}

export function scoreTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'var(--text-primary)'
  return value > 0 ? 'var(--price-up)' : 'var(--price-down)'
}

export function physicalToneColor(tone: PhysicalMomentumTone): string {
  if (tone === 'up') return 'var(--price-up)'
  if (tone === 'down') return 'var(--price-down)'
  if (tone === 'warning') return '#b45309'
  return 'var(--text-secondary)'
}

export function directionLabelJa(direction: 'up' | 'down' | 'wait'): string {
  if (direction === 'up') return '上昇'
  if (direction === 'down') return '下落'
  return '見送り'
}

// ---------- 判定の境界(buildPhysicalMomentumView と同じ: PMS ±1、PFS ±0.35、PES +1 / -0.35) ----------

export const PHYSICAL_FORCE_THRESHOLD = 0.35
export const PHYSICAL_STRONG_PMS = 1

export const PHYSICAL_BOUNDARIES: Array<{ code: 'PMS' | 'PFS' | 'PES'; label: string; marks: number[] }> = [
  { code: 'PMS', label: '強さ', marks: [-PHYSICAL_STRONG_PMS, PHYSICAL_STRONG_PMS] },
  { code: 'PFS', label: '方向', marks: [-PHYSICAL_FORCE_THRESHOLD, PHYSICAL_FORCE_THRESHOLD] },
  { code: 'PES', label: '熱量', marks: [-0.35, 1] },
]

export function nearestBoundaryText(value: number | null, marks: number[]): string {
  if (value == null || !Number.isFinite(value)) return '未算出'
  const below = marks.filter((mark) => mark <= value).sort((a, b) => b - a)[0]
  const above = marks.filter((mark) => mark > value).sort((a, b) => a - b)[0]
  const parts: string[] = []
  if (above != null) parts.push(`${formatDelta(above)}まで +${(above - value).toFixed(2)}`)
  if (below != null) parts.push(`${formatDelta(below)}まで -${(value - below).toFixed(2)}`)
  return parts.join(' / ')
}

// ---------- MA力場(JP buildMaFieldInsight と同じ判定) ----------

export interface MaFieldInsight {
  label: string
  description: string
  color: string
  spreadDeg: number | null
  spreadChangeDeg: number | null
}

export interface MaAngleSet {
  ma5: number | null
  ma25: number | null
  ma75: number | null
  ma200: number | null
}

export interface MaFieldInputs {
  shortAvg: number | null
  longAvg: number | null
  up: number
  down: number
  total: number
}

/** physical-momentum API の行のうち MA角度(ラジアン)だけを読む。JP/US の応答行どちらも渡せる */
interface MaAngleRow {
  ma5Angle?: number | null
  ma25Angle?: number | null
  ma75Angle?: number | null
  ma200Angle?: number | null
}

export const MA_FIELD_THRESHOLD_DEG = 0.2
export const MA_FIELD_SPREAD_SHIFT_DEG = 5

export const MA_ANGLE_KEYS: Array<{ key: keyof MaAngleSet; label: string }> = [
  { key: 'ma5', label: '5MA' },
  { key: 'ma25', label: '25MA' },
  { key: 'ma75', label: '75MA' },
  { key: 'ma200', label: '200MA' },
]

function angleDeg(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return (value * 180) / Math.PI
}

function averageFinite(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function angularSpread(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values) - Math.min(...values)
}

export function buildMaFieldInsight(latest: MaAngleRow, previous: MaAngleRow | null): MaFieldInsight {
  const latestAngles = [latest.ma5Angle, latest.ma25Angle, latest.ma75Angle, latest.ma200Angle]
    .map(angleDeg)
    .filter((value): value is number => value != null)
  const previousAngles = previous
    ? [previous.ma5Angle, previous.ma25Angle, previous.ma75Angle, previous.ma200Angle]
      .map(angleDeg)
      .filter((value): value is number => value != null)
    : []

  if (latestAngles.length < 3) {
    return {
      label: 'MA力場未判定',
      description: 'MA角度データが不足しています。',
      color: 'var(--text-muted)',
      spreadDeg: null,
      spreadChangeDeg: null,
    }
  }

  const ma5 = angleDeg(latest.ma5Angle)
  const ma25 = angleDeg(latest.ma25Angle)
  const ma75 = angleDeg(latest.ma75Angle)
  const ma200 = angleDeg(latest.ma200Angle)
  const shortAvg = averageFinite([ma5, ma25])
  const longAvg = averageFinite([ma75, ma200])
  const positive = latestAngles.filter((value) => value > 0.2).length
  const negative = latestAngles.filter((value) => value < -0.2).length
  const spreadDeg = angularSpread(latestAngles)
  const previousSpread = previousAngles.length >= 3 ? angularSpread(previousAngles) : null
  const spreadChangeDeg = spreadDeg != null && previousSpread != null ? spreadDeg - previousSpread : null

  let label = '力場は中立'
  let description = '短期線と長期線の向きがまだ揃っていません。価格の力がどちらへ伝わるか確認する局面です。'
  let color = 'var(--text-secondary)'

  if (shortAvg != null && longAvg != null && shortAvg > 0.2 && longAvg > 0.2 && positive >= 3) {
    label = '上方向へ力が拡散'
    description = '短期線だけでなく長期線側にも上向きの力が伝わっています。上位足との整合を確認したい状態です。'
    color = 'var(--price-up)'
  } else if (shortAvg != null && longAvg != null && shortAvg < -0.2 && longAvg < -0.2 && negative >= 3) {
    label = '下方向へ力が拡散'
    description = '短期線から長期線側まで下向きの力が広がっています。反発よりも下落継続リスクを優先確認します。'
    color = 'var(--price-down)'
  } else if (shortAvg != null && longAvg != null && shortAvg > 0.2 && longAvg < -0.2) {
    label = '短期上向き・長期収縮'
    description = '短期には上向きの力がありますが、長期線はまだ下向きです。力が長期側へ拡散するかが焦点です。'
    color = 'var(--price-up)'
  } else if (shortAvg != null && longAvg != null && shortAvg < -0.2 && longAvg > 0.2) {
    label = '短期調整・長期残存'
    description = '短期線は下向きですが、長期線には上向きの力が残っています。一時調整か崩れ始めかを確認します。'
    color = 'var(--price-down)'
  } else if (spreadChangeDeg != null && spreadChangeDeg >= 5) {
    label = '力場が拡散中'
    description = 'MA角度の幅が広がっています。力が一方向へ揃うか、ねじれとして分散するかを確認します。'
    color = positive >= negative ? 'var(--price-up)' : 'var(--price-down)'
  } else if (spreadChangeDeg != null && spreadChangeDeg <= -5) {
    label = '力場が収縮中'
    description = 'MA角度の幅が狭まっています。方向感はいったん圧縮され、次の拡散方向を待つ局面です。'
    color = 'var(--text-secondary)'
  } else if (positive > 0 && negative > 0) {
    label = '力場がねじれ'
    description = '短期・中期・長期の向きが混在しています。単純な上昇/下落ではなく、時間軸ごとの力の差を見ます。'
    color = 'var(--text-secondary)'
  }

  return { label, description, color, spreadDeg, spreadChangeDeg }
}

/** APIのラジアン角を度に直すだけの表示変換 */
export function maAngleSet(row: MaAngleRow): MaAngleSet {
  return {
    ma5: angleDeg(row.ma5Angle),
    ma25: angleDeg(row.ma25Angle),
    ma75: angleDeg(row.ma75Angle),
    ma200: angleDeg(row.ma200Angle),
  }
}

// buildMaFieldInsight と同じ入力(短期=5・25MA平均、長期=75・200MA平均、±0.2°)を表示用に取り出す
export function maFieldInputs(angles: MaAngleSet): MaFieldInputs {
  const all = [angles.ma5, angles.ma25, angles.ma75, angles.ma200].filter((value): value is number => value != null)
  return {
    shortAvg: averageFinite([angles.ma5, angles.ma25]),
    longAvg: averageFinite([angles.ma75, angles.ma200]),
    up: all.filter((value) => value > MA_FIELD_THRESHOLD_DEG).length,
    down: all.filter((value) => value < -MA_FIELD_THRESHOLD_DEG).length,
    total: all.length,
  }
}

/** MA力場ラベルが変わる境界を、現在の入力値と並べて文章化する(判定ロジックの閾値をそのまま使う) */
export function maFieldChangeConditions(label: string, inputs: MaFieldInputs): string[] {
  const short = `短期平均(5・25MA)${fmtDeg(inputs.shortAvg)}`
  const long = `長期平均(75・200MA)${fmtDeg(inputs.longAvg)}`
  const t = MA_FIELD_THRESHOLD_DEG
  if (label === '下方向へ力が拡散') {
    return [
      `${short}が-${t}°以上になると外れる(+${t}°超なら「短期上向き・長期収縮」)`,
      `${long}が-${t}°以上になると外れる`,
      `下向きのMA ${inputs.down}/${inputs.total}本(3本未満で外れる)`,
    ]
  }
  if (label === '上方向へ力が拡散') {
    return [
      `${short}が+${t}°以下になると外れる(-${t}°未満なら「短期調整・長期残存」)`,
      `${long}が+${t}°以下になると外れる`,
      `上向きのMA ${inputs.up}/${inputs.total}本(3本未満で外れる)`,
    ]
  }
  if (label === '短期上向き・長期収縮') {
    return [
      `${long}が-${t}°以上になると外れる(+${t}°超・上向き3本以上なら「上方向へ力が拡散」)`,
      `${short}が+${t}°以下になると外れる`,
    ]
  }
  if (label === '短期調整・長期残存') {
    return [
      `${long}が+${t}°以下になると外れる(-${t}°未満・下向き3本以上なら「下方向へ力が拡散」)`,
      `${short}が-${t}°以上になると外れる`,
    ]
  }
  if (label === 'MA力場未判定') return ['MA角度が3本以上そろうと判定されます']
  return [
    `短期・長期の平均がともに±${t}°を超えて同じ向きにそろい、同じ向きが3本以上で「上/下方向へ力が拡散」`,
    `角度幅の前回比が±${MA_FIELD_SPREAD_SHIFT_DEG}°を超えると「拡散中/収縮中」`,
  ]
}

export function angleDirectionArrow(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 1.2) return '↗'
  if (value <= -1.2) return '↘'
  return '→'
}

export function angleDirectionLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未判定'
  if (value >= 3) return '上向き強'
  if (value >= 1.2) return '上向き'
  if (value <= -3) return '下向き強'
  if (value <= -1.2) return '下向き'
  return '横ばい'
}

export function angleDirectionColor(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'var(--text-muted)'
  if (value >= 1.2) return 'var(--price-up)'
  if (value <= -1.2) return 'var(--price-down)'
  return 'var(--text-secondary)'
}

/** physical-momentum の応答から、直前営業日の行を探す(MA力場の角度幅の前回比に使う) */
export function previousMomentumRow<T extends { date: string }>(data: { latest: T | null; history: T[] } | null): T | null {
  const latest = data?.latest
  if (!latest) return null
  return [...(data?.history ?? [])].reverse().find((row) => row.date < latest.date) ?? null
}

// ---------- チャートタブの現在構造スナップショット ----------

export type TechnicalMomentumSnapshot = {
  status: 'loading' | 'available' | 'missing' | 'error'
  scoreDate: string | null
  maDate: string | null
  pms: number | null
  pfs: number | null
  pes: number | null
  isScoreFresh: boolean | null
  maStructure: string | null
  maDescription: string | null
  maColor: string | null
  maAngles: MaAngleSet | null
  maSpreadDeg: number | null
  maSpreadChangeDeg: number | null
  message: string | null
}

/** status と message 以外が未取得のスナップショット(読み込み中・取得失敗・未算出の土台) */
export const EMPTY_MOMENTUM_SNAPSHOT: Omit<TechnicalMomentumSnapshot, 'status' | 'message'> = {
  scoreDate: null,
  maDate: null,
  pms: null,
  pfs: null,
  pes: null,
  isScoreFresh: null,
  maStructure: null,
  maDescription: null,
  maColor: null,
  maAngles: null,
  maSpreadDeg: null,
  maSpreadChangeDeg: null,
}

// ---------- 6ステージ ----------

export function normalizeStage(stage: number | null | undefined): number | null {
  if (stage == null || !Number.isFinite(stage)) return null
  const rounded = Math.round(stage)
  return rounded >= 1 && rounded <= 6 ? rounded : null
}

export function shortStageLabel(stage: number): string {
  if (stage === 1) return '安定上昇'
  if (stage === 2) return '調整'
  if (stage === 3) return '弱気移行'
  if (stage === 4) return '安定下降'
  if (stage === 5) return '反発兆し'
  return '強気初期'
}

// ---------- 短期チェックの根拠(JP buildShortTermEvidence / US buildUsShortTermEvidence が共有する部品) ----------

export type EvidenceDirection = 'up' | 'down' | 'flat' | null

export interface ShortTermEvidenceItem {
  label: string
  /** 結論文で使う短い名前 */
  name: string
  value: string
  direction: EvidenceDirection
}

export interface ShortTermEvidenceSide {
  key: 'short' | 'medium'
  label: string
  items: ShortTermEvidenceItem[]
  up: number
  down: number
  direction: EvidenceDirection
}

// lib/short-term-check と同じ閾値・区分を表示用に参照する(判定そのものは buildShortTermCheck の結果を使う)
export const SHORT_TERM_PFS_THRESHOLD = 0.8
export const SHORT_TERM_CHANGE_THRESHOLD = 2
export const SHORT_TERM_PMS_LEVEL = 0.35
export const SHORT_TERM_STRONG_PCT = 40
export const SHORT_TERM_LEAN_PCT = 14

export function stageSide(stage: number | null | undefined): EvidenceDirection {
  const value = normalizeStage(stage)
  if (value == null) return null
  if (value === 1 || value === 6) return 'up'
  if (value === 3 || value === 4) return 'down'
  return 'flat'
}

export function tallyDirection(directions: EvidenceDirection[]): EvidenceDirection {
  const known = directions.filter((direction): direction is Exclude<EvidenceDirection, null> => direction != null)
  if (known.length === 0) return null
  const up = known.filter((direction) => direction === 'up').length
  const down = known.filter((direction) => direction === 'down').length
  return up > down ? 'up' : down > up ? 'down' : 'flat'
}

export function thresholdDirection(value: number | null | undefined, threshold: number): EvidenceDirection {
  if (value == null || !Number.isFinite(value)) return null
  return value >= threshold ? 'up' : value <= -threshold ? 'down' : 'flat'
}

export function stagePairText(a: number | null | undefined, b: number | null | undefined): string {
  return `S${normalizeStage(a) ?? '-'}・S${normalizeStage(b) ?? '-'}`
}

export function directionGlyph(direction: EvidenceDirection): string {
  return direction === 'up' ? '▲' : direction === 'down' ? '▼' : direction === 'flat' ? '–' : '·'
}

export function directionWord(direction: EvidenceDirection): string {
  return direction === 'up' ? '上向き' : direction === 'down' ? '下向き' : direction === 'flat' ? '中立' : '未取得'
}

export function directionColor(direction: EvidenceDirection): string {
  return direction === 'up' ? 'var(--price-up)' : direction === 'down' ? 'var(--price-down)' : 'var(--color-text-tertiary)'
}

export function upperStageText(stage: StageEntry): string {
  const upper = [stage.weekly_a_stage, stage.weekly_b_stage, stage.monthly_a_stage, stage.monthly_b_stage].map(stageSide)
  const positive = upper.filter((side) => side === 'up').length
  const negative = upper.filter((side) => side === 'down').length
  if (positive >= 3) return '強気整合'
  if (negative >= 3) return '弱気整合'
  if (positive > negative) return 'やや強い'
  if (negative > positive) return 'やや弱い'
  return '混在'
}

/** 根拠の向きを「何が支え、何が逆向き・中立か」の一文にまとめる(各項目の向き判定をそのまま使う) */
export function shortTermSideReading(title: string, side: ShortTermEvidenceSide): string {
  const names = (direction: EvidenceDirection) => side.items.filter((item) => item.direction === direction).map((item) => item.name)
  const up = names('up')
  const down = names('down')
  const flat = names('flat')
  if (side.direction == null) return `${title}は判定材料なし`
  if (side.direction === 'flat') {
    return up.length === 0 && down.length === 0
      ? `${title}は向きを示す材料がなく中立`
      : `${title}は上向き(${up.join('・')})と下向き(${down.join('・')})が拮抗`
  }
  const lead = side.direction === 'up' ? up : down
  const opposite = side.direction === 'up' ? down : up
  const others = opposite.length + flat.length
  let text = `${title}は${lead.join('・')}${lead.length === 1 && others > 0 ? 'のみ' : ''}が${directionWord(side.direction)}`
  if (opposite.length > 0) text += `、${opposite.join('・')}は${directionWord(side.direction === 'up' ? 'down' : 'up')}`
  if (flat.length > 0) text += `、${flat.join('・')}は中立`
  return text
}
