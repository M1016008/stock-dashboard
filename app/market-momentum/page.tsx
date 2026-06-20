import type { Metadata } from 'next'
import Link from 'next/link'
import { PageTitle } from '@/components/layout/PageTitle'
import { StageTag } from '@/components/ui/StageTag'
import { execAll, execGet } from '@/lib/db/client'
import {
  MARKET_MOMENTUM_GROUP_ORDER,
  MARKET_MOMENTUM_GROUPS,
  marketMomentumGroupSql,
  marketMomentumHref,
  parseMarketMomentumGroup,
  screenerHrefForMarketMomentumGroup,
  type MarketMomentumGroupId,
} from '@/lib/market-momentum-groups'

export const metadata: Metadata = {
  title: '市場モメンタム詳細 — StockBoard',
  description: '日経225、プライム、スタンダード、グロース別に初動・強い勢い・弱含み銘柄を確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type SummaryRow = {
  date: string | null
  count: number
  positivePms: number
  negativePms: number
  strongPms: number
  weakPms: number
  positivePfs: number
  highPes: number
}

type StockMomentumRow = {
  ticker: string
  name: string | null
  marketSegment: string | null
  marginType: string | null
  sector17Name: string | null
  sector33Name: string | null
  price: number | null
  changePct: number | null
  volume: number | null
  pms: number | null
  pfs: number | null
  pes: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
}

function ratio(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part == null || total == null || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null
  return (part / total) * 100
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value.toFixed(1)}%`
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(2)
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000).toLocaleString('ja-JP')}K`
  return value.toLocaleString('ja-JP')
}

function scoreColor(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function statusFor(row: StockMomentumRow): { label: string; tone: 'up' | 'down' | 'warning' | 'neutral' } {
  const pms = row.pms ?? 0
  const pfs = row.pfs ?? 0
  if (pfs >= 1 && pms >= 0) return { label: '初動あり', tone: 'warning' }
  if (pms >= 1) return { label: '強い勢い', tone: 'up' }
  if (pms <= -1 || pfs <= -0.8) return { label: '弱い/失速', tone: 'down' }
  if (pfs > 0 && pms > 0) return { label: '前向き', tone: 'up' }
  return { label: '中立', tone: 'neutral' }
}

function statusClass(tone: 'up' | 'down' | 'warning' | 'neutral'): string {
  if (tone === 'up') return 'border-[rgba(185,28,28,0.24)] bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  if (tone === 'down') return 'border-[rgba(30,64,175,0.24)] bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  if (tone === 'warning') return 'border-[rgba(217,119,6,0.24)] bg-[#fff7ed] text-[#b45309]'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

async function getMarketMomentumData(group: MarketMomentumGroupId) {
  const groupSql = marketMomentumGroupSql(
    group,
    'pm.symbol',
    "COALESCE(NULLIF(tu.market_segment, ''), '未分類')",
  )
  const commonLatest = `
    WITH latest AS (
      SELECT MAX(date) AS date
      FROM physical_momentum_metrics
      WHERE market = 'JP'
    )
  `
  const aggregateSelect = `
    COUNT(*) AS count,
    SUM(CASE WHEN pm.physical_momentum_score > 0 THEN 1 ELSE 0 END) AS positivePms,
    SUM(CASE WHEN pm.physical_momentum_score < 0 THEN 1 ELSE 0 END) AS negativePms,
    SUM(CASE WHEN pm.physical_momentum_score >= 1 THEN 1 ELSE 0 END) AS strongPms,
    SUM(CASE WHEN pm.physical_momentum_score <= -1 THEN 1 ELSE 0 END) AS weakPms,
    SUM(CASE WHEN pm.physical_force_score > 0 THEN 1 ELSE 0 END) AS positivePfs,
    SUM(CASE WHEN pm.physical_energy_score >= 1 THEN 1 ELSE 0 END) AS highPes
  `
  const rowsSelect = `
    SELECT
      pm.symbol AS ticker,
      tu.name AS name,
      tu.market_segment AS marketSegment,
      tu.margin_type AS marginType,
      tu.sector17_name AS sector17Name,
      tu.sector33_name AS sector33Name,
      cur.close AS price,
      cur.volume AS volume,
      CASE WHEN prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close END AS changePct,
      pm.physical_momentum_score AS pms,
      pm.physical_force_score AS pfs,
      pm.physical_energy_score AS pes,
      ds.daily_a_stage AS dailyAStage,
      ds.daily_b_stage AS dailyBStage,
      ds.weekly_a_stage AS weeklyAStage,
      ds.weekly_b_stage AS weeklyBStage,
      ds.monthly_a_stage AS monthlyAStage,
      ds.monthly_b_stage AS monthlyBStage
    FROM latest
    JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
    LEFT JOIN ticker_universe tu ON tu.ticker = pm.symbol
    LEFT JOIN ohlcv_daily cur ON cur.ticker = pm.symbol AND cur.date = latest.date
    LEFT JOIN ohlcv_daily prev ON prev.ticker = pm.symbol AND prev.date = (
      SELECT MAX(date) FROM ohlcv_daily WHERE ticker = pm.symbol AND date < latest.date
    )
    LEFT JOIN daily_snapshots ds ON ds.ticker = pm.symbol AND ds.date = latest.date
    WHERE pm.physical_momentum_score IS NOT NULL
      AND ${groupSql.sql}
  `

  const [summary, initialRows, strongRows, weakRows, allRows] = await Promise.all([
    execGet<SummaryRow>(
      `
        ${commonLatest}
        SELECT
          latest.date AS date,
          ${aggregateSelect}
        FROM latest
        JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
        LEFT JOIN ticker_universe tu ON tu.ticker = pm.symbol
        WHERE pm.physical_momentum_score IS NOT NULL
          AND ${groupSql.sql}
      `,
      groupSql.params,
    ),
    execAll<StockMomentumRow>(
      `
        ${commonLatest}
        ${rowsSelect}
        ORDER BY pm.physical_force_score DESC, pm.physical_momentum_score DESC, pm.symbol
        LIMIT 12
      `,
      groupSql.params,
    ),
    execAll<StockMomentumRow>(
      `
        ${commonLatest}
        ${rowsSelect}
        ORDER BY pm.physical_momentum_score DESC, pm.physical_force_score DESC, pm.symbol
        LIMIT 12
      `,
      groupSql.params,
    ),
    execAll<StockMomentumRow>(
      `
        ${commonLatest}
        ${rowsSelect}
        ORDER BY pm.physical_momentum_score ASC, pm.physical_force_score ASC, pm.symbol
        LIMIT 12
      `,
      groupSql.params,
    ),
    execAll<StockMomentumRow>(
      `
        ${commonLatest}
        ${rowsSelect}
        ORDER BY pm.physical_force_score DESC, pm.physical_momentum_score DESC, pm.symbol
        LIMIT 500
      `,
      groupSql.params,
    ),
  ])

  return {
    summary,
    initialRows,
    strongRows,
    weakRows,
    allRows,
  }
}

function StageStrip({ row }: { row: StockMomentumRow }) {
  const stages = [
    { label: '日A', value: row.dailyAStage },
    { label: '日B', value: row.dailyBStage },
    { label: '週A', value: row.weeklyAStage },
    { label: '週B', value: row.weeklyBStage },
    { label: '月A', value: row.monthlyAStage },
    { label: '月B', value: row.monthlyBStage },
  ]
  return (
    <div className="flex max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {stages.map((stage) => (
        <span key={stage.label} className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--color-border-soft)] bg-white px-1 py-0.5">
          <span className="text-[8px] font-bold text-[var(--color-text-tertiary)]">{stage.label}</span>
          <StageTag stage={stage.value} size="xs" />
        </span>
      ))}
    </div>
  )
}

function SummaryTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone: 'up' | 'down' | 'warning' | 'neutral'
}) {
  return (
    <div className={`rounded-[8px] border px-3 py-2 ${statusClass(tone)}`}>
      <div className="text-[10px] font-bold opacity-75">{label}</div>
      <div className="mt-1 font-mono text-[22px] font-bold leading-none">{value}</div>
      <div className="mt-2 text-[10px] font-bold opacity-75">{sub}</div>
    </div>
  )
}

function RankingPanel({
  title,
  badge,
  rows,
  scoreKey,
  scoreLabel,
  tone,
}: {
  title: string
  badge: string
  rows: StockMomentumRow[]
  scoreKey: 'pms' | 'pfs' | 'pes'
  scoreLabel: string
  tone: 'up' | 'down' | 'warning'
}) {
  return (
    <section className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-white">
      <div className={`flex items-center justify-between gap-2 border-b px-3 py-2 ${statusClass(tone)}`}>
        <div>
          <h2 className="text-[12px] font-bold">{title}</h2>
          <p className="mt-0.5 text-[10px] font-semibold opacity-75">{badge}</p>
        </div>
        <span className="rounded-full border border-current/25 bg-white/60 px-2 py-0.5 text-[10px] font-bold">
          {rows.length}件
        </span>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)]">
        {rows.map((row, index) => {
          const status = statusFor(row)
          return (
            <div key={`${title}-${row.ticker}`} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
              <div className="font-mono text-[12px] font-bold text-[var(--color-text-tertiary)]">{index + 1}</div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Link href={`/stock/${encodeURIComponent(row.ticker)}`} prefetch={false} className="font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline">
                    {row.ticker}
                  </Link>
                  <span className="truncate text-[11px] font-bold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                  <span className={`rounded-full border px-1.5 py-0.5 ${statusClass(status.tone)}`}>{status.label}</span>
                  <span>{row.sector17Name ?? '業種未分類'}</span>
                  <span>{row.marginType ?? '貸借未設定'}</span>
                </div>
              </div>
              <div className="text-right">
                <div className={`font-mono text-[14px] font-bold ${scoreColor(row[scoreKey])}`}>{fmtScore(row[scoreKey])}</div>
                <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{scoreLabel}</div>
                <div className={`font-mono text-[10px] font-bold ${scoreColor(row.changePct)}`}>{fmtPct(row.changePct)}</div>
              </div>
            </div>
          )
        })}
        {rows.length === 0 && (
          <div className="px-3 py-5 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">対象銘柄がありません</div>
        )}
      </div>
    </section>
  )
}

function StockListTable({ rows }: { rows: StockMomentumRow[] }) {
  return (
    <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-white">
      <div className="border-b border-[var(--color-border-soft)] px-3 py-2">
        <h2 className="text-[13px] font-bold text-[var(--color-brand-900)]">銘柄リスト</h2>
        <p className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          PFS順に最大500件を表示します。PMS算出済み銘柄について、ステージ、貸借、出来高、PMS/PFS/PESを同じ行で確認できます。
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[1080px] w-full border-collapse text-[12px]">
          <thead className="bg-[var(--color-surface-subtle)] text-[10px] text-[var(--color-text-tertiary)]">
            <tr>
              <th className="px-3 py-2 text-left font-bold">銘柄</th>
              <th className="px-3 py-2 text-left font-bold">状態</th>
              <th className="px-3 py-2 text-left font-bold">業種</th>
              <th className="px-3 py-2 text-left font-bold">貸借</th>
              <th className="px-3 py-2 text-right font-bold">価格</th>
              <th className="px-3 py-2 text-right font-bold">日次</th>
              <th className="px-3 py-2 text-right font-bold">出来高</th>
              <th className="px-3 py-2 text-right font-bold">PMS</th>
              <th className="px-3 py-2 text-right font-bold">PFS</th>
              <th className="px-3 py-2 text-right font-bold">PES</th>
              <th className="px-3 py-2 text-left font-bold">6ステージ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {rows.map((row) => {
              const status = statusFor(row)
              return (
                <tr key={row.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link href={`/stock/${encodeURIComponent(row.ticker)}`} prefetch={false} className="font-mono font-bold text-[var(--color-brand-800)] hover:underline">
                        {row.ticker}
                      </Link>
                      <span className="max-w-[180px] truncate font-bold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{row.marketSegment ?? '市場未分類'}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusClass(status.tone)}`}>{status.label}</span>
                  </td>
                  <td className="px-3 py-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                    <div>{row.sector17Name ?? '---'}</div>
                    <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">{row.sector33Name ?? ''}</div>
                  </td>
                  <td className="px-3 py-2 text-[11px] font-bold text-[var(--color-text-secondary)]">{row.marginType ?? '---'}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold">{fmtPrice(row.price)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.changePct)}`}>{fmtPct(row.changePct)}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold text-[var(--color-text-secondary)]">{fmtVolume(row.volume)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.pms)}`}>{fmtScore(row.pms)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.pfs)}`}>{fmtScore(row.pfs)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${scoreColor(row.pes)}`}>{fmtScore(row.pes)}</td>
                  <td className="px-3 py-2"><StageStrip row={row} /></td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">
                  対象銘柄がありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GroupTabs({ active }: { active: MarketMomentumGroupId }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {MARKET_MOMENTUM_GROUP_ORDER.filter((id) => id !== 'unclassified').map((id) => {
        const group = MARKET_MOMENTUM_GROUPS[id]
        const selected = id === active
        return (
          <Link
            key={id}
            href={marketMomentumHref(id)}
            prefetch={false}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-bold ${
              selected
                ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] text-[var(--color-brand-900)]'
                : 'border-[var(--color-border-soft)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            {group.shortLabel}
          </Link>
        )
      })}
    </div>
  )
}

export default async function MarketMomentumPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string | string[] }>
}) {
  const sp = await searchParams
  const groupId = parseMarketMomentumGroup(sp.group)
  const group = MARKET_MOMENTUM_GROUPS[groupId]
  const { summary, initialRows, strongRows, weakRows, allRows } = await getMarketMomentumData(groupId)
  const count = Number(summary?.count ?? 0)
  const pmsPlus = ratio(summary?.positivePms ?? 0, count)
  const pfsPlus = ratio(summary?.positivePfs ?? 0, count)
  const strong = ratio(summary?.strongPms ?? 0, count)
  const weak = ratio(summary?.weakPms ?? 0, count)

  return (
    <div className="mx-auto flex w-full max-w-[1420px] flex-col gap-4">
      <PageTitle
        title={`${group.label} モメンタム詳細`}
        subtitle={`${summary?.date ?? '---'} 大引け基準 / ${group.description}`}
        badge={`${count.toLocaleString('ja-JP')}銘柄（PMS算出済み）`}
        rightSlot={
          <Link href="/" className="rounded-[3px] border border-[var(--color-border-default)] bg-white px-2.5 py-1 text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
            ダッシュボードへ
          </Link>
        }
      />

      <GroupTabs active={groupId} />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryTile label="PMSプラス" value={fmtRatio(pmsPlus)} sub={`${(summary?.positivePms ?? 0).toLocaleString('ja-JP')} / ${count.toLocaleString('ja-JP')}銘柄`} tone="up" />
        <SummaryTile label="初動プラス" value={fmtRatio(pfsPlus)} sub="PFSが0を上回る銘柄比率" tone="warning" />
        <SummaryTile label="強い勢い" value={fmtRatio(strong)} sub={`PMS +1以上: ${(summary?.strongPms ?? 0).toLocaleString('ja-JP')}銘柄`} tone="up" />
        <SummaryTile label="弱い/失速" value={fmtRatio(weak)} sub={`PMS -1以下: ${(summary?.weakPms ?? 0).toLocaleString('ja-JP')}銘柄`} tone="down" />
      </div>

      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
            初動はPFS、勢いはPMS、値動きの熱量はPESで見ます。ここでは投資判断を確定するのではなく、次にチャートで確認すべき銘柄を絞り込むための一覧として使います。
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={screenerHrefForMarketMomentumGroup(groupId, { sort: 'physicalForceScore', dir: 'desc', pfsMin: 0 })} prefetch={false} className="rounded-full border border-[var(--color-border-soft)] bg-white px-2.5 py-1 text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
              スクリーナーで開く
            </Link>
            <Link href="/hex-stage" prefetch={false} className="rounded-full border border-[var(--color-border-soft)] bg-white px-2.5 py-1 text-[10px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
              HEXで見る
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <RankingPanel
          title="初動あり"
          badge="PFS順: 力が出始めている候補"
          rows={initialRows}
          scoreKey="pfs"
          scoreLabel="PFS"
          tone="warning"
        />
        <RankingPanel
          title="強い勢い"
          badge="PMS順: 既に勢いが強い候補"
          rows={strongRows}
          scoreKey="pms"
          scoreLabel="PMS"
          tone="up"
        />
        <RankingPanel
          title="弱い/失速"
          badge="PMS逆順: 弱含み・警戒候補"
          rows={weakRows}
          scoreKey="pms"
          scoreLabel="PMS"
          tone="down"
        />
      </div>

      <StockListTable rows={allRows} />
    </div>
  )
}
