import Link from 'next/link'
import type { ReactNode } from 'react'
import { Card, CardHeader } from '@/components/ui/Card'
import {
  ML_PHYSICS_DEFAULT_HORIZONS,
  ML_PHYSICS_FEATURE_SET,
  type PhysicsCandidateExplanation,
  type PhysicsCandidateReason,
  type PhysicsDirection,
  type PhysicsFeatureProfile,
} from '@/lib/backtest/ml-physics'
import {
  physicsStatusTone,
  type PhysicsAnalysis,
  type PhysicsStatus,
  type PullbackVerdict,
} from '@/lib/ml/physics-analysis'

export type PhysicsMlCandidateView = {
  as_of_date: string
  direction: PhysicsDirection
  horizon_days: number
  rank: number
  ticker: string
  name: string | null
  sector_large: string | null
  candidate_score: number
  profile: PhysicsFeatureProfile | null
  reason: Partial<PhysicsCandidateReason>
  explanation: Partial<PhysicsCandidateExplanation>
  analysis: PhysicsAnalysis
}

export type PhysicsMlCandidateStatus = {
  latestDate: string | null
  rowsLatest: number
  candidateDate: string | null
  candidateRowsLatest: number
}

function fmtDate(value: string | null | undefined): string {
  return value ? value.replaceAll('-', '/') : '未生成'
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

function fmtCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function directionLabel(direction: PhysicsDirection | null | undefined): string {
  if (direction === 'down') return '下落候補'
  if (direction === 'wait') return '見送り候補'
  return '上昇候補'
}

function directionTone(direction: PhysicsDirection | null | undefined): 'red' | 'blue' | 'neutral' {
  if (direction === 'down') return 'blue'
  if (direction === 'wait') return 'neutral'
  return 'red'
}

function stageDigitClass(digit: string): string {
  const map: Record<string, string> = {
    '1': 'border-red-200 bg-red-50 text-red-700',
    '2': 'border-orange-200 bg-orange-50 text-orange-700',
    '3': 'border-amber-200 bg-amber-50 text-amber-700',
    '4': 'border-sky-200 bg-sky-50 text-sky-700',
    '5': 'border-blue-200 bg-blue-50 text-blue-700',
    '6': 'border-violet-200 bg-violet-50 text-violet-700',
  }
  return map[digit] ?? 'border-slate-200 bg-slate-50 text-slate-500'
}

function StageCode({ code }: { code: string | null | undefined }) {
  const value = code && code.length >= 6 ? code : '------'
  return (
    <span className="inline-flex items-center gap-1" aria-label={`6桁ステージ ${value}`}>
      {value.split('').slice(0, 6).map((digit, index) => (
        <span
          key={`${digit}-${index}`}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-[3px] border text-[11px] font-bold ${stageDigitClass(digit)}`}
        >
          {digit}
        </span>
      ))}
    </span>
  )
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'red' | 'blue' | 'neutral' }) {
  const className =
    tone === 'red'
      ? 'border-red-200 bg-red-50 text-red-700'
      : tone === 'blue'
        ? 'border-blue-200 bg-blue-50 text-blue-700'
        : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
  return <span className={`inline-flex items-center rounded-[3px] border px-2 py-1 text-[11px] font-bold ${className}`}>{children}</span>
}

function physicsBadgeClass(status: PhysicsStatus | PullbackVerdict | null | undefined): string {
  if (!status) return 'border-slate-200 bg-slate-50 text-slate-600'
  const tone = physicsStatusTone(status as PhysicsStatus)
  if (status === '上昇加速' || status === '上昇継続' || status === '押し目形成' || status === '反発準備' || status === '本物の押し目に近い') {
    return 'border-red-200 bg-red-50 text-red-700'
  }
  if (status === '下落加速' || status === '失速警戒' || status === '下落途中の一時反発' || status === '反発は弱い') {
    return 'border-blue-200 bg-blue-50 text-blue-700'
  }
  if (status === '過熱注意' || tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700'
  return 'border-slate-200 bg-slate-50 text-slate-600'
}

function PhysicsBadge({
  children,
  status,
}: {
  children: ReactNode
  status: PhysicsStatus | PullbackVerdict | null | undefined
}) {
  return (
    <span className={`inline-flex items-center rounded-[3px] border px-2 py-1 text-[11px] font-bold ${physicsBadgeClass(status)}`}>
      {children}
    </span>
  )
}

function regimeText(value: string | null | undefined): string {
  const map: Record<string, string> = {
    up_acceleration: '上昇加速',
    up_deceleration: '上昇鈍化',
    down_acceleration: '下落加速',
    down_deceleration: '下落鈍化',
    sideways: '横ばい',
    compression: '収縮',
    up_expansion: '上方向拡散',
    down_expansion: '下方向拡散',
    neutral: '中立',
    bullish_turn: '上向き転換',
    bearish_turn: '下向き転換',
    rebound_watch: '反発候補',
    breakdown_watch: '崩れ候補',
    none: '転換なし',
  }
  return value ? map[value] ?? value : '-'
}

function PhysicsCandidateCard({
  candidate,
  market,
}: {
  candidate: PhysicsMlCandidateView
  market: 'JP' | 'US'
}) {
  const profile = candidate.profile
  const href = market === 'US'
    ? `/us/stock/${encodeURIComponent(candidate.ticker)}#ml`
    : `/stock/${encodeURIComponent(candidate.ticker)}#ml`
  return (
    <Card size="sm" className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={directionTone(candidate.direction)}>{directionLabel(candidate.direction)}</Pill>
            <Pill>{candidate.horizon_days}営業日</Pill>
            <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">#{candidate.rank}</span>
          </div>
          <Link
            href={href}
            prefetch={false}
            className="mt-2 inline-flex text-[16px] font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]"
          >
            {candidate.ticker} {candidate.name ?? ''}
          </Link>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            {candidate.sector_large ?? '業種未設定'} / {fmtDate(candidate.as_of_date)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">短期形状</div>
          <div className="text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">{fmtRatio(candidate.candidate_score)}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StageCode code={profile?.stageCode} />
        <Pill>{profile?.maOrder ?? 'MA並び未生成'}</Pill>
        <PhysicsBadge status={candidate.analysis.physicsStatus}>{candidate.analysis.physicsStatus}</PhysicsBadge>
        <PhysicsBadge status={candidate.analysis.pullbackVerdict}>{candidate.analysis.pullbackVerdict}</PhysicsBadge>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {[
          ['流れ', profile?.regimes.trend],
          ['距離', profile?.regimes.spread],
          ['転換', profile?.regimes.turn],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2.5 py-2">
            <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
            <div className="mt-1 text-[12px] font-bold text-[var(--color-brand-900)]">{regimeText(value)}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Pill>5SMA速度 {fmtPct(profile?.velocities.sma5.d5)}</Pill>
        <Pill>5SMA加速度 {fmtPct(profile?.accelerations.sma5.d5)}</Pill>
        <Pill>5-25距離 {fmtPct(profile?.gaps.sma5To25Pct)}</Pill>
        <Pill>距離変化 {fmtPct(profile?.gapVelocity.sma5To25D5)}</Pill>
      </div>

      {candidate.explanation.summary && (
        <p className="mt-3 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{candidate.explanation.summary}</p>
      )}
      <div className="mt-3 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
        <div className="text-[12px] font-bold text-[var(--color-brand-900)]">物理ステータスの読み</div>
        <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{candidate.analysis.summary}</p>
      </div>

      <div className="mt-3 grid gap-1.5">
        {(['velocity', 'acceleration', 'distance', 'pricePosition', 'regime', 'context', 'timing', 'risk'] as const).map((key) => (
          candidate.reason[key] ? (
            <div
              key={key}
              className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]"
            >
              {candidate.reason[key]}
            </div>
          ) : null
        ))}
      </div>
    </Card>
  )
}

const SECTIONS = [
  { title: '超短期', horizonDays: 5, body: '数日から1週間の初動と急失速を捉える候補です。' },
  { title: '短期', horizonDays: 10, body: '日足の速度・加速度に、週足/月足の支援や抵抗を重ねた候補です。' },
  { title: '1か月', horizonDays: 20, body: '約1か月の方向感と押し目・失速を評価する候補です。' },
  { title: '2か月', horizonDays: 40, body: '週足トレンドが効く数週間から約2か月の候補です。' },
  { title: '3か月', horizonDays: 60, body: '日足と週足の持続性を約3か月で確認する候補です。' },
  { title: '中長期', horizonDays: 90, body: '月足の方向性まで見た約4か月の候補です。' },
  { title: '超長期', horizonDays: 200, body: '約10か月の月足構造と大きな転換を重視する候補です。' },
]

const GROUPS: Array<{ direction: PhysicsDirection; title: string; body: string }> = [
  { direction: 'up', title: '上昇候補', body: 'SMA速度・加速度・距離拡大が上方向に揃いやすい形です。' },
  { direction: 'down', title: '下落候補', body: 'SMA下向き加速、戻り失敗、距離の下方向拡大を重視します。' },
  { direction: 'wait', title: '見送り候補', body: '方向感より横ばい・収縮・逆行リスクが強く、条件待ちに寄せる形です。' },
]

export function PhysicsMlCandidatesPanel({
  status,
  rows,
  market,
}: {
  status: PhysicsMlCandidateStatus
  rows: PhysicsMlCandidateView[]
  market: 'JP' | 'US'
}) {
  const physicsVersionLabel = ML_PHYSICS_FEATURE_SET.endsWith('_v4')
    ? 'v4'
    : ML_PHYSICS_FEATURE_SET.endsWith('_v3')
      ? 'v3'
      : 'v2'

  return (
    <Card size="lg">
      <CardHeader
        title={`チャート物理 ${physicsVersionLabel}`}
        hint={`SMAの速度・加速度・距離変化、週足/月足の整列で短期〜月足の形状を読むMLです。学習horizon ${ML_PHYSICS_DEFAULT_HORIZONS.join('/')}営業日 / 特徴量 ${fmtCount(status.rowsLatest)}件 / 候補 ${fmtCount(status.candidateRowsLatest)}件`}
      />
      {rows.length === 0 ? (
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3 text-[12px] font-semibold text-[var(--color-text-secondary)]">
          {ML_PHYSICS_FEATURE_SET} の候補はまだ生成されていません。候補生成が完了すると自動表示されます。
        </div>
      ) : (
        <div className="space-y-5">
          {SECTIONS.map((section) => {
            const sectionRows = rows.filter((row) => row.horizon_days === section.horizonDays)
            if (sectionRows.length === 0) return null
            return (
              <div key={section.horizonDays} className="space-y-3">
                <div className="border-l-4 border-[var(--color-market-red)] pl-3">
                  <div className="text-[14px] font-bold text-[var(--color-brand-900)]">{section.title} {section.horizonDays}営業日</div>
                  <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{section.body}</p>
                </div>
                <div className="grid gap-4 xl:grid-cols-3">
                  {GROUPS.map((group) => {
                    const items = sectionRows.filter((row) => row.direction === group.direction).slice(0, 3)
                    return (
                      <div key={`${section.horizonDays}-${group.direction}`} className="space-y-3">
                        <div>
                          <div className={`text-[14px] font-bold ${group.direction === 'down' ? 'text-blue-700' : group.direction === 'wait' ? 'text-slate-700' : 'text-red-700'}`}>{group.title}</div>
                          <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{group.body}</p>
                        </div>
                        <div className="grid gap-3">
                          {items.length > 0 ? items.map((candidate) => (
                            <PhysicsCandidateCard
                              key={`${candidate.direction}-${candidate.horizon_days}-${candidate.ticker}`}
                              candidate={candidate}
                              market={market}
                            />
                          )) : (
                            <div className="rounded-[4px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-4 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                              該当候補なし
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
