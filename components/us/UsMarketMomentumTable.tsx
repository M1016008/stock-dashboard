// components/us/UsMarketMomentumTable.tsx
//
// 選択レーンの上位銘柄を 1 表で比較する。
// - lg 以上: 表。1W / 1M / 出来高は xl 以上で列を足す (iPad 横でも横スクロールなしで主要列を読む)
// - lg 未満: 2 段のリスト (銘柄・価格 → 6ステージ・PMS/PFS/PES)
// - 取引所・SEC sector は showClassification (最新日) のときだけ出す

import Link from 'next/link'
import type { UsMarketMomentumRow } from '@/lib/server/us-market-intelligence'
import {
  StageStrip,
  fmtPct,
  fmtScore,
  fmtUsd,
  fmtVolume,
  secSectorShort,
  signedClass,
  usStockHref,
} from '@/components/us/UsMarketMomentumParts'

function classificationLine(row: UsMarketMomentumRow): string | null {
  const parts = [row.exchange, row.sectorCode ? secSectorShort(row.sectorCode, row.sector) : null].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function UsMarketMomentumTable({
  rows,
  linkDate,
  showClassification,
  emptyLabel,
}: {
  rows: UsMarketMomentumRow[]
  linkDate: string | null
  showClassification: boolean
  emptyLabel: string
}) {
  return (
    <>
      <div className="panel hidden lg:block">
        <div className="table-scroll">
          <table className="w-full min-w-[760px] border-collapse text-[12px] xl:min-w-[1080px]">
            <thead className="text-[11px]">
              <tr>
                <th className="w-9 py-2 pl-3 pr-1 text-right font-bold">#</th>
                <th className="px-3 py-2 text-left font-bold">Ticker</th>
                {showClassification && <th className="hidden px-2 py-2 text-left font-bold xl:table-cell">Exchange · SEC sector</th>}
                <th className="px-2 py-2 text-right font-bold">Price (USD)</th>
                <th className="px-2 py-2 text-right font-bold">1D</th>
                <th className="hidden px-2 py-2 text-right font-bold xl:table-cell">1W</th>
                <th className="hidden px-2 py-2 text-right font-bold xl:table-cell">1M</th>
                <th className="hidden px-2 py-2 text-right font-bold xl:table-cell">Volume</th>
                <th className="px-2 py-2 text-right font-bold">PMS</th>
                <th className="px-2 py-2 text-right font-bold">PFS</th>
                <th className="px-2 py-2 text-right font-bold">PES</th>
                <th className="px-3 py-2 text-left font-bold">6ステージ <span className="font-normal text-[var(--color-text-tertiary)]">日A–月B</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map((row, index) => {
                const classification = showClassification ? classificationLine(row) : null
                return (
                  <tr key={row.ticker} className="hover:bg-[#fff8e6]">
                    <td className="py-1.5 pl-3 pr-1 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <Link href={usStockHref(row.ticker, linkDate)} prefetch={false} className="shrink-0 font-mono font-bold text-[var(--color-brand-700)] hover:underline">
                          {row.ticker}
                        </Link>
                        <span className="max-w-[220px] truncate font-semibold text-[var(--color-text-primary)]" title={row.name ?? undefined}>{row.name ?? ''}</span>
                      </div>
                      {classification && <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-tertiary)] xl:hidden">{classification}</div>}
                    </td>
                    {showClassification && (
                      <td className="hidden max-w-[200px] truncate px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] xl:table-cell" title={[row.exchange, row.sector].filter(Boolean).join(' · ')}>
                        {classification ?? <span className="text-[var(--color-text-tertiary)]">未分類</span>}
                      </td>
                    )}
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtUsd(row.price)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono font-bold tabular-nums ${signedClass(row.changePct)}`}>{fmtPct(row.changePct)}</td>
                    <td className={`hidden px-2 py-1.5 text-right font-mono tabular-nums xl:table-cell ${signedClass(row.return1w)}`}>{fmtPct(row.return1w)}</td>
                    <td className={`hidden px-2 py-1.5 text-right font-mono tabular-nums xl:table-cell ${signedClass(row.return1m)}`}>{fmtPct(row.return1m)}</td>
                    <td className="hidden px-2 py-1.5 text-right font-mono tabular-nums text-[var(--color-text-secondary)] xl:table-cell">{fmtVolume(row.volume)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono font-bold tabular-nums ${signedClass(row.pms)}`}>{fmtScore(row.pms)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono font-bold tabular-nums ${signedClass(row.pfs)}`}>{fmtScore(row.pfs)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${signedClass(row.pes)}`}>{fmtScore(row.pes)}</td>
                    <td className="px-3 py-1.5"><StageStrip row={row} /></td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">{emptyLabel}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ol className="panel m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 lg:hidden" aria-label="銘柄一覧">
        {rows.map((row, index) => {
          const classification = showClassification ? classificationLine(row) : null
          return (
            <li key={row.ticker} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 px-3 py-2">
              <span className="pt-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
              <div className="min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <Link href={usStockHref(row.ticker, linkDate)} prefetch={false} className="shrink-0 font-mono text-[13px] font-bold text-[var(--color-brand-700)]">
                        {row.ticker}
                      </Link>
                      <span className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{row.name ?? ''}</span>
                    </div>
                    {classification && <div className="truncate text-[10px] text-[var(--color-text-tertiary)]">{classification}</div>}
                  </div>
                  <div className="shrink-0 text-right font-mono tabular-nums">
                    <div className="text-[12px]">{fmtUsd(row.price)}</div>
                    <div className={`text-[12px] font-bold ${signedClass(row.changePct)}`}>{fmtPct(row.changePct)}</div>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
                  <StageStrip row={row} />
                  <span className={signedClass(row.pms)}>PMS {fmtScore(row.pms)}</span>
                  <span className={signedClass(row.pfs)}>PFS {fmtScore(row.pfs)}</span>
                  <span className={signedClass(row.pes)}>PES {fmtScore(row.pes)}</span>
                  <span className="text-[var(--color-text-tertiary)]">Vol {fmtVolume(row.volume)}</span>
                </div>
              </div>
            </li>
          )
        })}
        {rows.length === 0 && (
          <li className="px-3 py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">{emptyLabel}</li>
        )}
      </ol>
    </>
  )
}
