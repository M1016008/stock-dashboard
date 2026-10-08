// components/dashboard/DashboardPrimitives.tsx
//
// Dashboard 内部だけで使う表示用の小さな部品。
// - 値の計算はしない (渡された値をそのまま描く)
// - 色は意味のあるものだけ: 上昇=赤 / 下落=青 / 注意=琥珀 / 中立=墨・ブランド
// - カードを作らず、罫線・余白・揃えで情報をまとめる

export type DashboardTone = 'up' | 'down' | 'neutral' | 'warning'

export const TONE_TEXT: Record<DashboardTone, string> = {
  up: 'text-[var(--color-price-up)]',
  down: 'text-[var(--color-price-down)]',
  warning: 'text-[#b45309]',
  neutral: 'text-[var(--color-text-primary)]',
}

export const TONE_FILL: Record<DashboardTone, string> = {
  up: 'var(--color-price-up)',
  down: 'var(--color-price-down)',
  warning: '#d97706',
  neutral: 'var(--color-brand-700)',
}

export const TONE_RULE: Record<DashboardTone, string> = {
  up: 'border-l-[var(--color-price-up)]',
  down: 'border-l-[var(--color-price-down)]',
  warning: 'border-l-[#d97706]',
  neutral: 'border-l-[var(--color-border-strong)]',
}

/** 符号だけで色を決める (0・欠損は中立) */
export function signedTextClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return TONE_TEXT.up
  if (value < 0) return TONE_TEXT.down
  return 'text-[var(--color-text-secondary)]'
}

/** 小見出し (セクション内のグループ名)。大文字英字ラベルは使わず、日本語の短い名詞で示す */
export function GroupLabel({
  children,
  meta,
  className = '',
}: {
  children: React.ReactNode
  meta?: React.ReactNode
  className?: string
}) {
  return (
    // 狭い画面では注記を見出しの下へ折り返す (nowrap のままだと min-content が画面幅を超える)
    <div className={`flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 sm:flex-nowrap ${className}`}>
      <h3 className="shrink-0 text-[12px] font-bold text-[var(--color-brand-900)]">{children}</h3>
      {meta != null && (
        <div className="min-w-0 text-[10px] font-semibold leading-snug tabular-nums text-[var(--color-text-tertiary)] sm:truncate sm:text-right">{meta}</div>
      )}
    </div>
  )
}

/**
 * 0〜100 の割合を細いバーで描く。
 * midTick を付けると 50% の位置に基準線を引く (過半かどうかを目で読むため)。
 */
export function MeterBar({
  value,
  tone,
  midTick = false,
  className = '',
}: {
  value: number | null | undefined
  tone: DashboardTone
  midTick?: boolean
  className?: string
}) {
  const width = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value))
  return (
    <span
      aria-hidden="true"
      className={`relative block h-[6px] overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)] ${className}`}
    >
      <span className="absolute inset-y-0 left-0 rounded-[2px]" style={{ width: `${width}%`, background: TONE_FILL[tone], opacity: 0.78 }} />
      {midTick && <span className="absolute inset-y-[-1px] left-1/2 w-px bg-[var(--color-text-tertiary)] opacity-60" />}
    </span>
  )
}

/** 文字だけの小さな状態ラベル (塗りつぶしピルを使わない) */
export function ToneLabel({
  tone,
  children,
  className = '',
}: {
  tone: DashboardTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-bold ${TONE_TEXT[tone]} ${className}`}>
      <span aria-hidden="true" className="inline-block h-[7px] w-[7px] rounded-[1px]" style={{ background: TONE_FILL[tone] }} />
      {children}
    </span>
  )
}

/** ラベルと数値の対。数値は等幅・右揃え前提 */
export function Figure({
  label,
  value,
  className = '',
  valueClassName = '',
}: {
  label: React.ReactNode
  value: React.ReactNode
  className?: string
  valueClassName?: string
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="whitespace-nowrap text-[10px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-0.5 whitespace-nowrap font-mono text-[15px] font-bold leading-tight tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  )
}

/* ---------- 売買候補 blotter の列定義 ----------
 * 一覧の行・列見出し・スケルトンで同じ定義を使い、列の揃いと読み込み前後の位置を一致させる。
 * display は呼び出し側で付ける (見出しは md 未満で隠すため)。
 *
 * 領域名:
 *   sc 順位+確度 / id 銘柄 / px 価格+前日比 / sn シナリオ方向+スコア / wt 上横下の重み
 *   tp #1シナリオ / ts 目標+撤退 / st 6ステージ / ph PMS·PFS·PES / vo 平均出来高 / tg 詳細開閉
 *
 * < md (390 など): 4 段。要点 (確度・銘柄・価格 → 方向・重み → ステージ・物理 → 目標/撤退+詳細)
 * md〜lg (768/1024): 2 段。上段で一次判断、下段 (sub) で比較指標を列揃えで並べる
 * xl (1280〜): 1 段の blotter。全列が見出しと揃う
 */
export const SIGNAL_ROW_GRID = [
  'items-center gap-x-2.5 gap-y-1.5',
  "grid-cols-[2.75rem_4.5rem_minmax(0,1fr)_auto] [grid-template-areas:'sc_id_id_px'_'sn_sn_wt_wt'_'st_st_st_ph'_'ts_ts_ts_tg']",
  "md:grid-cols-[4.25rem_minmax(0,1.3fr)_5.75rem_5.25rem_minmax(7rem,1fr)_1.75rem] md:gap-y-1 md:[grid-template-areas:'sc_id_px_sn_wt_tg'_'._sub_sub_sub_sub_sub']",
  "xl:grid-cols-[4.25rem_minmax(8.5rem,1.5fr)_5.75rem_5.25rem_minmax(7.5rem,1fr)_minmax(6rem,1fr)_6rem_8.25rem_8rem_3.5rem_1.75rem] xl:[grid-template-areas:'sc_id_px_sn_wt_tp_ts_st_ph_vo_tg']",
].join(' ')

/** md〜lg だけ比較指標を下段の小 grid に入れる。390 と xl では contents にして親 grid へ直接置く */
export const SIGNAL_SUB_GRID =
  'contents md:grid md:[grid-area:sub] md:grid-cols-[minmax(0,1fr)_11.5rem_8.25rem_8rem] md:items-center md:gap-x-2.5 lg:grid-cols-[minmax(0,1fr)_11.5rem_8.25rem_8rem_3.5rem] xl:contents'

export const SIGNAL_AREA = {
  sc: '[grid-area:sc]',
  id: '[grid-area:id]',
  px: '[grid-area:px]',
  sn: '[grid-area:sn]',
  wt: '[grid-area:wt]',
  tg: '[grid-area:tg]',
  tp: 'hidden md:block md:[grid-area:auto] xl:[grid-area:tp]',
  ts: '[grid-area:ts] md:[grid-area:auto] xl:[grid-area:ts]',
  st: '[grid-area:st] md:[grid-area:auto] xl:[grid-area:st]',
  ph: '[grid-area:ph] md:[grid-area:auto] xl:[grid-area:ph]',
  vo: 'hidden lg:block lg:[grid-area:auto] xl:[grid-area:vo]',
} as const

/** 詳細パネルを銘柄列の左端に揃えるための字下げ (sc 列 4.25rem + 列間 0.625rem) */
export const SIGNAL_DETAIL_INDENT = 'md:ml-[4.875rem]'

/** 骨組みだけのスケルトン片 */
export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded-[2px] bg-[var(--color-surface-muted)] ${className}`} />
}
