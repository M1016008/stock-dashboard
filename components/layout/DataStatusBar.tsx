'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, CheckCircle2, Database, Maximize2, Minimize2, RefreshCw, TriangleAlert } from 'lucide-react'
import {
  marketPriceCoverageNeedsAttention,
  supplementalSourceNeedsAttention,
} from '@/lib/status-health'

type MarketStatus = {
  expected: string
  price: string | null
  analyticsPrice?: string | null
  pms: string | null
  features: string | null
  candidates: string | null
  physicsCandidates: string | null
  dashboardCache: string | null
  predictions: string | null
  similars: string | null
  priceBasis?: string | null
  derivedPriceBasis?: string | null
  analogPriceBasis?: string | null
  expectedPriceBasis?: string | null
  coverage?: {
    universe: number
    price: number
    pricePct: number | null
    priceProcessed?: number
    priceProcessedPct?: number | null
    priceUnavailable?: number
    priceDeferred?: number
    priceProcessingComplete?: boolean
    pms: number
    pmsPct: number | null
    pmsEligible?: number
    features: number
    featuresPct: number | null
    featuresEligible?: number
    analyticsUniverse?: number
    analyticsPrice?: number
    analyticsEligible?: number
    analyticsPricePct?: number | null
    partial: boolean
    analyticsPartial?: boolean
    pmsComplete?: boolean
    featuresComplete?: boolean
  }
  ingestionRun?: {
    status: string
    totalTickers: number
    succeeded: number
    failed: number
    rowsInserted: number
    unavailable?: number
    deferred?: number
    startedAt: string
    finishedAt: string | null
  } | null
  fresh: boolean
}

type RunningJobStatus = {
  market: 'JP' | 'US'
  jobType: string
  startedAt: string
  totalTickers: number
  succeeded: number
  failed: number
  rowsInserted: number
  progressPct: number | null
  elapsedMinutes: number
  etaMinutes: number | null
  stage?: string | null
  heartbeatAt?: string | null
}

type StatusPayload = {
  status: 'ok' | 'attention' | 'unavailable'
  checkedAt: string
  jp?: MarketStatus
  us?: MarketStatus
  sources?: Record<'themes' | 'materials' | 'earnings' | 'usEarnings', SourceStatus>
  runningJobs?: RunningJobStatus[]
  message?: string
}

type SourceStatus = {
  updatedAt: string | null
  ageHours: number | null
  fresh: boolean
  configured?: boolean
  optional?: boolean
  provider?: string
}

type Density = 'compact' | 'comfortable'

function formatPct(value: number) {
  return `${(Math.round((value + Number.EPSILON) * 10) / 10).toFixed(1)}%`
}

function statusText(status?: MarketStatus) {
  if (!status?.price) return '未取得'
  if (marketPriceCoverageNeedsAttention(status.coverage)) {
    return `${status.price} / ${formatPct(status.coverage?.pricePct ?? 0)}`
  }
  return status.fresh ? status.price : `${status.price} / 期待 ${status.expected ?? '-'}`
}

function sourceTime(value: string | null) {
  if (!value) return '未取得'
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tokyo',
  }).format(new Date(value))
}

function durationText(minutes: number | null) {
  if (minutes == null || !Number.isFinite(minutes)) return '-'
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}分`
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return rest > 0 ? `${hours}時間${rest}分` : `${hours}時間`
}

function ingestionStatusLabel(status: string) {
  if (status === 'success') return '完了'
  if (status === 'partial') return '一部完了'
  if (status === 'failed') return '失敗'
  if (status === 'running') return '実行中'
  return '状態確認中'
}

const STAGE_LABELS: Record<string, string> = {
  targets: '対象銘柄を確認',
  snapshots: '調整後価格スナップショットを再構築',
  source_snapshots: '調整後価格スナップショットを再構築',
  analytics_copy: '調整後価格を新世代DBへ複製',
  features_models: '全特徴量・PMS・モデルを再構築',
  analog_index: '類似索引を再構築',
  validation: '新世代DBの整合性を検証',
  promoting: '検証済み世代へ切替',
  starting: '開始準備',
}

function jobLabel(job: RunningJobStatus) {
  if (job.stage && STAGE_LABELS[job.stage]) return STAGE_LABELS[job.stage]
  if (job.jobType === 'snapshot_compute') return '調整後価格スナップショットを再構築'
  if (job.jobType.startsWith('us_adjusted_foundation')) {
    return '調整後価格・特徴量・類似索引を世代移行'
  }
  return job.jobType
}

export function DataStatusBar() {
  const [payload, setPayload] = useState<StatusPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [density, setDensity] = useState<Density>('comfortable')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/status/overview', { cache: 'no-store' })
      const data = await response.json() as StatusPayload
      setPayload(data)
    } catch {
      setPayload({
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        message: 'データ鮮度を取得できませんでした。',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const saved = window.localStorage.getItem('stockboard_density')
    const initial: Density = saved === 'compact' ? 'compact' : 'comfortable'
    setDensity(initial)
    document.body.dataset.density = initial
    void load()
    const timer = window.setInterval(() => void load(), 5 * 60 * 1_000)
    return () => window.clearInterval(timer)
  }, [load])

  const toggleDensity = () => {
    const next: Density = density === 'compact' ? 'comfortable' : 'compact'
    setDensity(next)
    document.body.dataset.density = next
    window.localStorage.setItem('stockboard_density', next)
  }

  const isOk = payload?.status === 'ok'
  const hasSourceAttention = Boolean(
    payload?.sources && Object.values(payload.sources).some(supplementalSourceNeedsAttention),
  )
  const hasAttention = !isOk || hasSourceAttention
  const StatusIcon = hasAttention ? TriangleAlert : CheckCircle2
  const usGenerationJob = payload?.runningJobs?.find((job) => (
    job.market === 'US'
    && (job.jobType === 'snapshot_compute' || job.jobType.startsWith('us_adjusted_foundation'))
  ))

  return (
    <div className="border-b border-[var(--color-border-soft)] bg-white">
      <div className="relative mx-auto flex min-h-7 w-full max-w-[1480px] items-center justify-between gap-3 px-5 sm:px-8 lg:px-10 xl:px-12">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 items-center gap-2 py-1 text-left text-[10px] font-bold text-[var(--color-text-secondary)]"
          aria-expanded={open}
          title="データ鮮度の詳細"
        >
          <Database size={12} className="shrink-0 text-[var(--color-brand-700)]" />
          <span className="hidden sm:inline">データ鮮度</span>
          <span className="inline-flex items-center gap-1">
            <StatusIcon
              size={12}
              className={hasAttention ? 'text-amber-700' : 'text-emerald-700'}
            />
            JP {statusText(payload?.jp)}
          </span>
          <span className="text-[var(--color-border-strong)]">|</span>
          <span>US {statusText(payload?.us)}</span>
          {hasSourceAttention && (
            <span className="hidden text-amber-800 sm:inline">
              {payload?.runningJobs?.length ? '補完データ更新待ち' : '補完データ要確認'}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleDensity}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
            title={density === 'compact' ? '標準密度にする' : 'コンパクト表示にする'}
            aria-label={density === 'compact' ? '標準密度にする' : 'コンパクト表示にする'}
          >
            {density === 'compact' ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-50"
            title="鮮度を再確認"
            aria-label="鮮度を再確認"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {open && (
          <div className="absolute left-5 top-[calc(100%+6px)] z-[65] w-[min(660px,calc(100vw-40px))] border border-[var(--color-border-strong)] bg-white p-3 shadow-[0_14px_34px_rgba(16,32,52,0.2)] sm:left-8">
            <div className="grid gap-3 sm:grid-cols-2">
              <StatusDetail label="日本株" status={payload?.jp} />
              <StatusDetail label="米国株" status={payload?.us} generationJob={usGenerationJob} />
            </div>
            <div className="mt-3 border border-[var(--color-border-soft)] bg-white p-2.5">
              <div className="mb-2 text-[11px] font-black text-[var(--color-brand-900)]">補完データ</div>
              <div className="grid gap-1.5 sm:grid-cols-4">
                <SourceDetail label="テーマ" status={payload?.sources?.themes} />
                <SourceDetail label="材料" status={payload?.sources?.materials} />
                <SourceDetail label="JP決算" status={payload?.sources?.earnings} />
                <SourceDetail label="US決算" status={payload?.sources?.usEarnings} />
              </div>
            </div>
            {payload?.runningJobs && payload.runningJobs.length > 0 && (
              <div className="mt-3 border border-blue-200 bg-blue-50 p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] font-black text-blue-900">
                  <Activity size={13} />
                  バックグラウンド更新中
                </div>
                <div className="mt-2 grid gap-1.5">
                  {payload.runningJobs.map((job) => (
                    <div
                      key={`${job.market}-${job.jobType}-${job.startedAt}`}
                      className="border border-blue-200 bg-white px-2 py-1.5 text-[9px] font-bold text-blue-900"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span>{job.market} / {jobLabel(job)}</span>
                        <span className="font-mono">
                          {job.progressPct == null
                            ? sourceTime(job.startedAt)
                            : `${job.succeeded.toLocaleString()} / ${job.totalTickers.toLocaleString()} (${formatPct(job.progressPct)})`}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-3 text-[8px] text-blue-700">
                        <span>経過 {durationText(job.elapsedMinutes)}</span>
                        <span>{job.etaMinutes == null ? '完了時刻を算出中' : `残り目安 ${durationText(job.etaMinutes)}`}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {payload?.message && (
              <div className="mt-2 text-[11px] font-bold text-amber-800">{payload.message}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SourceDetail({ label, status }: { label: string; status?: SourceStatus }) {
  const unconfigured = status?.configured === false
  return (
    <div className="flex items-center justify-between gap-2 bg-[var(--color-surface-subtle)] px-2 py-1.5 text-[10px]">
      <span className="font-black text-[var(--color-text-secondary)]">{label}</span>
      <span className={`text-right font-mono font-bold ${
        unconfigured
          ? 'text-[var(--color-text-tertiary)]'
          : status?.fresh
            ? 'text-emerald-700'
            : 'text-amber-800'
      }`}>
        {unconfigured
          ? status.optional ? '未設定（任意）' : '未設定'
          : sourceTime(status?.updatedAt ?? null)}
      </span>
    </div>
  )
}

function StatusDetail({
  label,
  status,
  generationJob,
}: {
  label: string
  status?: MarketStatus
  generationJob?: RunningJobStatus
}) {
  const rows = [
    ['期待営業日', status?.expected],
    [status?.analyticsPrice !== undefined ? '価格取得' : '価格', status?.price],
    ...(status?.analyticsPrice !== undefined ? [['分析DB価格', status.analyticsPrice]] : []),
    ['PMS/PFS/PES', status?.pms],
    ['特徴量', status?.features],
    ['ML候補', status?.candidates],
    ['Physics候補', status?.physicsCandidates],
    ['予測', status?.predictions],
    ['類似局面', status?.similars],
    ['キャッシュ', status?.dashboardCache],
  ]
  return (
    <div className="border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-2.5">
      <div className="mb-2 flex items-center justify-between text-[11px] font-black text-[var(--color-brand-900)]">
        <span>{label}</span>
        <span className={status?.fresh ? 'text-emerald-700' : 'text-amber-700'}>
          {status?.fresh ? '整合' : '要確認'}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="font-bold text-[var(--color-text-tertiary)]">{name}</dt>
            <dd className="text-right font-mono font-semibold text-[var(--color-text-primary)]">{value ?? '-'}</dd>
          </div>
        ))}
      </dl>
      {status?.coverage && (
        <div className="mt-2 border-t border-[var(--color-border-default)] pt-2">
          <div className="mb-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
            カバレッジ / 投資対象 {status.coverage.universe.toLocaleString()}
          </div>
          <div className="grid grid-cols-2 gap-1 text-center text-[9px]">
            {[
              ...(status.coverage.priceProcessed !== undefined
                ? [['取得確認', status.coverage.priceProcessed, status.coverage.priceProcessedPct, status.coverage.universe] as const]
                : []),
              ['当日価格', status.coverage.price, status.coverage.pricePct, status.coverage.universe] as const,
              ...(status.coverage.analyticsPrice !== undefined
                ? [['分析反映', status.coverage.analyticsPrice, status.coverage.analyticsPricePct, status.coverage.analyticsEligible] as const]
                : []),
              ['PMS', status.coverage.pms, status.coverage.pmsPct, status.coverage.pmsEligible] as const,
              ['特徴量', status.coverage.features, status.coverage.featuresPct, status.coverage.featuresEligible] as const,
            ].map(([name, count, pct, denominator]) => (
              <div key={String(name)} className="bg-white px-1 py-1">
                <div className="font-black text-[var(--color-text-tertiary)]">{name}</div>
                <div className="font-mono font-bold text-[var(--color-text-primary)]">
                  {typeof pct === 'number' ? formatPct(pct) : '-'}
                </div>
                <div className="font-mono text-[8px] text-[var(--color-text-tertiary)]">
                  {typeof count === 'number' ? count.toLocaleString() : '-'}
                  {typeof denominator === 'number' ? ` / ${denominator.toLocaleString()}` : ''}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 text-[8px] leading-relaxed text-[var(--color-text-tertiary)]">
            PMS・特徴量は、必要な履歴と計算項目が揃う算出可能銘柄を分母にしています。
            当日価格は休止・無取引銘柄を含むため100%未満になる場合があります。
          </div>
          {status.ingestionRun && (
            <div className={`mt-1.5 px-2 py-1 text-[9px] font-bold ${
              status.ingestionRun.status === 'success'
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-amber-50 text-amber-800'
            }`}>
              直近取得 {ingestionStatusLabel(status.ingestionRun.status)}
              {' / '}取得完了 {status.ingestionRun.succeeded.toLocaleString()}
              {status.ingestionRun.failed > 0 ? ` / 失敗 ${status.ingestionRun.failed.toLocaleString()}` : ''}
              {(status.ingestionRun.unavailable ?? 0) > 0 ? ` / データなし ${status.ingestionRun.unavailable?.toLocaleString()}` : ''}
              {(status.ingestionRun.deferred ?? 0) > 0 ? ` / 保留 ${status.ingestionRun.deferred?.toLocaleString()}` : ''}
            </div>
          )}
        </div>
      )}
      {status?.expectedPriceBasis && (
        status.priceBasis !== status.expectedPriceBasis
        || status.derivedPriceBasis !== status.expectedPriceBasis
        || status.analogPriceBasis !== status.expectedPriceBasis
      ) && (
        <div className="mt-2 border-t border-amber-200 bg-amber-50 px-2 py-1.5 text-[9px] font-bold text-amber-900">
          {generationJob
            ? `世代移行中: ${jobLabel(generationJob)}${
              generationJob.progressPct == null ? '' : ` (${formatPct(generationJob.progressPct)})`
            } / 経過 ${durationText(generationJob.elapsedMinutes)}`
            : '世代移行は未完了です。鮮度監視が安全な分離DBで自動再開します。'}
        </div>
      )}
    </div>
  )
}
