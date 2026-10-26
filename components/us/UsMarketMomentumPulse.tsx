// components/us/UsMarketMomentumPulse.tsx
//
// 市場全体の脈拍。PMS/PFS/PES の広がり・騰落・カバレッジを最初の 1 画面で読む。
// 取引所・SEC sector の文脈は最新日だけ (過去日は現在の登録値を当時の分類として使わない)。

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { StatStrip } from '@/components/ui/StatStrip'
import { Notice } from '@/components/ui/EmptyState'
import { MeterBar } from '@/components/dashboard/DashboardPrimitives'
import type { UsMarketGroup, UsMarketIntelligence } from '@/lib/server/us-market-intelligence'
import {
  UNKNOWN_SECTOR_CODE,
  fmtCount,
  fmtPct,
  fmtRatio,
  fmtScore,
  secSectorShort,
  share,
  signedClass,
  usScreenerHref,
} from '@/components/us/UsMarketMomentumParts'

function scoreTone(value: number | null | undefined): 'up' | 'down' | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined
  return value > 0 ? 'up' : 'down'
}

export function UsMarketMomentumStats({ data }: { data: UsMarketIntelligence }) {
  const { summary } = data
  const total = summary.count
  return (
    <StatStrip
      label="米国株モメンタムの広がり"
      // 390px 前後では 2 列になるため、ラベル・値・補足を ellipsis で切らずに自然に折り返す (sm 以上は従来どおり 1 行)
      className="stat-strip-wrap-mobile"
      items={[
        { label: 'PMSプラス（PMS > 0）', value: fmtRatio(share(summary.positivePms, total)), sub: `${fmtCount(summary.positivePms)} / ${fmtCount(total)}銘柄`, tone: 'up' },
        { label: '動き出し（PFS > 0）', value: fmtRatio(share(summary.positivePfs, total)), sub: `${fmtCount(summary.positivePfs)}銘柄` },
        { label: '高エネルギー（PES ≥ +1）', value: fmtRatio(share(summary.highPes, total)), sub: `${fmtCount(summary.highPes)}銘柄` },
        { label: '騰落（1D 上昇 / 下落）', value: <><span className="whitespace-nowrap">{fmtCount(summary.advancing)} /</span> <span className="whitespace-nowrap">{fmtCount(summary.declining)}</span></>, sub: `上昇比率 ${fmtRatio(share(summary.advancing, summary.advancing + summary.declining))}` },
        { label: '平均 PMS / PFS', value: <span className={signedClass(summary.avgPms)}>{fmtScore(summary.avgPms)}</span>, sub: <>PFS <span className={signedClass(summary.avgPfs)}>{fmtScore(summary.avgPfs)}</span> · PES <span className={signedClass(summary.avgPes)}>{fmtScore(summary.avgPes)}</span></>, tone: scoreTone(summary.avgPms) },
      ]}
    />
  )
}

/* ---------- 広がり (左右に分かれるバー) ---------- */

function SplitRow({
  label,
  left,
  right,
  total,
  leftLabel,
  rightLabel,
}: {
  label: string
  left: number
  right: number
  total: number
  leftLabel: string
  rightLabel: string
}) {
  const leftWidth = share(left, total) ?? 0
  const rightWidth = share(right, total) ?? 0
  return (
    <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] items-center gap-x-3 py-1.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{label}</div>
      <div className="min-w-0">
        <div className="flex justify-between text-[10px] font-bold tabular-nums">
          <span className="text-[var(--color-price-up)]">{leftLabel} {fmtCount(left)}</span>
          <span className="text-[var(--color-price-down)]">{rightLabel} {fmtCount(right)}</span>
        </div>
        <div className="relative mt-1 flex h-[6px] overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]" aria-hidden="true">
          <span className="h-full bg-[var(--color-price-up)] opacity-75" style={{ width: `${leftWidth}%` }} />
          <span className="ml-auto h-full bg-[var(--color-price-down)] opacity-75" style={{ width: `${rightWidth}%` }} />
          <span className="absolute inset-y-[-1px] left-1/2 w-px bg-[var(--color-text-tertiary)] opacity-60" />
        </div>
      </div>
    </div>
  )
}

function MeterRow({ label, part, total, hint }: { label: string; part: number; total: number; hint: string }) {
  const value = share(part, total)
  return (
    <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] items-center gap-x-3 py-1.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{label}</div>
      <div className="min-w-0">
        <div className="flex justify-between text-[10px] font-bold tabular-nums text-[var(--color-text-secondary)]">
          <span>{fmtCount(part)}銘柄</span>
          <span className="text-[var(--color-text-tertiary)]">{fmtRatio(value)} {hint}</span>
        </div>
        <MeterBar value={value} tone="neutral" midTick className="mt-1" />
      </div>
    </div>
  )
}

export function UsMarketMomentumBreadth({ data }: { data: UsMarketIntelligence }) {
  const { summary, coverage } = data
  return (
    <section className="panel flex min-w-0 flex-col" aria-labelledby="us-mm-breadth">
      <div className="panel-head">
        <div className="min-w-0">
          <h2 id="us-mm-breadth">広がり（Breadth）</h2>
          <p>中央線 = 対象銘柄の50%</p>
        </div>
      </div>
      <div className="flex-1 divide-y divide-[var(--color-border-soft)] px-3.5 py-1.5">
        <SplitRow label="騰落（1D）" left={summary.advancing} right={summary.declining} total={summary.count} leftLabel="上昇" rightLabel="下落" />
        <SplitRow label="PMS 符号" left={summary.positivePms} right={summary.negativePms} total={summary.count} leftLabel="> 0" rightLabel="< 0" />
        <SplitRow label="PMS 強弱" left={summary.strongPms} right={summary.weakPms} total={summary.count} leftLabel="≥ +1" rightLabel="≤ −1" />
        <MeterRow label="PFS > 0" part={summary.positivePfs} total={summary.count} hint="動き出し" />
        <MeterRow label="PES ≥ +1" part={summary.highPes} total={summary.count} hint="高エネルギー" />
      </div>
      <dl className="grid grid-cols-3 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[11px]">
        <div className="min-w-0 px-3.5 py-2">
          <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">PMS算出済み</dt>
          <dd className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmtCount(coverage.momentumRows)}</dd>
        </div>
        <div className="min-w-0 border-l border-[var(--color-border-soft)] px-3.5 py-2">
          <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">6ステージあり</dt>
          <dd className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmtCount(coverage.stageRows)}</dd>
        </div>
        <div className="min-w-0 border-l border-[var(--color-border-soft)] px-3.5 py-2">
          <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">SEC SIC分類</dt>
          <dd className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">
            {data.classificationAvailability === 'CURRENT'
              ? <>{fmtCount(coverage.classifiedRows)} <span className="font-sans text-[10px] font-semibold text-[var(--color-text-tertiary)]">({fmtRatio(coverage.classificationPct)})</span></>
              : <span className="font-sans text-[11px] font-semibold text-[var(--color-text-tertiary)]">過去日は使わない</span>}
          </dd>
        </div>
      </dl>
    </section>
  )
}

/* ---------- 取引所 / SEC sector の文脈 (最新日のみ) ---------- */

function GroupHead({ first }: { first: string }) {
  return (
    <thead className="text-[10px]">
      <tr>
        <th className="py-1.5 pl-3.5 pr-2 text-left font-bold">{first}</th>
        <th className="py-1.5 pr-2 text-right font-bold">銘柄</th>
        <th className="py-1.5 pr-2 text-right font-bold">1D</th>
        <th className="py-1.5 pr-2 text-right font-bold">PMS</th>
        <th className="w-[5.5rem] py-1.5 pr-3.5 text-left font-bold">PMS+ 比率</th>
      </tr>
    </thead>
  )
}

function GroupCells({ group }: { group: UsMarketGroup }) {
  return (
    <>
      <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{fmtCount(group.count)}</td>
      <td className={`py-1.5 pr-2 text-right font-mono font-semibold tabular-nums ${signedClass(group.avgChangePct)}`}>{fmtPct(group.avgChangePct)}</td>
      <td className={`py-1.5 pr-2 text-right font-mono font-bold tabular-nums ${signedClass(group.avgPms)}`}>{fmtScore(group.avgPms)}</td>
      <td className="py-1.5 pr-3.5">
        <span className="block font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-secondary)]">{fmtRatio(group.positivePmsPct)}</span>
        <MeterBar value={group.positivePmsPct} tone={(group.positivePmsPct ?? 0) >= 50 ? 'up' : 'down'} midTick className="mt-0.5" />
      </td>
    </>
  )
}

export function UsMarketMomentumExchangeContext({ groups }: { groups: UsMarketGroup[] }) {
  return (
    <section className="panel flex min-w-0 flex-col" aria-labelledby="us-mm-exchange">
      <div className="panel-head">
        <div className="min-w-0">
          <h2 id="us-mm-exchange">Exchange別</h2>
          <p>最新日 · 現在の上場取引所 · 平均PMS順</p>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">取引所の登録がある銘柄がありません</p>
      ) : (
        <div className="table-scroll">
          <table className="w-full min-w-[340px] text-[12px]">
            <GroupHead first="Exchange" />
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {groups.map((group) => (
                <tr key={group.key} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="py-1.5 pl-3.5 pr-2">
                    <Link
                      href={usScreenerHref({ exchange: group.key, sort: 'pms', dir: 'desc' })}
                      prefetch={false}
                      className="font-mono font-bold text-[var(--color-brand-700)] hover:underline"
                      title={`${group.label} の銘柄をスクリーナーで開く`}
                    >
                      {group.label}
                    </Link>
                  </td>
                  <GroupCells group={group} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function UsMarketMomentumSectorContext({ groups }: { groups: UsMarketGroup[] }) {
  return (
    <section className="panel flex min-w-0 flex-col" aria-labelledby="us-mm-sector">
      <div className="panel-head">
        <div className="min-w-0">
          <h2 id="us-mm-sector">StockBoard SIC division別</h2>
          <p>最新日 · SEC SIC industry + StockBoard独自区分 · 平均PMS順</p>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">SEC SIC 分類のある銘柄がありません</p>
      ) : (
        <div className="table-scroll flex-1">
          <table className="w-full min-w-[340px] text-[12px]">
            <GroupHead first="Sector" />
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {groups.map((group) => (
                <tr key={group.key} className="hover:bg-[var(--color-surface-subtle)]">
                  <td className="max-w-[11rem] py-1.5 pl-3.5 pr-2">
                    {group.key === UNKNOWN_SECTOR_CODE ? (
                      <span className="block truncate font-semibold text-[var(--color-text-tertiary)]" title="SEC 登録に SIC コードがない銘柄">
                        {secSectorShort(group.key, group.label)}
                      </span>
                    ) : (
                      <Link
                        href={`/us/sectors?sector=${encodeURIComponent(group.key)}#us-industries`}
                        prefetch={false}
                        className="block truncate font-semibold text-[var(--color-brand-700)] hover:underline"
                        title={`${group.label} の SIC industry を見る`}
                      >
                        {secSectorShort(group.key, group.label)}
                      </Link>
                    )}
                  </td>
                  <GroupCells group={group} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link
        href="/us/sectors"
        prefetch={false}
        className="flex min-h-9 items-center justify-center gap-1 border-t border-[var(--color-border-soft)] text-[12px] font-semibold text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)]"
      >
        セクター → SIC industry を詳しく見る
        <ChevronRight size={13} aria-hidden />
      </Link>
    </section>
  )
}

export function UsMarketMomentumContextUnavailable({ date }: { date: string }) {
  return (
    <Notice tone="warning" title="Exchange・SEC sector の文脈は最新日のみ表示します" className="lg:col-span-2 2xl:col-span-2">
      {date} は過去日です。取引所と SEC SIC 分類は現在の登録値しかなく、当時の分類として表示・集計すると誤解を生むため、この日付では使いません。
      騰落・PMS/PFS/PES・6ステージは {date} 終値時点の値です。
    </Notice>
  )
}
