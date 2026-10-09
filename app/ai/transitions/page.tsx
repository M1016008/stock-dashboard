// app/ai/transitions/page.tsx
// 過去パターン遷移:
//   - 見出し + パターン検索 (上位パターンから選択)
//   - 選択中パターンの帯: 6 桁コード + 6 ステージタグ + 過去出現
//   - 4 ホライゾンの中央値リターン (StatStrip)
//   - 2 列: リターン分布 (ヒストグラム + 25/中央/75) / 業種別出現分布 (横バー)
//   - 過去のサンプルケース テーブル

import type { Metadata } from 'next'
import Link from 'next/link'
import { PatternSearchMock } from '@/components/ai/PatternSearchMock'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import {
  getDefaultPatternCode,
  getPatternMeta,
  getHorizonStats,
  getTopPatterns,
  getReturnDistribution,
  getSectorBreakdown,
  getSampleCases,
} from '@/lib/queries/transitions'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: '過去パターン遷移 — StockBoard',
  description: '6 タイムスケールの組み合わせから過去の類似ケースを統計的に観察',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const STAGE_LABEL = ['日A', '日B', '週A', '週B', '月A', '月B']

function toneClass(v: number | null): string {
  if (v == null) return ''
  return v > 0 ? 'sb-r' : v < 0 ? 'sb-b' : ''
}
function fmtPct(v: number | null, decimals = 1): string {
  if (v == null) return '—'
  return (v > 0 ? '+' : '') + v.toFixed(decimals)
}

export default async function TransitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; horizon?: string; universe?: string | string[] }>
}) {
  const sp = await searchParams
  const fallback = await getDefaultPatternCode()
  const code = /^\d{6}$/.test(sp.code ?? '') ? sp.code! : (fallback ?? '111111')
  const horizonDays = sp.horizon && /^\d+$/.test(sp.horizon) ? parseInt(sp.horizon, 10) : 60
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)

  const [meta, horizonRows, top, dist, sectors, samples] = await Promise.all([
    getPatternMeta(code),
    getHorizonStats(code),
    getTopPatterns(12),
    getReturnDistribution(code, horizonDays),
    getSectorBreakdown(code, 7, universeFilter),
    getSampleCases(code, 10, universeFilter),
  ])

  const stages = code.split('').map(c => parseInt(c, 10))
  const sectorMax = sectors.reduce((m, s) => Math.max(m, s.count), 0)
  const distMax = dist.bins.reduce((m, b) => Math.max(m, b.count), 0)

  const tone = (v: number | null) =>
    v == null || v === 0 ? undefined : v > 0 ? 'up' as const : 'down' as const

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageTitle
        eyebrow="分析・AI"
        title="過去パターン遷移"
        subtitle="6つの時間軸のステージの組み合わせから、過去に同じ並びが出た後の値動きを統計で確認します。"
        badge={universeMeta?.shortLabel}
      >
        <div className="w-full">
          <PatternSearchMock currentCode={code} topPatterns={top} />
        </div>
      </PageTitle>

      <section aria-label="選択中パターン" className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-[var(--color-border-soft)] pb-4">
        <div className="min-w-0">
          <div className="text-[12px] text-[var(--color-text-tertiary)]">選択中パターン</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="font-mono text-[26px] font-bold leading-none tabular-nums text-[var(--color-text-primary)]">{code}</span>
            <span className="flex gap-0.5">
              {stages.map((s, i) => (
                <span key={i} className={`sb-ts sb-s${s}`} title={STAGE_LABEL[i]}>{s}</span>
              ))}
            </span>
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
            左から {STAGE_LABEL.join(' · ')} の現在ステージ
          </div>
        </div>
        <dl className="flex gap-6 text-right tabular-nums">
          <div>
            <dt className="text-[12px] text-[var(--color-text-tertiary)]">過去出現</dt>
            <dd className="m-0 text-[22px] font-bold text-[var(--color-text-primary)]">{meta?.count_60d.toLocaleString() ?? '—'}回</dd>
          </div>
          {meta?.lastDate && (
            <div>
              <dt className="text-[12px] text-[var(--color-text-tertiary)]">直近の出現</dt>
              <dd className="m-0 text-[15px] font-semibold text-[var(--color-text-primary)]">{meta.lastDate}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          level={1}
          title="出現後のリターン"
          description={`中央値 · 統計対象 ${meta?.count_60d.toLocaleString() ?? '—'}件`}
        />
        <StatStrip
          label="期間別の中央値リターン"
          items={[30, 60, 90, 180].map((h) => {
            const r = horizonRows.find((x) => x.horizon_days === h)
            return {
              label: `${h}日後`,
              value: r?.p50 == null ? '—' : (r.p50 > 0 ? '+' : '') + r.p50.toFixed(1) + '%',
              tone: tone(r?.p50 ?? null),
              sub: `勝率 ${r ? (r.winRate * 100).toFixed(0) : '—'}% · ${r?.count.toLocaleString() ?? '—'}件`,
            }
          })}
        />
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-3">
          <SectionHeader
            title={`${horizonDays}日後のリターン分布`}
            actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{dist.total.toLocaleString()}件</span>}
          />
          <div>
            <div className="flex h-[96px] items-end gap-[3px] tabular-nums" role="img" aria-label={`${horizonDays}日後リターンの分布`}>
              {dist.bins.map((b, i) => {
                const h = distMax > 0 ? (b.count / distMax) * 100 : 0
                const isNeg = b.upper <= 0
                const strong = isNeg ? b.upper <= -10 : b.lower >= 10
                const bg = isNeg
                  ? (strong ? 'var(--color-price-down)' : 'color-mix(in srgb, var(--color-price-down) 35%, white)')
                  : (strong ? 'var(--color-price-up)' : 'color-mix(in srgb, var(--color-price-up) 35%, white)')
                return (
                  <div
                    key={i}
                    className="flex-1 rounded-t-[2px]"
                    style={{ background: bg, height: `${Math.max(2, h)}%` }}
                    title={`${b.lower}〜${b.upper}%: ${b.count}`}
                  />
                )
              })}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
              <span>-30%</span><span>-20%</span><span>-10%</span><span>0</span><span>+10%</span><span>+20%</span><span>+30%</span>
            </div>
            <dl className="mt-3 flex justify-between border-t border-[var(--color-border-soft)] pt-2.5 text-[12px] tabular-nums">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-[var(--color-text-tertiary)]">25%分位</dt>
                <dd className="m-0 font-semibold">{fmtPct(dist.p25, 2)}%</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-[var(--color-text-tertiary)]">中央値</dt>
                <dd className={`m-0 font-bold ${toneClass(dist.p50)}`}>{fmtPct(dist.p50, 2)}%</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-[var(--color-text-tertiary)]">75%分位</dt>
                <dd className="m-0 font-semibold">{fmtPct(dist.p75, 2)}%</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <SectionHeader
            title="業種別の出現数"
            actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{sectors.reduce((a, s) => a + s.count, 0).toLocaleString()}件</span>}
          />
          <ul className="flex flex-col gap-2 text-[12px] tabular-nums">
            {sectors.map((s) => {
              const widthPct = sectorMax > 0 ? (s.count / sectorMax) * 100 : 0
              return (
                <li key={s.sector_name} className="grid grid-cols-[minmax(84px,128px)_minmax(0,1fr)_40px] items-center gap-2">
                  <span className="truncate text-[var(--color-text-secondary)]" title={s.sector_name}>{s.sector_name}</span>
                  <span className="h-2 overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]">
                    <span className="block h-full rounded-[2px] bg-[var(--color-brand-700)]" style={{ width: `${widthPct}%` }} />
                  </span>
                  <span className="text-right font-semibold">{s.count.toLocaleString()}</span>
                </li>
              )
            })}
            {sectors.length === 0 && (
              <li className="py-4 text-center text-[var(--color-text-tertiary)]">データなし</li>
            )}
          </ul>
        </section>
      </div>

      <section className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          level={1}
          title="過去のサンプルケース"
          description={`180日後まで確定した ${samples.length}件 · 統計対象 ${meta?.count_60d.toLocaleString() ?? '—'}件`}
        />
        <ul className="divide-y divide-[var(--color-border-soft)] rounded-[6px] border border-[var(--color-border-soft)] sm:hidden">
          {samples.map((r) => (
            <li key={r.ticker + r.date} className="px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <Link href={`/stock/${r.ticker}`} className="min-w-0 truncate text-[13px] font-semibold text-[var(--color-text-primary)] hover:underline">
                  <span className="mr-1.5 font-mono text-[var(--color-brand-800)]">{r.ticker}</span>{r.name ?? r.ticker}
                </Link>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{r.date}</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1 text-[11px] tabular-nums">
                {([['30日', r.r30], ['60日', r.r60], ['90日', r.r90], ['180日', r.r180]] as const).map(([label, v]) => (
                  <span key={label}><span className="text-[var(--color-text-tertiary)]">{label} </span><span className={`font-semibold ${toneClass(v)}`}>{fmtPct(v, 1)}</span></span>
                ))}
              </div>
            </li>
          ))}
          {samples.length === 0 && <li className="py-4 text-center text-[12px] text-[var(--color-text-tertiary)]">サンプルケースなし</li>}
        </ul>
        <div className="table-scroll hidden rounded-[6px] border border-[var(--color-border-soft)] sm:block">
          <table className="sb-tbl" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ width: 96 }}>出現日</th>
                <th style={{ width: 56 }}>コード</th>
                <th>銘柄</th>
                <th style={{ width: 120 }}>業種</th>
                <th style={{ textAlign: 'right', width: 64 }}>+30日</th>
                <th style={{ textAlign: 'right', width: 64 }}>+60日</th>
                <th style={{ textAlign: 'right', width: 64 }}>+90日</th>
                <th style={{ textAlign: 'right', width: 68 }}>+180日</th>
              </tr>
            </thead>
            <tbody>
              {samples.map(r => (
                <tr key={r.ticker + r.date}>
                  <td className="sb-t">{r.date}</td>
                  <td className="sb-t">{r.ticker}</td>
                  <td>
                    <Link href={`/stock/${r.ticker}`} className="text-[var(--color-brand-800)] hover:underline">
                      {r.name ?? r.ticker}
                    </Link>
                  </td>
                  <td className="sb-t">{r.sector ?? '—'}</td>
                  <td className={`right ${toneClass(r.r30)}`}>{fmtPct(r.r30, 1)}</td>
                  <td className={`right ${toneClass(r.r60)}`}>{fmtPct(r.r60, 1)}</td>
                  <td className={`right ${toneClass(r.r90)}`}>{fmtPct(r.r90, 1)}</td>
                  <td className={`right ${toneClass(r.r180)}`}>{fmtPct(r.r180, 1)}</td>
                </tr>
              ))}
              {samples.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 14, color: 'var(--color-text-tertiary)' }}>
                    サンプルケースなし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {meta && meta.count_60d > samples.length && (
          <p className="text-right text-[11px] text-[var(--color-text-tertiary)]">
            上表はリターンが確定済みの代表ケースです
          </p>
        )}
      </section>
    </div>
  )
}
