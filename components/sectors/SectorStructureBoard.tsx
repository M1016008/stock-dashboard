import Link from 'next/link'
import { ArrowDownRight, ArrowUpRight, ExternalLink, Minus } from 'lucide-react'
import { SECTOR_STRUCTURE_AXES, type SectorStructureTaxonomy } from '@/lib/sector-structure'
import type { SectorStructureBoard as SectorStructureBoardData, SectorStructureRow } from '@/lib/queries/sectors'
import { StageTag } from '@/components/ui/StageTag'

const TAXONOMY_TABS: Array<{ key: SectorStructureTaxonomy; label: string }> = [
  { key: 'major', label: '四季報60分類' },
  { key: 'subIndustry', label: '業種細分類' },
  { key: '17', label: '17業種' },
  { key: '33', label: '33業種' },
]

function buildHref(taxonomy: SectorStructureTaxonomy) {
  return `/sectors?view=structure&structureTaxonomy=${encodeURIComponent(taxonomy)}#sector-structure`
}

function fmt(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(digits)
}

function tone(value: number | null | undefined) {
  if ((value ?? 0) > 0) return 'text-[var(--color-price-up)]'
  if ((value ?? 0) < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function MomentumMark({ value }: { value: number | null | undefined }) {
  if ((value ?? 0) > 0) return <ArrowUpRight size={14} aria-label="改善" />
  if ((value ?? 0) < 0) return <ArrowDownRight size={14} aria-label="悪化" />
  return <Minus size={14} aria-label="中立" />
}

function stageTone(stage: number) {
  if (stage === 1 || stage === 6) return 'bg-[rgba(220,38,38,0.12)]'
  if (stage === 3 || stage === 4) return 'bg-[rgba(37,99,235,0.12)]'
  return 'bg-[var(--color-surface-subtle)]'
}

function ConstituentHref({ row }: { row: SectorStructureRow }) {
  const params = new URLSearchParams()
  if (row.taxonomy === '17') params.set('sector17', row.groupName)
  if (row.taxonomy === '33') params.set('sector33', row.groupName)
  if (row.taxonomy === 'major') params.set('majorCategory', row.groupName)
  if (row.taxonomy === 'subIndustry') {
    params.set('majorCategory', row.parentGroup ?? '')
    params.set('subIndustry', row.groupName)
  }
  return (
    <Link
      href={`/screener?${params.toString()}`}
      className="inline-flex items-center gap-1 font-bold text-[var(--color-brand-800)] hover:text-[var(--color-market-red)]"
      prefetch={false}
    >
      {row.groupName}<ExternalLink size={12} />
    </Link>
  )
}

function StageComposition({ row }: { row: SectorStructureRow }) {
  return (
    <div className="grid min-w-[660px] grid-cols-6 gap-2">
      {SECTOR_STRUCTURE_AXES.map((axis) => {
        const summary = row.axes?.[axis.key]
        if (!summary) return null
        return (
          <div key={axis.key} className="rounded-[6px] border border-[var(--color-border-soft)] bg-white px-2 py-2">
            <div className="flex items-center justify-between gap-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
              <span>{axis.label}</span>
              <span className={tone(summary.changeScore)}>{summary.changeScore > 0 ? '+' : ''}{fmt(summary.changeScore)}</span>
            </div>
            <div className="mt-1 flex gap-0.5">
              {[1, 2, 3, 4, 5, 6].map((stage) => (
                <span
                  key={stage}
                  className={`flex min-w-0 flex-1 flex-col items-center rounded-[3px] px-0.5 py-1 ${stageTone(stage)}`}
                  title={`Stage ${stage}: ${summary.stages[stage as 1 | 2 | 3 | 4 | 5 | 6]}銘柄`}
                >
                  <StageTag stage={stage} size="xs" />
                  <span className="mt-0.5 text-[9px] font-bold tabular-nums text-[var(--color-text-secondary)]">{summary.stages[stage as 1 | 2 | 3 | 4 | 5 | 6]}</span>
                </span>
              ))}
            </div>
            <div className="mt-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]">
              改 {summary.improving} / 悪 {summary.deteriorating} / 維 {summary.stable}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RankingBlock({
  title,
  rows,
  toneClass,
  metric = 'momentum',
}: {
  title: string
  rows: SectorStructureRow[]
  toneClass: string
  metric?: 'strength' | 'momentum'
}) {
  return (
    <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-white">
      <div className="border-b border-[var(--color-border-soft)] px-3 py-2">
        <h3 className={`text-[13px] font-bold ${toneClass}`}>{title}</h3>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)]">
        {rows.map((row, index) => (
          <div key={row.groupKey} className="flex items-center gap-2 px-3 py-2 text-[12px]">
            <span className="w-4 text-[10px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate"><ConstituentHref row={row} /></span>
            <span className={`inline-flex items-center gap-0.5 font-bold tabular-nums ${metric === 'strength' ? 'text-[var(--color-brand-900)]' : tone(row.momentum10d)}`}>
              {metric === 'momentum' && <MomentumMark value={row.momentum10d} />}
              {metric === 'momentum' && row.momentum10d && row.momentum10d > 0 ? '+' : ''}
              {fmt(metric === 'strength' ? row.strengthScore : row.momentum10d)}
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="px-3 py-4 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">該当なし</div>}
      </div>
    </div>
  )
}

export function SectorStructureBoard({ board }: { board: SectorStructureBoardData }) {
  const strongest = [...board.rows].sort((a, b) => (b.strengthScore ?? -Infinity) - (a.strengthScore ?? -Infinity)).slice(0, 8)
  const improving = [...board.rows].filter((row) => (row.momentum10d ?? 0) > 0).slice(0, 8)
  const deteriorating = [...board.rows].filter((row) => (row.momentum10d ?? 0) < 0).sort((a, b) => (a.momentum10d ?? 0) - (b.momentum10d ?? 0)).slice(0, 8)
  const earlyImproving = improving.filter((row) => (row.strengthScore ?? 100) < 60).slice(0, 8)
  const detailRows = [...board.rows]
    .sort((a, b) => Math.abs(b.momentum10d ?? 0) - Math.abs(a.momentum10d ?? 0))
    .slice(0, 24)

  return (
    <section id="sector-structure" className="space-y-4">
      <div className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
        <div className="border-l-4 border-[var(--color-market-red)] pl-2">
          <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">業種内部の6ステージ構造</h2>
          <p className="mt-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            株価の平均ではなく、構成銘柄のステージ比率と遷移を集約します。強度は現在のMA構造、10日変化は改善・悪化遷移の累積です。
          </p>
          <p className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
            基準日: {board.latestDate ?? '---'} / 改善経路 4→5→6→1 / 悪化経路 1→2→3→4
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {TAXONOMY_TABS.map((tab) => (
            <Link
              key={tab.key}
              href={buildHref(tab.key)}
              prefetch={false}
              className={`inline-flex h-8 items-center rounded-full border px-3 text-[11px] font-bold ${
                board.taxonomy === tab.key
                  ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white'
                  : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-300)]'
              }`}
            >
              {tab.label}
            </Link>
          ))}
          <Link href="/sectors" prefetch={false} className="ml-auto inline-flex h-8 items-center rounded-full border border-[var(--color-border-default)] px-3 text-[11px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]">
            騰落率へ戻る
          </Link>
        </div>
      </div>

      {board.rows.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-8 text-center text-[13px] font-semibold text-[var(--color-text-tertiary)]">
          構造集計がまだありません。日次更新後に自動作成されます。
        </div>
      ) : (
        <>
          <div className="grid gap-3 xl:grid-cols-4">
            <RankingBlock title="現在の構造強度" rows={strongest} toneClass="text-[var(--color-brand-900)]" metric="strength" />
            <RankingBlock title="構造改善（10日）" rows={improving} toneClass="text-[var(--color-price-up)]" />
            <RankingBlock title="弱いが改善初動" rows={earlyImproving} toneClass="text-[var(--color-market-amber)]" />
            <RankingBlock title="構造悪化（10日）" rows={deteriorating} toneClass="text-[var(--color-price-down)]" />
          </div>

          <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
            <div className="border-b border-[var(--color-border-soft)] px-4 py-3">
              <h3 className="text-[14px] font-bold text-[var(--color-brand-900)]">構造変化ランキング</h3>
              <p className="mt-0.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">下部の「構成比の詳細」で、日Aから月BまでのStage構成比と遷移内訳を確認できます。</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-[12px]">
                <thead className="text-left text-[10px] font-bold text-[var(--color-text-tertiary)]">
                  <tr>
                    <th className="px-3 py-2">グループ</th>
                    <th className="px-3 py-2 text-right">銘柄数</th>
                    <th className="px-3 py-2 text-right">構造強度</th>
                    <th className="px-3 py-2 text-right">変化 5日</th>
                    <th className="px-3 py-2 text-right">変化 10日</th>
                    <th className="px-3 py-2">構造波及フェーズ</th>
                    <th className="px-3 py-2 text-right">改善 / 悪化</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-soft)]">
                  {board.rows.map((row) => (
                    <tr key={row.groupKey} className="hover:bg-[var(--color-surface-subtle)]">
                      <td className="px-3 py-2.5 font-semibold"><ConstituentHref row={row} />{row.parentGroup && <span className="ml-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{row.parentGroup}</span>}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-text-secondary)]">{row.nStocks}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums text-[var(--color-brand-900)]">{fmt(row.strengthScore)}</td>
                      <td className={`px-3 py-2.5 text-right font-bold tabular-nums ${tone(row.momentum5d)}`}>{row.momentum5d && row.momentum5d > 0 ? '+' : ''}{fmt(row.momentum5d)}</td>
                      <td className={`px-3 py-2.5 text-right font-bold tabular-nums ${tone(row.momentum10d)}`}>{row.momentum10d && row.momentum10d > 0 ? '+' : ''}{fmt(row.momentum10d)}</td>
                      <td className={`px-3 py-2.5 text-[11px] font-bold ${row.propagationDirection === 'improving' ? 'text-[var(--color-price-up)]' : row.propagationDirection === 'deteriorating' ? 'text-[var(--color-price-down)]' : 'text-[var(--color-text-secondary)]'}`}>{row.propagationLabel}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-text-secondary)]">{row.improvingCount} / {row.deterioratingCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[var(--color-border-soft)] px-4 py-3">
              <details>
                <summary className="cursor-pointer text-[12px] font-bold text-[var(--color-brand-800)]">構成比の詳細を確認</summary>
                <div className="mt-3 space-y-3 overflow-x-auto">
                  {detailRows.filter((row) => row.axes).map((row) => (
                    <div key={`detail-${row.groupKey}`} className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
                      <div className="mb-2 flex items-center justify-between gap-3 text-[12px]">
                        <ConstituentHref row={row} />
                        <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">有効ステージ {row.validStageCount}</span>
                      </div>
                      <StageComposition row={row} />
                    </div>
                  ))}
                </div>
                {board.rows.length > detailRows.length && (
                  <p className="mt-3 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                    詳細構成比は直近の構造変化が大きい上位{detailRows.length}グループを表示しています。全グループは上のランキングからスクリーナーへ移動して確認できます。
                  </p>
                )}
              </details>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
