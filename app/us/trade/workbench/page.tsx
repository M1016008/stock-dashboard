import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Eye, ShieldAlert } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { StageDots } from '@/components/ui/StageDots'
import {
  getUsTradeWorkbench,
  type UsTradeWorkbenchAction,
  type UsTradeWorkbenchCandidate,
} from '@/lib/queries/us-trade-workbench'

export const metadata: Metadata = {
  title: '米国株 売買候補ワークベンチ — StockBoard',
  description: '米国株の現行Serving候補、6ステージ、SMAを統合した検証用ワークベンチ',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const HORIZONS = [5, 10, 20, 40, 60, 90, 200]
const BUDGETS = [1_000, 5_000, 10_000]

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? null : value ?? null
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value == null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function fmtRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(1)}%`
}

function actionClasses(action: UsTradeWorkbenchAction): string {
  if (action === 'buy_candidate') return 'border-emerald-300 bg-emerald-50 text-emerald-800'
  if (action === 'downside_watch') return 'border-blue-300 bg-blue-50 text-blue-800'
  if (action === 'watch') return 'border-amber-300 bg-amber-50 text-amber-800'
  return 'border-slate-300 bg-slate-50 text-slate-600'
}

function ActionIcon({ action }: { action: UsTradeWorkbenchAction }) {
  if (action === 'buy_candidate') return <CheckCircle2 size={15} />
  if (action === 'downside_watch') return <ArrowDownRight size={15} />
  if (action === 'watch') return <Eye size={15} />
  return <ShieldAlert size={15} />
}

function makeHref(
  current: Record<string, string | string[] | undefined>,
  updates: Record<string, string | number>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(current)) {
    const raw = first(value)
    if (raw) params.set(key, raw)
  }
  for (const [key, value] of Object.entries(updates)) params.set(key, String(value))
  return `/us/trade/workbench?${params.toString()}`
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt>{label}</dt>
      <dd className="break-words">{value}</dd>
      {hint && <small>{hint}</small>}
    </div>
  )
}
function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[4px] border border-[var(--color-border-soft)] bg-white px-2 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 break-words text-[13px] font-black tabular-nums text-[var(--color-brand-900)]">{value}</div>
    </div>
  )
}

function CandidateCard({ candidate }: { candidate: UsTradeWorkbenchCandidate }) {
  const draft = candidate.orderDraft
  return (
    <Card size="lg">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/us/stock/${encodeURIComponent(candidate.ticker)}`} className="text-[18px] font-black text-[var(--color-brand-900)] hover:underline">
                  {candidate.ticker}
                </Link>
                <span className="text-[13px] font-bold text-[var(--color-text-secondary)]">{candidate.name}</span>
                <span className={`inline-flex items-center gap-1 rounded-[3px] border px-2 py-1 text-[11px] font-black ${actionClasses(candidate.decision.action)}`}>
                  <ActionIcon action={candidate.decision.action} />
                  {candidate.decision.label}
                </span>
                <span className="rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 py-1 text-[11px] font-black text-[var(--color-brand-800)]">
                  現行根拠 {candidate.decision.score.toFixed(1)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                <span>{candidate.exchange ?? 'Exchange unavailable'}</span>
                <span>{candidate.sector ?? 'Sector unavailable'}</span>
                <span>as-of {candidate.asOfDate}</span>
              </div>
            </div>
            <Link href={`/us/stock/${encodeURIComponent(candidate.ticker)}`} className="btn inline-flex h-8 items-center gap-1.5">
              銘柄詳細 <ArrowUpRight size={14} />
            </Link>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[240px_1fr]">
            <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
              <div className="grid grid-cols-2 gap-2">
                <MiniMetric label="終値" value={fmtUsd(candidate.close)} />
                <MiniMetric label="前日比" value={fmtPct(candidate.changePct)} />
                <MiniMetric label="上昇ML" value={candidate.ml.up.rank ? `#${candidate.ml.up.rank}` : '-'} />
                <MiniMetric label="下落ML" value={candidate.ml.down.rank ? `#${candidate.ml.down.rank}` : '-'} />
              </div>
              <div className="mt-3">
                <div className="mb-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">6ステージ</div>
                <StageDots values={candidate.stages} size={22} />
                <div className="mt-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                  {candidate.stageLabels.slice(0, 3).join(' / ')}
                </div>
              </div>
            </div>
            <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
              <div className="text-[12px] font-black text-[var(--color-brand-900)]">現在の根拠</div>
              <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{candidate.decision.summary}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {candidate.decision.why.map((item) => (
                  <div key={item} className="rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
                    {item}
                  </div>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <MiniMetric label="SMA並び" value={candidate.maState.label} />
                <MiniMetric label="SMA角度" value={candidate.maState.angleLabel} />
                <MiniMetric label="25日線乖離" value={fmtPct(candidate.maState.priceVsSma25Pct)} />
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-[4px] border border-blue-200 bg-blue-50 p-3">
            <div className="text-[12px] font-black text-blue-900">利用できない根拠とリスク</div>
            <ul className="mt-2 space-y-1.5 text-[12px] font-semibold text-blue-950">
              {candidate.decision.riskNotes.map((note) => <li key={note}>・{note}</li>)}
            </ul>
          </div>
        </div>

        <div className="w-full xl:w-[340px]">
          <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[12px] font-black text-[var(--color-brand-900)]">買い指値下書き</div>
                <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">発注機能ではありません。</p>
              </div>
              <span className={`rounded-[3px] border bg-white px-2 py-1 text-[11px] font-black ${draft.valid ? 'border-emerald-300 text-emerald-800' : 'border-slate-300 text-slate-600'}`}>
                {draft.valid ? '作成可' : '参考のみ'}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <MiniMetric label="通貨" value="USD" />
              <MiniMetric label="売買単位" value="1株" />
              <MiniMetric label="基準価格" value={fmtUsd(draft.referencePrice)} />
              <MiniMetric label="数量" value={draft.quantity ? `${draft.quantity.toLocaleString('en-US')}株` : '-'} />
              <MiniMetric label="仮予算" value={fmtUsd(draft.budgetUsd)} />
              <MiniMetric label="概算金額" value={fmtUsd(draft.estimatedAmount)} />
            </div>
            <ul className="mt-3 space-y-1.5 border-t border-[var(--color-border-soft)] pt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              {draft.guardrails.map((note) => <li key={note}>・{note}</li>)}
            </ul>
          </div>
          <div className="mt-3 rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
            <div className="text-[12px] font-black text-[var(--color-brand-900)]">次に確認</div>
            <ul className="mt-2 space-y-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)]">
              {candidate.decision.nextChecks.map((note) => <li key={note}>・{note}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </Card>
  )
}

export default async function UsTradeWorkbenchPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = searchParams ? await searchParams : {}
  const horizonDays = boundedInteger(first(sp.horizon), 20, 5, 200)
  const budgetUsd = boundedInteger(first(sp.budgetUsd), 5_000, 100, 1_000_000)
  const limit = boundedInteger(first(sp.limit), 40, 1, 120)
  const invalidQuery = Array.isArray(sp.horizon)
    || Array.isArray(sp.budgetUsd)
    || Array.isArray(sp.limit)
    || horizonDays == null
    || !HORIZONS.some((value) => value === horizonDays)
    || budgetUsd == null
    || limit == null
  if (invalidQuery || horizonDays == null || budgetUsd == null || limit == null) {
    return (
      <div className="sb-page">
        <PageTitle
          eyebrow="US分析・AI"
          title="米国株 売買候補"
          subtitle="現行ServingのPhysical ML、6ステージ、SMAを同一as-of日で照合します。過去Outcomeや借株可否は使いません。"
          badge="検証用下書き"
          rightSlot={<Link href="/us/analysis/backtest" className="btn">US過去検証へ</Link>}
        />
        <Notice
          role="alert"
          tone="error"
          title="クエリを読み取れません"
          action={<Link href="/us/trade/workbench" prefetch={false} className="btn">既定の条件に戻す</Link>}
        >
          horizonは5・10・20・40・60・90・200のいずれか、budgetUsdは100〜1,000,000、limitは1〜120の整数を1つだけ指定してください。
        </Notice>
      </div>
    )
  }
  const data = await getUsTradeWorkbench({ horizonDays, budgetUsd, limit })

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="US分析・AI"
        title="米国株 売買候補"
        subtitle="現行ServingのPhysical ML、6ステージ、SMAを同一as-of日で照合します。過去Outcomeや借株可否は使いません。"
        badge="検証用下書き"
        meta={<span>{data.params.horizonDays}営業日 / {data.coverage.asOfDate ?? 'Source unavailable'}</span>}
        rightSlot={<Link href="/us/analysis/backtest" className="btn">US過去検証へ</Link>}
      />

      <dl className="stat-strip" aria-label="US候補の集計">
        <Metric label="完全候補" value={data.summary.total.toLocaleString()} hint={`母数 ${data.coverage.rawCandidateCount.toLocaleString()}`} />
        <Metric label="買い下書き" value={data.summary.buyCandidates.toLocaleString()} hint="1株単位・USD" />
        <Metric label="下落警戒" value={data.summary.downsideWatch.toLocaleString()} hint="空売り可否は未判定" />
        <Metric label="要確認" value={data.summary.watch.toLocaleString()} />
        <Metric label="Coverage" value={fmtRate(data.coverage.completeRate)} hint={data.coverage.availability.toUpperCase()} />
        <Metric label="価格Basis" value={data.coverage.priceBasis ?? '-'} hint="US Analytics Serving" />
      </dl>

      {data.coverage.availability === 'unavailable' ? (
        <Card className="sb-section border-red-300 bg-red-50" role="alert">
          <CardHeader title="Servingデータを利用できません" hint="候補を最新値へフォールバックせず、Fail-Closedで停止しています。" />
          <p className="text-[13px] font-bold text-red-900">理由: {data.coverage.reason ?? 'UNKNOWN'}</p>
          <p className="mt-2 text-[12px] font-semibold text-red-900">Price / Snapshot / ML候補のGenerationと価格basisが同一になるまで候補は表示しません。</p>
        </Card>
      ) : (
        <>
          <Card className="sb-section">
            <CardHeader title="条件とSource Coverage" hint="候補集合を減らして正常に見せず、除外件数と利用不可Evidenceを表示します。" />
            <div className="flex flex-wrap gap-2">
              {HORIZONS.map((horizon) => (
                <Link key={horizon} href={makeHref(sp, { horizon })} aria-current={data.params.horizonDays === horizon ? 'true' : undefined} className={`inline-flex h-8 items-center rounded-[3px] border px-3 text-[12px] font-black ${data.params.horizonDays === horizon ? 'border-[var(--color-market-red)] bg-red-50 text-red-700' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'}`}>
                  {horizon}営業日
                </Link>
              ))}
              <span className="mx-1 hidden h-8 border-l border-[var(--color-border-default)] sm:inline-block" aria-hidden />
              {BUDGETS.map((budget) => (
                <Link key={budget} href={makeHref(sp, { budgetUsd: budget })} aria-current={data.params.budgetUsd === budget ? 'true' : undefined} className={`inline-flex h-8 items-center rounded-[3px] border px-3 text-[12px] font-black ${data.params.budgetUsd === budget ? 'border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] text-[var(--color-brand-900)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'}`}>
                  仮予算 {fmtUsd(budget)}
                </Link>
              ))}
            </div>
            <div className="mt-3 grid gap-2 text-[12px] font-semibold text-[var(--color-text-secondary)] sm:grid-cols-2 lg:grid-cols-4">
              <div>Price {data.coverage.priceDate}</div>
              <div>Snapshot {data.coverage.snapshotDate}</div>
              <div>完全 {data.coverage.completeCandidateCount} / 母数 {data.coverage.rawCandidateCount}</div>
              <div>除外 {data.coverage.excludedCandidateCount}</div>
            </div>
            {data.coverage.availability === 'partial' && (
              <div className="mt-3 flex gap-2 rounded-[4px] border border-amber-300 bg-amber-50 p-3 text-[12px] font-bold text-amber-950">
                <AlertTriangle className="mt-0.5 shrink-0" size={16} />
                完全な同日Price・Snapshot・現行Universeを持たない候補は表示せず、Coverageから除外しています。
              </div>
            )}
            <p className="mt-3 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              利用不可: {data.coverage.unavailableEvidence.join(' / ')}
            </p>
          </Card>

          {data.candidates.length === 0 ? (
            <EmptyState
              title="条件を満たすUS候補はありません"
              description="Serving母集団や条件を推測で緩めず、観測された0件を表示しています。"
            />
          ) : (
            <div className="sb-section space-y-4">
              {data.candidates.map((candidate) => <CandidateCard key={candidate.ticker} candidate={candidate} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
