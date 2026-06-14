import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, FlaskConical, ShieldAlert } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageDots } from '@/components/ui/StageDots'
import {
  getTradeWorkbench,
  type TradeWorkbenchAction,
  type TradeWorkbenchCandidate,
  type TradeWorkbenchModelEvidence,
  type TradeWorkbenchPatternEvidence,
  type TradeWorkbenchSignalEvidence,
  type TradeWorkbenchSignalPatternEvidence,
} from '@/lib/queries/trade-workbench'

export const metadata: Metadata = {
  title: '売買候補ワークベンチ — StockBoard',
  description: '既存シグナル、ML、過去検証を統合し、注文案のなぜを確認するワークベンチ',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const HORIZONS = [20, 40, 60, 90, 180]
const BUDGETS = [300_000, 500_000, 1_000_000]

function paramValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function intParam(value: string | string[] | undefined): number | null {
  const parsed = Number(paramValue(value) ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function numberParam(value: string | string[] | undefined): number | null {
  const parsed = Number(paramValue(value) ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtRate(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const pct = Math.abs(value) <= 1.5 ? value * 100 : value
  return `${pct.toFixed(digits)}%`
}

function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('ja-JP', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
}

function fmtYen(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value).toLocaleString()}円`
}

function actionClasses(action: TradeWorkbenchAction): string {
  if (action === 'buy_candidate') return 'border-red-300 bg-red-50 text-red-700'
  if (action === 'short_candidate') return 'border-blue-300 bg-blue-50 text-blue-700'
  if (action === 'watch') return 'border-amber-300 bg-amber-50 text-amber-700'
  if (action === 'risk_alert') return 'border-blue-300 bg-blue-50 text-blue-700'
  return 'border-slate-300 bg-slate-50 text-slate-600'
}

function actionIcon(action: TradeWorkbenchAction) {
  if (action === 'buy_candidate') return <CheckCircle2 size={15} />
  if (action === 'short_candidate') return <ArrowDownRight size={15} />
  if (action === 'risk_alert') return <ShieldAlert size={15} />
  if (action === 'watch') return <AlertTriangle size={15} />
  return <FlaskConical size={15} />
}

function makeHref(current: Record<string, string | string[] | undefined>, updates: Record<string, string | number>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(current)) {
    const raw = paramValue(value)
    if (raw) params.set(key, raw)
  }
  for (const [key, value] of Object.entries(updates)) params.set(key, String(value))
  const query = params.toString()
  return query ? `/trade/workbench?${query}` : '/trade/workbench'
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-3 shadow-[var(--shadow-card)]">
      <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[20px] font-black tabular-nums text-[var(--color-brand-900)]">{value}</div>
      {hint && <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">{hint}</div>}
    </div>
  )
}

function EvidenceTable({ rows }: { rows: TradeWorkbenchSignalEvidence[] }) {
  if (rows.length === 0) {
    return <p className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">短期シグナル統計は不足しています。</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[12px]">
        <thead className="bg-[var(--color-surface-subtle)] text-[11px] text-[var(--color-text-tertiary)]">
          <tr>
            <th className="px-2 py-1.5 text-left">シグナル</th>
            <th className="px-2 py-1.5 text-right">期間</th>
            <th className="px-2 py-1.5 text-right">上昇率</th>
            <th className="px-2 py-1.5 text-right">平均</th>
            <th className="px-2 py-1.5 text-right">件数</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 4).map((row) => (
            <tr key={`${row.signalCode}-${row.horizonDays}`} className="border-b border-[var(--color-border-soft)]">
              <td className="px-2 py-1.5 font-bold text-[var(--color-brand-900)]">{row.label}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{row.horizonDays}日</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtRate(row.upRate)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtPct(row.avgReturnPct)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{row.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SignalPatternList({ rows }: { rows: TradeWorkbenchSignalPatternEvidence[] }) {
  if (rows.length === 0) return null
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.slice(0, 4).map((row) => (
        <div key={`${row.signalCode}-${row.horizonDays}`} className="rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-2">
          <div className="text-[12px] font-black text-[var(--color-brand-900)]">{row.label}</div>
          <div className="mt-1 grid grid-cols-3 gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            <span>{row.horizonDays}日</span>
            <span>+10% {fmtRate(row.hit10Rate)}</span>
            <span>中央値 {fmtPct(row.maxReturnP50)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function PatternEvidence({ evidence }: { evidence: TradeWorkbenchPatternEvidence | null }) {
  if (!evidence) {
    return <p className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">同じ6桁ステージの統計は不足しています。</p>
  }
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      <MiniMetric label="6桁" value={evidence.patternCode} />
      <MiniMetric label="中央値" value={fmtPct(evidence.p50)} />
      <MiniMetric label="上位25%" value={fmtPct(evidence.p75)} />
      <MiniMetric label="上昇側比率" value={fmtRate(evidence.upRate)} />
    </div>
  )
}

function ModelEvidence({ label, evidence }: { label: string; evidence: TradeWorkbenchModelEvidence | null }) {
  if (!evidence) {
    return (
      <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
        <div className="text-[12px] font-black text-[var(--color-brand-900)]">{label}</div>
        <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">強化版検証値なし</div>
      </div>
    )
  }
  return (
    <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
      <div className="text-[12px] font-black text-[var(--color-brand-900)]">{label}</div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
        <span>top60 的中 {fmtRate(evidence.top60HitRate)}</span>
        <span>lift {evidence.liftTop60VsBaseline?.toFixed(2) ?? '-'}</span>
        <span>母数 {evidence.sampleCount.toLocaleString()}</span>
        <span>目標 {fmtPct(evidence.targetPct)}</span>
      </div>
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white px-2 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[13px] font-black tabular-nums text-[var(--color-brand-900)]">{value}</div>
    </div>
  )
}

function OrderDraftPanel({ candidate }: { candidate: TradeWorkbenchCandidate }) {
  const draft = candidate.orderDraft
  const isShort = draft.side === 'SELL_SHORT'
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-black text-[var(--color-brand-900)]">注文案下書き</div>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            発注機能ではありません。根拠確認用の下書きです。
          </div>
        </div>
        <span className={`inline-flex items-center rounded-[3px] border px-2 py-1 text-[11px] font-black ${draft.valid ? isShort ? 'border-blue-300 bg-white text-blue-700' : 'border-red-300 bg-white text-red-700' : 'border-slate-300 bg-white text-slate-600'}`}>
          {draft.valid ? '作成可' : '参考のみ'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <MiniMetric label="売買" value={isShort ? '空売り指値' : '買い指値'} />
        <MiniMetric label="基準価格" value={fmtYen(draft.suggestedLimitPrice)} />
        <MiniMetric label="数量" value={draft.quantity ? `${draft.quantity.toLocaleString()}株` : '-'} />
        <MiniMetric label="概算金額" value={fmtYen(draft.estimatedAmount)} />
      </div>
      <div className="mt-3 space-y-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)]">
        {draft.why.map((item, index) => (
          <div key={index} className="flex gap-2">
            <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${isShort ? 'bg-blue-600' : 'bg-[var(--color-market-red)]'}`} />
            <span>{item}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-[var(--color-border-soft)] pt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
        {draft.guardrails.join(' / ')}
      </div>
    </div>
  )
}

function CandidateCard({ candidate }: { candidate: TradeWorkbenchCandidate }) {
  return (
    <Card size="lg" className="hover:border-[var(--color-border-default)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/stock/${candidate.ticker}`} className="text-[18px] font-black text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
                  {candidate.ticker}
                </Link>
                <span className="text-[13px] font-bold text-[var(--color-text-secondary)]">{candidate.name ?? '-'}</span>
                <span className={`inline-flex items-center gap-1 rounded-[3px] border px-2 py-1 text-[11px] font-black ${actionClasses(candidate.decision.action)}`}>
                  {actionIcon(candidate.decision.action)}
                  {candidate.decision.label}
                </span>
                <span className="rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 py-1 text-[11px] font-black text-[var(--color-brand-800)]">
                  根拠スコア {candidate.decision.score.toFixed(1)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                <span>{candidate.marketSegment ?? '-'}</span>
                <span>{candidate.sector17Name ?? '-'}</span>
                <span>{candidate.marginType ?? '-'}</span>
                <span>価格日 {candidate.priceDate ?? '-'}</span>
              </div>
            </div>
            <Link
              href={`/stock/${candidate.ticker}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-black text-[var(--color-brand-800)] hover:border-[var(--color-market-red)] hover:text-[var(--color-market-red)]"
            >
              銘柄詳細
              <ArrowUpRight size={14} />
            </Link>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[240px_1fr]">
            <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
              <div className="grid grid-cols-2 gap-2">
                <MiniMetric label="終値" value={fmtYen(candidate.close)} />
                <MiniMetric label="前日比" value={fmtPct(candidate.changePct)} />
                <MiniMetric label="ML上昇" value={candidate.ml.physicsUp.rank ? `#${candidate.ml.physicsUp.rank}` : '-'} />
                <MiniMetric label="ML下落" value={candidate.ml.physicsDown.rank ? `#${candidate.ml.physicsDown.rank}` : '-'} />
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
              <div className="text-[12px] font-black text-[var(--color-brand-900)]">なぜこの判定か</div>
              <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{candidate.decision.summary}</p>
              <div className="mt-3 grid gap-2 text-[12px] font-semibold text-[var(--color-text-secondary)] md:grid-cols-2">
                {candidate.decision.why.slice(0, 4).map((item, index) => (
                  <div key={index} className="rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-2">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
              <div className="mb-2 text-[12px] font-black text-[var(--color-brand-900)]">過去シグナル統計</div>
              <EvidenceTable rows={candidate.historicalEvidence.signalShortTerm} />
              <div className="mt-3">
                <SignalPatternList rows={candidate.historicalEvidence.signalPattern} />
              </div>
            </div>
            <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
              <div className="mb-2 text-[12px] font-black text-[var(--color-brand-900)]">過去学習・検証</div>
              <div className="space-y-3">
                <PatternEvidence evidence={candidate.historicalEvidence.stagePattern} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <ModelEvidence label="上昇モデル" evidence={candidate.historicalEvidence.objectiveUp} />
                  <ModelEvidence label="下落警戒モデル" evidence={candidate.historicalEvidence.objectiveDown} />
                </div>
              </div>
            </div>
          </div>

          {candidate.decision.riskNotes.length > 0 && (
            <div className="mt-4 rounded-[4px] border border-blue-200 bg-blue-50 p-3">
              <div className="text-[12px] font-black text-blue-800">リスク確認</div>
              <ul className="mt-2 space-y-1.5 text-[12px] font-semibold text-blue-900">
                {candidate.decision.riskNotes.map((note, index) => (
                  <li key={index}>・{note}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="w-full lg:w-[340px]">
          <OrderDraftPanel candidate={candidate} />
          <div className="mt-3 rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
            <div className="text-[12px] font-black text-[var(--color-brand-900)]">次に見ること</div>
            <ul className="mt-2 space-y-1.5 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
              {candidate.decision.nextChecks.map((note, index) => (
                <li key={index}>・{note}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Card>
  )
}

export default async function TradeWorkbenchPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = searchParams ? await searchParams : {}
  const horizonDays = intParam(sp.horizonDays) ?? 20
  const budgetYen = numberParam(sp.budgetYen) ?? 500_000
  const limit = intParam(sp.limit) ?? 40
  const data = await getTradeWorkbench({ horizonDays, budgetYen, limit })
  const summary = data.summary

  return (
    <div className="sb-page">
      <PageTitle
        title="売買候補ワークベンチ"
        subtitle="既存の6ステージ、MA、シグナル、強化版ML検証を統合し、注文案の「なぜ」を確認します。実発注は行いません。"
        badge={`${data.params.horizonDays}営業日 / 注文案下書き`}
        rightSlot={
          <Link
            href="/backtest"
            className="inline-flex h-7 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-2.5 text-[11px] font-black text-[var(--color-brand-800)] hover:border-[var(--color-market-red)] hover:text-[var(--color-market-red)]"
          >
            過去検証へ
          </Link>
        }
      />

      <div className="sb-section grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatTile label="候補総数" value={summary.total.toLocaleString()} hint={`データ ${summary.latestDataDate ?? '-'}`} />
        <StatTile label="買い候補" value={summary.buyCandidates.toLocaleString()} hint="上昇根拠が揃う候補" />
        <StatTile label="空売り候補" value={summary.shortCandidates.toLocaleString()} hint="貸借かつ下落根拠" />
        <StatTile label="要確認" value={summary.watch.toLocaleString()} hint="追加確認が必要" />
        <StatTile label="下落警戒" value={summary.riskAlerts.toLocaleString()} hint="リスク管理優先" />
        <StatTile
          label="地合い"
          value={summary.marketContext.regime === 'bull' ? '強気' : summary.marketContext.regime === 'bear' ? '弱気' : summary.marketContext.regime === 'neutral' ? '中立' : '不明'}
          hint={`20日 ${fmtPct(summary.marketContext.marketReturn20)} / MA25上 ${fmtRate(summary.marketContext.marketAboveSma25Rate)}`}
        />
      </div>

      <Card className="sb-section">
        <CardHeader title="条件" hint="horizonと仮予算を切り替えて、注文案の作られ方を確認します。" />
        <div className="flex flex-wrap gap-2">
          {HORIZONS.map((horizon) => (
            <Link
              key={horizon}
              href={makeHref(sp, { horizonDays: horizon })}
              className={`inline-flex h-8 items-center rounded-[3px] border px-3 text-[12px] font-black ${
                data.params.horizonDays === horizon
                  ? 'border-[var(--color-market-red)] bg-red-50 text-red-700'
                  : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'
              }`}
            >
              {horizon}営業日
            </Link>
          ))}
          <span className="mx-1 h-8 border-l border-[var(--color-border-default)]" />
          {BUDGETS.map((budget) => (
            <Link
              key={budget}
              href={makeHref(sp, { budgetYen: budget })}
              className={`inline-flex h-8 items-center rounded-[3px] border px-3 text-[12px] font-black ${
                data.params.budgetYen === budget
                  ? 'border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] text-[var(--color-brand-900)]'
                  : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'
              }`}
            >
              仮予算 {fmtYen(budget)}
            </Link>
          ))}
        </div>
        <div className="mt-3 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
          買い注文案は「上昇MLとシグナルが重なり、過去検証の期待値が確認でき、下落警戒の重複が強すぎない」場合だけ作成可にします。
          空売り注文案は「貸借銘柄で、下落ML・下降ステージ・MA下向き・下落モデル検証がそろう」場合だけ作成可にします。
          証券APIには接続せず、実発注・デモ発注は行いません。
        </div>
      </Card>

      <div className="sb-section space-y-4">
        {data.candidates.length > 0 ? (
          data.candidates.map((candidate) => <CandidateCard key={candidate.ticker} candidate={candidate} />)
        ) : (
          <Card>
            <CardHeader title="候補なし" hint="シグナル・ML候補・価格データのいずれかが不足しています。" />
            <p className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
              最新バッチの実行状況を確認してください。
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
