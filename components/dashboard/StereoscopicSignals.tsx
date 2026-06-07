// components/dashboard/StereoscopicSignals.tsx
// 6軸ステージ一致シグナルを、価格・出来高・複数期間中央値込みで表示する。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { IndustryBadges } from '@/components/ui/IndustryBadges'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'
import { getCachedStereoscopicSignals } from '@/lib/queries/dashboard-cache'
import {
  addUniverseToHref,
  filterRowsByUniverse,
  getUniverseFilterMeta,
  type UniverseFilterValue,
} from '@/lib/market-universe'

function fmtPct(v: number | null) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function fmtPrice(v: number | null) {
  if (v == null) return '---'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function tone(v: number | null) {
  if (v == null) return 'text-[var(--color-text-tertiary)]'
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : 'text-[var(--color-text-secondary)]'
}

function stockHref(ticker: string) {
  return `/stock/${encodeURIComponent(ticker)}`
}

export async function StereoscopicSignals({
  date,
  universe = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
}) {
  const rawRows = await getCachedStereoscopicSignals(date)
  const rows = filterRowsByUniverse(rawRows, universe)
  const universeMeta = getUniverseFilterMeta(universe)
  return (
    <Card>
      <CardHeader
        title="立体的類似シグナル"
        hint={`${universeMeta ? `${universeMeta.shortLabel} / ` : ''}6軸ステージ一致 / N≧40 / 30日中央値順`}
        action={<Link href={addUniverseToHref('/ai/transitions', universe)} className="hover:text-[var(--color-text-secondary)]">分析へ ↗</Link>}
      />
      <div className="mb-4 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 text-[12px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
        <p>
          6軸ステージ一致は、日足A・日足B・週足A・週足B・月足A・月足Bの6つのステージを
          <span className="mx-1 font-mono font-bold text-[var(--color-brand-800)]">112334</span>
          のような1つの組み合わせとして見ます。N≧40は、過去に同じ組み合わせが40件以上あり、統計として最低限の件数があるという意味です。
          30日中央値順は、その組み合わせが出た後の30営業日リターンの中央値が高い順に並べています。
        </p>
        <p className="mt-2">
          現在の銘柄が、過去に上がりやすかったステージ構成へ入っているかを素早く確認するための入口です。
          候補銘柄を拾った後は、個別ページで移動平均線、出来高、直近高値との距離を確認すると使いやすくなります。
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">該当銘柄なし</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1260px] text-[13px]">
            <thead>
              <tr className="text-left text-[11px] font-bold text-[var(--color-text-tertiary)]">
                <th className="pb-3 pl-2 pr-3">銘柄</th>
                <th className="pb-3 pr-3">貸借/信用</th>
                <th className="pb-3 pr-3">J-Quants業種</th>
                <th className="pb-3 pr-3 text-right">株価</th>
                <th className="pb-3 pr-3 text-right">前日比</th>
                <th className="pb-3 pr-3 text-right">出来高比</th>
                <th className="pb-3 pr-3">Stage</th>
                <th className="pb-3 pr-3 text-right">N</th>
                <th className="pb-3 pr-3 text-right">30日</th>
                <th className="pb-3 pr-3 text-right">60日</th>
                <th className="pb-3 pr-2 text-right">90日</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map((row) => (
                <tr key={row.ticker} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="py-3 pl-2 pr-3">
                    <Link
                      href={stockHref(row.ticker)}
                      prefetch={false}
                      className="block max-w-[230px] rounded-[4px] px-1 py-0.5 hover:bg-white hover:shadow-sm"
                      aria-label={`${row.ticker} ${row.name ?? ''} の個別銘柄ページへ移動`}
                    >
                      <span className="block font-bold tabular-nums text-[var(--color-brand-800)] hover:underline">
                        {row.ticker}
                      </span>
                      <span className="mt-1 block truncate text-[12px] font-semibold text-[var(--color-text-primary)]">
                        {row.name ?? row.ticker}
                      </span>
                    </Link>
                  </td>
                  <td className="py-3 pr-3">
                    <MarginBadges
                      marginType={row.marginType}
                      creditRatio={row.creditRatio}
                      shortRatio={row.shortRatio}
                      compact
                    />
                  </td>
                  <td className="py-3 pr-3">
                    <IndustryBadges
                      sector17={row.sector17Name}
                      sector33={row.sector33Name ?? row.sectorName}
                      marketSegment={row.marketSegment}
                      compact
                    />
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums font-semibold">{fmtPrice(row.price)}</td>
                  <td className={`py-3 pr-3 text-right tabular-nums font-semibold ${tone(row.changePct)}`}>{fmtPct(row.changePct)}</td>
                  <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{row.volumeRatio30 == null ? '---' : row.volumeRatio30.toFixed(1) + 'x'}</td>
                  <td className="py-3 pr-3">
                    <div className="flex items-center gap-1">
                      <StageTag stage={row.daily_a_stage} size="xs" />
                      <StageTag stage={row.daily_b_stage} size="xs" />
                      <StageTag stage={row.weekly_a_stage} size="xs" />
                      <StageTag stage={row.weekly_b_stage} size="xs" />
                      <StageTag stage={row.monthly_a_stage} size="xs" />
                      <StageTag stage={row.monthly_b_stage} size="xs" />
                    </div>
                  </td>
                  <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{row.patternCount.toLocaleString()}</td>
                  <td className={`py-3 pr-3 text-right tabular-nums font-bold ${tone(row.p50_30d)}`}>{fmtPct(row.p50_30d)}</td>
                  <td className={`py-3 pr-3 text-right tabular-nums font-semibold ${tone(row.p50_60d)}`}>{fmtPct(row.p50_60d)}</td>
                  <td className={`py-3 pr-2 text-right tabular-nums font-semibold ${tone(row.p50_90d)}`}>{fmtPct(row.p50_90d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
