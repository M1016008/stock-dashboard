import type { MomentumState } from '@/lib/daily-close-momentum-matrix'

// Page 06 Design Lab「レイアウト」定数。見た目の調整はまずここを編集する。
// 単位: *Mm = mm、*Pt = pt、MATRIX の座標は SVG user unit (viewBox 基準)。

// A4 landscape (既存 Daily Close Report と同じ @page size: A4 landscape)
export const PAGE = {
  widthMm: 297,
  heightMm: 210,
  paddingTopMm: 7,
  paddingXMm: 10,
  paddingBottomMm: 5,
  rowGapMm: 2.2,
  // PNG プレビュー用 viewport (A4 landscape @ 96dpi)
  viewportWidthPx: 1123,
  viewportHeightPx: 794,
} as const

// 中段: 左 Matrix / 右 状態別リスト
export const BODY = {
  matrixFr: 1.62,
  listFr: 1,
  columnGapMm: 4,
} as const

export const MATRIX = {
  viewWidth: 640,
  viewHeight: 440,
  plot: { left: 54, top: 24, width: 566, height: 370 },
  axisTitleOffsetY: 10, // 縦軸タイトルをプロット上端からどれだけ上に置くか
  rankMax: 60,
  pointRadius: 4,
  labeledPointRadius: 5.2,
  labelGap: 12, // 同じ側のラベル同士の最小縦間隔
  labelOffset: 9, // 点からラベルまでの横距離
  leaderMinOffset: 3, // これ以上ずれたら引き出し線を描く
  zoneFillOpacity: 0.08,
  zoneStrokeOpacity: 0.35,
  neutralFillOpacity: 0.55,
  stateFillOpacity: 0.92,
  lowSampleDash: '2.2 1.6',
  ticks: [1, 15, 30, 45, 60],
} as const

// 状態別リストの列幅 (分類名は残り幅)
export const LIST_COLUMNS_MM = {
  rank: 15,
  shift: 9,
  mean: 12,
  median: 12,
  winRate: 9,
} as const

export const FONT_PT = {
  kicker: 7.5,
  title: 17,
  meta: 7.5,
  headline: 14.5,
  sourceBadge: 6.5,
  kpiLabel: 8,
  kpiValue: 15,
  kpiNote: 6.5,
  listHead: 6.4,
  list: 7.6,
  stateName: 8.6,
  flag: 5.6,
  legend: 6.8,
  narrativeLabel: 6.8,
  narrative: 8.4,
  footer: 6,
} as const

// SVG 内フォント (viewBox 基準 px。印刷時は約 0.27mm/unit)
export const MATRIX_FONT = {
  zone: 11,
  tick: 10,
  axis: 10.5,
  point: 11,
  diagonal: 9.5,
} as const

export const COLORS = {
  ink: '#0b1f33',
  muted: '#5b6b7a',
  line: '#d5dee6',
  soft: '#f4f7fa',
  plotBg: '#fbfcfd',
  tick: '#9aa9b6',
  accent: '#0f766e',
  labBadge: '#b45309',
  screenBg: '#e9eef2',
  flagMeanBg: '#fef3c7',
  flagMeanText: '#92400e',
} as const

export const STATE_COLOR: Record<MomentumState, string> = {
  LEADER: '#0f766e',
  EMERGING: '#1d4ed8',
  FADING: '#b91c1c',
  RECOVERING: '#b45309',
  NEUTRAL: '#94a3b8',
}

export const FONT_FAMILY = '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif'
