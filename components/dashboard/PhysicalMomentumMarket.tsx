import { execGet } from '@/lib/db/client'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'

type Row = {
  date: string | null
  count: number
  avgPms: number | null
  avgPfs: number | null
  avgPes: number | null
  positivePms: number
  negativePms: number
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(2)
}

function toneClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

export async function PhysicalMomentumMarket({ universe = null }: { universe?: UniverseFilterValue }) {
  const universeSql = universeSqlCondition('pm.symbol', universe)
  const row = await execGet<Row>(
    `
      WITH latest AS (
        SELECT MAX(date) AS date
        FROM physical_momentum_metrics
        WHERE market = 'JP'
      )
      SELECT
        latest.date AS date,
        COUNT(*) AS count,
        AVG(pm.physical_momentum_score) AS avgPms,
        AVG(pm.physical_force_score) AS avgPfs,
        AVG(pm.physical_energy_score) AS avgPes,
        SUM(CASE WHEN pm.physical_momentum_score > 0 THEN 1 ELSE 0 END) AS positivePms,
        SUM(CASE WHEN pm.physical_momentum_score < 0 THEN 1 ELSE 0 END) AS negativePms
      FROM latest
      LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
      WHERE pm.physical_momentum_score IS NOT NULL
        ${universeSql.sql ? `AND ${universeSql.sql}` : ''}
    `,
    universeSql.params,
  )

  return (
    <section className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">市場 Physical Momentum</h2>
          <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            速度・加速度・力・エネルギー・MA角度を横断Zスコア化した市場平均です。
          </p>
        </div>
        <span className="font-mono text-[11px] font-bold text-[var(--color-text-tertiary)]">
          {row?.date ?? '---'} / {Number(row?.count ?? 0).toLocaleString()}銘柄
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <MomentumTile label="平均PMS" value={row?.avgPms ?? null} />
        <MomentumTile label="平均PFS" value={row?.avgPfs ?? null} />
        <MomentumTile label="平均PES" value={row?.avgPes ?? null} />
        <MomentumCount label="PMSプラス" value={row?.positivePms ?? 0} tone="up" />
        <MomentumCount label="PMSマイナス" value={row?.negativePms ?? 0} tone="down" />
      </div>
    </section>
  )
}

function MomentumTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 font-mono text-[20px] font-bold ${toneClass(value)}`}>{fmtScore(value)}</div>
    </div>
  )
}

function MomentumCount({ label, value, tone }: { label: string; value: number; tone: 'up' | 'down' }) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 font-mono text-[20px] font-bold ${tone === 'up' ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'}`}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
