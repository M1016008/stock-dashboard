'use client'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export interface LadderRow {
  key: string
  label: string
  value: number | null
  text: string
  note?: string | null
  scale?: string
  basis?: string
  forecast?: boolean
}

export function MetricLadder({
  title,
  rows,
  mode,
}: {
  title: string
  rows: LadderRow[]
  mode: 'signed' | 'value'
}) {
  const scaleMax = new Map<string, number>()
  for (const row of rows) {
    if (row.value == null || !Number.isFinite(row.value)) continue
    const group = row.scale ?? 'default'
    const magnitude = mode === 'signed' ? Math.abs(row.value) : Math.max(0, row.value)
    scaleMax.set(group, Math.max(scaleMax.get(group) ?? 0, magnitude))
  }

  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[11px] font-black text-[var(--color-text-secondary)]">{title}</div>
      <div className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {rows.map((row) => {
          const max = scaleMax.get(row.scale ?? 'default') ?? 0
          const valid = row.value != null && Number.isFinite(row.value) && max > 0
          const ratio = valid ? clamp(Math.abs(row.value as number) / max, 0, 1) : 0
          const negative = valid && (row.value as number) < 0
          const width = valid && (mode === 'signed' || (row.value as number) > 0)
            ? Math.max(2, ratio * (mode === 'signed' ? 50 : 100))
            : 0
          const color = mode === 'signed'
            ? negative ? 'var(--price-down)' : 'var(--price-up)'
            : 'var(--color-brand-700)'
          return (
            <div
              key={row.key}
              className="grid h-7 grid-cols-[84px_minmax(0,1fr)_60px] items-center gap-2 sm:grid-cols-[96px_minmax(0,1fr)_68px]"
              title={row.note ?? undefined}
            >
              <span className="truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                {row.label}
                {row.basis && <span className="ml-0.5 text-[8px]">{row.basis}</span>}
              </span>
              <span className="relative block h-2 bg-[var(--color-surface-subtle)]" aria-hidden="true">
                {mode === 'signed' && <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-border-default)]" />}
                {width > 0 && (
                  <span
                    className="absolute inset-y-0"
                    style={{
                      width: `${width}%`,
                      ...(mode === 'signed'
                        ? negative ? { right: '50%' } : { left: '50%' }
                        : { left: 0 }),
                      ...(row.forecast
                        ? {
                          background: `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 5px)`,
                          boxShadow: `inset 0 0 0 1px ${color}`,
                        }
                        : { background: color }),
                    }}
                  />
                )}
              </span>
              <strong className="truncate text-right font-mono text-[11px] font-bold text-[var(--color-text-primary)]">{row.text}</strong>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ScoreRuler({
  code,
  label,
  value,
  text,
}: {
  code: string
  label: string
  value: number | null | undefined
  text: string
}) {
  const valid = value != null && Number.isFinite(value)
  const position = valid ? ((clamp(value, -2.5, 2.5) + 2.5) / 5) * 100 : 50
  return (
    <div className="grid grid-cols-[40px_minmax(0,1fr)_88px] items-center gap-2" title={`${code} ${label} ${text}`}>
      <span className="text-[10px] font-black text-[var(--color-text-secondary)]">{code}</span>
      <span
        className="relative block h-5"
        role="img"
        aria-label={`${code} ${text}、-2.5から+2.5のZスコア目盛り上の位置`}
      >
        <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 bg-[var(--color-surface-subtle)] ring-1 ring-[var(--color-border-soft)]" />
        <span className="absolute left-1/2 top-0.5 h-4 w-px bg-[var(--color-border-default)]" />
        <span className="absolute left-0 top-[15px] font-mono text-[8px] leading-none text-[var(--color-text-tertiary)]">-2.5</span>
        <span className="absolute right-0 top-[15px] font-mono text-[8px] leading-none text-[var(--color-text-tertiary)]">+2.5</span>
        {valid && (
          <span
            className="absolute top-0.5 h-3.5 w-2 -translate-x-1/2 border border-white bg-[var(--color-brand-900)]"
            style={{ left: `${position}%` }}
          />
        )}
      </span>
      <strong className="text-right font-mono text-[11px] font-black text-[var(--color-text-primary)]">{text}</strong>
    </div>
  )
}

/** Zスコアを0中心の塗りで示す。マトリクスのセル用(-2.5〜+2.5で頭打ち)。 */
export function DivergingBar({
  value,
  text,
  label,
  neutral = false,
}: {
  value: number | null | undefined
  text: string
  label: string
  /** 方向ではない量(熱量など)は上昇/下落色を使わない */
  neutral?: boolean
}) {
  const valid = value != null && Number.isFinite(value)
  const ratio = valid ? clamp(Math.abs(value) / 2.5, 0, 1) : 0
  const negative = valid && value < 0
  const color = neutral ? 'var(--color-brand-700)' : negative ? 'var(--price-down)' : 'var(--price-up)'
  return (
    <span className="grid min-w-0 grid-cols-[minmax(28px,1fr)_auto] items-center gap-1.5" title={`${label} ${text}`}>
      <span className="relative block h-3 bg-[var(--color-surface-subtle)]" role="img" aria-label={`${label} ${text}(-2.5〜+2.5の目盛り)`}>
        <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-border-default)]" />
        {valid && ratio > 0 && (
          <span
            className="absolute inset-y-0"
            style={{
              width: `${Math.max(2, ratio * 50)}%`,
              ...(negative ? { right: '50%' } : { left: '50%' }),
              background: color,
              opacity: 0.35 + ratio * 0.65,
            }}
          />
        )}
      </span>
      <strong
        className="w-10 text-right font-mono text-[10px] font-black"
        style={{ color: !valid ? 'var(--color-text-tertiary)' : neutral ? 'var(--color-text-primary)' : color }}
      >{text}</strong>
    </span>
  )
}

/** 0〜scaleMax%の比率を1本で示し、境界線(既定100%)を引く。単一指標専用。 */
export function BoundedMeter({
  label,
  value,
  text,
  scaleMax = 150,
  boundary = 100,
  boundaryLabel = '100%',
}: {
  label: string
  value: number | null
  text: string
  scaleMax?: number
  boundary?: number
  boundaryLabel?: string
}) {
  const valid = value != null && Number.isFinite(value)
  const width = valid ? clamp(value / scaleMax, 0, 1) * 100 : 0
  const boundaryAt = (boundary / scaleMax) * 100
  return (
    <div className="grid h-7 grid-cols-[84px_minmax(0,1fr)_60px] items-center gap-2 sm:grid-cols-[96px_minmax(0,1fr)_68px]">
      <span className="truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">{label}</span>
      <span className="relative block h-2 bg-[var(--color-surface-subtle)]" role="img" aria-label={`${label} ${text}、${boundaryLabel}の位置に境界線`}>
        {width > 0 && (
          <span
            className="absolute inset-y-0 left-0"
            style={{ width: `${width}%`, background: valid && value > boundary ? 'var(--color-text-secondary)' : 'var(--color-brand-700)' }}
          />
        )}
        <span className="absolute inset-y-[-3px] w-px bg-[var(--color-text-secondary)]" style={{ left: `${boundaryAt}%` }} />
        <span className="absolute top-[9px] -translate-x-1/2 font-mono text-[8px] leading-none text-[var(--color-text-tertiary)]" style={{ left: `${boundaryAt}%` }}>{boundaryLabel}</span>
      </span>
      <strong className="truncate text-right font-mono text-[11px] font-bold text-[var(--color-text-primary)]">{text}</strong>
    </div>
  )
}

export function RankStrip({
  label,
  rank,
  total,
  text,
}: {
  label: string
  rank: number | null | undefined
  total: number | null | undefined
  text: string
}) {
  const valid = rank != null && total != null && total > 0 && rank >= 1 && rank <= total
  const position = valid ? (total === 1 ? 0 : ((rank - 1) / (total - 1)) * 100) : 0
  return (
    <div className="grid grid-cols-[40px_minmax(48px,1fr)_auto] items-center gap-2" title={`${label} ${text}`}>
      <span className="text-[10px] font-black text-[var(--color-text-secondary)]">{label}</span>
      <span className="relative block h-5" role="img" aria-label={`${label} ${text}、左端が1位`}>
        <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 bg-[var(--color-surface-subtle)] ring-1 ring-[var(--color-border-soft)]" />
        <span className="absolute left-0 top-[15px] font-mono text-[8px] leading-none text-[var(--color-text-tertiary)]">1位</span>
        {valid && (
          <span
            className="absolute top-0.5 h-3.5 w-2 -translate-x-1/2 border border-white bg-[var(--color-brand-900)]"
            style={{ left: `${position}%` }}
          />
        )}
      </span>
      <strong className="whitespace-nowrap text-right font-mono text-[11px] font-black text-[var(--color-text-primary)]">{text}</strong>
    </div>
  )
}

export interface ShareSegment {
  key: string
  label: string
  value: number
  color: string
}

export function StackedShareBar({ segments }: { segments: ShareSegment[] }) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0)
  if (total <= 0) return null
  return (
    <div
      className="flex h-8 w-full overflow-hidden border border-[var(--color-border-default)]"
      role="img"
      aria-label={segments.map((segment) => `${segment.label} ${segment.value.toFixed(1)}%`).join('、')}
    >
      {segments.filter((segment) => segment.value > 0).map((segment) => {
        const width = (segment.value / total) * 100
        return (
          <span
            key={segment.key}
            className="flex min-w-0 items-center justify-center overflow-hidden whitespace-nowrap border-r border-white font-mono text-[11px] font-black text-white last:border-r-0"
            style={{ width: `${width}%`, background: segment.color }}
            title={`${segment.label} ${segment.value.toFixed(1)}%`}
          >
            {width >= 16 ? (
              <><span className="hidden sm:inline">{segment.label} </span>{segment.value.toFixed(1)}%</>
            ) : width >= 8 ? `${segment.value.toFixed(0)}%` : ''}
          </span>
        )
      })}
    </div>
  )
}

export type PeerZone = 'below' | 'lower' | 'upper' | 'above'

/** P25/中央値/P75に対する位置区分。既存の分位点だけで決まる。 */
export function peerZone(value: number, p25: number, median: number, p75: number): PeerZone {
  if (value < p25) return 'below'
  if (value > p75) return 'above'
  return value < median ? 'lower' : 'upper'
}

export const PEER_ZONE_LABELS: Record<PeerZone, string> = {
  below: 'P25未満',
  lower: 'P25〜中央値',
  upper: '中央値〜P75',
  above: 'P75超',
}

/**
 * P25→25%、P75→75%に置く線形目盛り。帯の外は帯幅の約0.46倍まで描き、それ以上は端に寄せて矢印で示す。
 * 比較は同一指標内だけで行う。
 */
function peerPosition(value: number, p25: number, p75: number): { left: number; clipped: 'left' | 'right' | null } | null {
  const range = p75 - p25
  if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(value)) return null
  const raw = 25 + ((value - p25) / range) * 50
  if (raw < 2) return { left: 2, clipped: 'left' }
  if (raw > 98) return { left: 98, clipped: 'right' }
  return { left: raw, clipped: null }
}

export interface PeerBandPoint {
  key: string
  label: string
  value: number
  text: string
}

export function PeerPositionRow({
  label,
  p25,
  median,
  p75,
  target,
  peers,
  summary,
  medianText,
}: {
  label: string
  p25: number
  median: number
  p75: number
  target: PeerBandPoint
  peers: PeerBandPoint[]
  summary: string
  medianText: string
}) {
  const medianAt = peerPosition(median, p25, p75)
  const targetAt = peerPosition(target.value, p25, p75)
  if (!medianAt || !targetAt) return null
  const zone = peerZone(target.value, p25, median, p75)
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)_64px] items-center gap-2 py-1 sm:grid-cols-[104px_minmax(0,1fr)_92px]">
      <span className="min-w-0">
        <span className="block truncate text-[10px] font-bold leading-3 text-[var(--color-text-secondary)]">{label}</span>
        <span className="block truncate font-mono text-[8px] leading-3 text-[var(--color-text-tertiary)]">中央値 {medianText}</span>
      </span>
      <span className="relative block h-7" role="img" aria-label={`${label} ${summary}`}>
        <span className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border-default)]" />
        <span className="absolute top-2 h-3 bg-[var(--color-brand-100)]" style={{ left: '25%', width: '50%' }} />
        <span className="absolute top-1.5 h-4 w-px bg-[var(--color-brand-900)]" style={{ left: `${medianAt.left}%` }} />
        {peers.map((peer) => {
          const at = peerPosition(peer.value, p25, p75)
          if (!at) return null
          return (
            <span
              key={peer.key}
              className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-[var(--color-text-tertiary)]"
              style={{ left: `${at.left}%` }}
              title={`${peer.label} ${peer.text}`}
            />
          )
        })}
        <span
          className="absolute top-0 z-[1] h-7 w-[3px] -translate-x-1/2 bg-[var(--color-market-red)]"
          style={{ left: `${targetAt.left}%` }}
          title={`対象 ${target.label} ${target.text}`}
        />
        {targetAt.clipped && (
          <span
            className={`absolute top-1/2 z-[1] -translate-y-1/2 font-mono text-[9px] font-black text-[var(--color-market-red)] ${targetAt.clipped === 'left' ? 'left-[calc(2%+4px)]' : 'right-[calc(2%+4px)]'}`}
            aria-hidden="true"
          >{targetAt.clipped === 'left' ? '◀' : '▶'}</span>
        )}
      </span>
      <span className="min-w-0 text-right">
        <strong className="block truncate font-mono text-[11px] font-black text-[var(--color-market-red)]">{target.text}</strong>
        <span className="block truncate text-[8px] font-bold leading-3 text-[var(--color-text-tertiary)]">{PEER_ZONE_LABELS[zone]}</span>
      </span>
    </div>
  )
}
