import type { Metadata } from 'next'
import { getSectorAnalysisBoard, type SectorHeatmapRow, type SectorPeriodSummary } from '@/lib/queries/sectors'
import { getMlSectorRankings, type MlSectorRanking } from '@/lib/queries/ml-insights'

export const metadata: Metadata = {
  title: '業種分析 — StockBoard',
  description: 'J-Quants 17業種・33業種で本日、今週、今月の強弱を確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function colorFor(pct: number): { bg: string; text: string; border: string } {
  const intensity = Math.min(0.34, Math.max(0.05, Math.abs(pct) / 3 * 0.30))
  if (pct > 0) {
    return {
      bg: `rgba(220,38,38,${intensity})`,
      text: 'var(--color-price-up)',
      border: 'rgba(220,38,38,0.18)',
    }
  }
  if (pct < 0) {
    return {
      bg: `rgba(37,99,235,${intensity})`,
      text: 'var(--color-price-down)',
      border: 'rgba(37,99,235,0.18)',
    }
  }
  return {
    bg: 'var(--color-surface-muted)',
    text: 'var(--color-text-secondary)',
    border: 'var(--color-border-soft)',
  }
}

function directionLabel(direction: 'up' | 'down') {
  return direction === 'up' ? '上昇候補' : '下落警戒'
}

function MlSectorRankingBoard({ rows }: { rows: MlSectorRanking[] }) {
  const top17 = rows.filter((row) => row.sectorType === '17').slice(0, 8)
  const top33 = rows.filter((row) => row.sectorType === '33').slice(0, 8)
  const blocks = [
    { title: '17業種 ML候補集中', rows: top17 },
    { title: '33業種 ML候補集中', rows: top33 },
  ]
  return (
    <section className="rounded-[10px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 border-b-2 border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="border-l-4 border-[var(--color-market-red)] pl-2">
          <h2 className="text-[14px] font-bold text-[var(--color-brand-900)]">ML業種候補ランキング</h2>
          <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            最新の6ステージ・MA形状モデルで、上昇候補/下落警戒がどの業種に集まっているかを確認します。
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {blocks.map((block) => (
          <div key={block.title} className="rounded-[8px] border border-[var(--color-border-soft)]">
            <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[13px] font-bold text-[var(--color-text-primary)]">
              {block.title}
            </div>
            <div className="divide-y divide-[var(--color-border-soft)]">
              {block.rows.map((row, index) => (
                <div key={`${row.sectorType}-${row.direction}-${row.sectorName}`} className="grid grid-cols-[36px_1fr_auto] items-center gap-2 px-3 py-2 text-[12px]">
                  <span className="font-bold tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate font-bold text-[var(--color-text-primary)]">{row.sectorName}</div>
                    <div className="mt-0.5 truncate text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                      {directionLabel(row.direction)} / {row.representativeTickers.slice(0, 4).map((item) => item.ticker).join(', ') || '代表銘柄なし'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular-nums text-[var(--color-brand-900)]">{row.candidateCount}件</div>
                    <div className="text-[10px] font-bold tabular-nums text-[var(--color-text-tertiary)]">
                      {row.avgScore == null ? '-' : `${Math.round(row.avgScore * 100)}%`}
                    </div>
                  </div>
                </div>
              ))}
              {block.rows.length === 0 && (
                <div className="px-3 py-4 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">
                  ML業種ランキングは未作成です
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function HeatmapGrid({
  rows,
  classification,
}: {
  rows: SectorHeatmapRow[]
  classification: '17' | '33'
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-8 text-center text-[13px] font-semibold text-[var(--color-text-tertiary)]">
        {classification}業種データなし
      </div>
    )
  }
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${classification === '17' ? 'lg:grid-cols-5 xl:grid-cols-6' : 'lg:grid-cols-6 xl:grid-cols-8'}`}>
      {rows.map((row) => {
        const c = colorFor(row.avg_change ?? 0)
        return (
          <div
            key={`${classification}-${row.sector_code ?? row.sector_name}`}
            className="flex min-h-[76px] flex-col justify-between rounded-[8px] border px-3 py-3"
            style={{ backgroundColor: c.bg, borderColor: c.border }}
          >
            <div className="line-clamp-2 text-[12px] font-bold leading-snug text-[var(--color-text-primary)]">
              {row.sector_name}
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <span className="text-[10px] font-bold text-[var(--color-text-tertiary)] tabular-nums">
                {row.n_stocks.toLocaleString()}銘柄
              </span>
              <span className="text-[16px] font-bold tabular-nums" style={{ color: c.text }}>
                {fmtPct(row.avg_change)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RankingTable({
  title,
  rows,
  compact = false,
}: {
  title: string
  rows: SectorHeatmapRow[]
  compact?: boolean
}) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-white">
      <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-3 py-2">
        <h3 className="text-[13px] font-bold text-[var(--color-text-primary)]">{title}</h3>
        <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">
          {rows.length.toLocaleString()}件
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12px]">
          <thead>
            <tr className="text-left text-[10px] font-bold text-[var(--color-text-tertiary)]">
              <th className="py-2 pl-3 pr-2">順位</th>
              <th className="py-2 pr-2">業種</th>
              <th className="py-2 pr-2 text-right">騰落率</th>
              <th className="py-2 pr-2 text-right">銘柄数</th>
              <th className="py-2 pr-3 text-right">上昇/下落</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {rows.map((row, index) => {
              const tone = row.avg_change > 0 ? 'text-[var(--color-price-up)]' : row.avg_change < 0 ? 'text-[var(--color-price-down)]' : 'text-[var(--color-text-secondary)]'
              return (
                <tr key={`${title}-${row.sector_code ?? row.sector_name}`}>
                  <td className="py-2 pl-3 pr-2 text-[var(--color-text-tertiary)] tabular-nums">
                    {index + 1}
                  </td>
                  <td className="max-w-[260px] truncate py-2 pr-2 font-bold text-[var(--color-text-primary)]">
                    {row.sector_name}
                  </td>
                  <td className={`py-2 pr-2 text-right font-bold tabular-nums ${tone}`}>
                    {fmtPct(row.avg_change)}
                  </td>
                  <td className="py-2 pr-2 text-right text-[var(--color-text-secondary)] tabular-nums">
                    {row.n_stocks.toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-right text-[var(--color-text-secondary)] tabular-nums">
                    {row.advancing_count.toLocaleString()} / {row.declining_count.toLocaleString()}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-[var(--color-text-tertiary)]">
                  データなし
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {compact && (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          上昇/下落は、対象期間でプラスだった銘柄数 / マイナスだった銘柄数です。
        </div>
      )}
    </div>
  )
}

function ClassificationPeriodCard({
  period,
  classification,
  rows,
}: {
  period: SectorPeriodSummary
  classification: '17' | '33'
  rows: SectorHeatmapRow[]
}) {
  const sorted = [...rows].sort((a, b) => b.avg_change - a.avg_change)
  const top10 = sorted.slice(0, 10)
  const bottom10 = [...sorted].reverse().slice(0, 10)
  return (
    <section className="rounded-[10px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b-2 border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="min-w-0 border-l-4 border-[var(--color-market-red)] pl-2">
          <h2 className="text-[14px] font-bold text-[var(--color-brand-900)]">
            {classification}業種・{period.label}ヒートマップ
          </h2>
          <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {period.description} / {period.baseDate} → {period.latestDate}
          </p>
        </div>
        <span className="rounded-full border border-[var(--color-border-default)] bg-white px-2.5 py-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          {rows.length.toLocaleString()} 業種
        </span>
      </div>

      <HeatmapGrid rows={sorted} classification={classification} />

      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
        <RankingTable title="上昇トップ10" rows={top10} compact />
        <RankingTable title="下落トップ10" rows={bottom10} compact />
      </div>

      <details className="mt-4 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
        <summary className="cursor-pointer px-3 py-2 text-[12px] font-bold text-[var(--color-brand-800)]">
          全件ランキングを表示
        </summary>
        <div className="p-3">
          <RankingTable title={`${classification}業種 全件ランキング`} rows={sorted} />
        </div>
      </details>
    </section>
  )
}

function ClassificationSection({
  title,
  description,
  classification,
  periods,
}: {
  title: string
  description: string
  classification: '17' | '33'
  periods: SectorPeriodSummary[]
}) {
  return (
    <div className="space-y-4">
      <div className="sb-page-title">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-4">
        {periods.map((period) => (
          <ClassificationPeriodCard
            key={`${classification}-${period.period}`}
            period={period}
            classification={classification}
            rows={classification === '17' ? period.rows17 : period.rows33}
          />
        ))}
      </div>
    </div>
  )
}

export default async function SectorsPage() {
  const [board, mlRankingData] = await Promise.all([
    getSectorAnalysisBoard(),
    getMlSectorRankings({ limit: 40 }),
  ])
  const latestDate = board.latestDate

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>業種分析（17業種・33業種）</h1>
        <p>
          J-Quantsの17業種分類・33業種分類を使い、本日・今週・今月の業種別の強弱を一覧で確認できます。
        </p>
      </div>

      <div className="sb-section" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span className="sb-tab sb-on">17業種</span>
        <span className="sb-tab sb-on">33業種</span>
        <span className="sb-tab sb-on">本日</span>
        <span className="sb-tab sb-on">今週</span>
        <span className="sb-tab sb-on">今月</span>
        <span className="sb-t" style={{ marginLeft: 'auto', fontSize: 11 }}>
          基準日: {latestDate ?? '---'}
        </span>
      </div>

      {board.periods.length === 0 ? (
        <div className="sb-section" style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', fontWeight: 700 }}>
          業種データがありません。J-Quantsの上場銘柄情報と株価データを取得してください。
        </div>
      ) : (
        <div className="space-y-7">
          <MlSectorRankingBoard rows={mlRankingData.rows} />
          <ClassificationSection
            title="17業種ヒートマップ・ランキング"
            description="市場全体を17業種にまとめ、本日・今週・今月の大きな資金の向きを確認します。"
            classification="17"
            periods={board.periods}
          />
          <ClassificationSection
            title="33業種ヒートマップ・ランキング"
            description="33業種でより細かく分解し、どの業種が相対的に強いか、弱いかを確認します。"
            classification="33"
            periods={board.periods}
          />
        </div>
      )}
    </div>
  )
}
