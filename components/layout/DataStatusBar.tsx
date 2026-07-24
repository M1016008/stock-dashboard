'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, CheckCircle2, Database, Maximize2, Minimize2, RefreshCw, TriangleAlert } from 'lucide-react'

type MarketStatus = {
  price: string | null
  pms: string | null
  features: string | null
  candidates: string | null
  physicsCandidates: string | null
  fresh: boolean
}

type StatusPayload = {
  status: 'ok' | 'attention' | 'unavailable'
  checkedAt: string
  jp?: MarketStatus
  us?: MarketStatus
  sources?: Record<'themes' | 'materials' | 'earnings', SourceStatus>
  runningJobs?: Array<{
    jobType: string
    startedAt: string
  }>
  message?: string
}

type SourceStatus = {
  updatedAt: string | null
  ageHours: number | null
  fresh: boolean
}

type Density = 'compact' | 'comfortable'

function statusText(status?: MarketStatus) {
  if (!status?.price) return '未取得'
  return status.fresh ? status.price : `${status.price} / ML ${status.candidates ?? '-'}`
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
    payload?.sources && Object.values(payload.sources).some((source) => !source.fresh),
  )
  const hasAttention = !isOk || hasSourceAttention
  const StatusIcon = hasAttention ? TriangleAlert : CheckCircle2

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
            <span className="hidden text-amber-800 sm:inline">補完データ要確認</span>
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
              <StatusDetail label="米国株" status={payload?.us} />
            </div>
            <div className="mt-3 border border-[var(--color-border-soft)] bg-white p-2.5">
              <div className="mb-2 text-[11px] font-black text-[var(--color-brand-900)]">補完データ</div>
              <div className="grid gap-1.5 sm:grid-cols-3">
                <SourceDetail label="テーマ" status={payload?.sources?.themes} />
                <SourceDetail label="材料" status={payload?.sources?.materials} />
                <SourceDetail label="決算" status={payload?.sources?.earnings} />
              </div>
            </div>
            {payload?.runningJobs && payload.runningJobs.length > 0 && (
              <div className="mt-3 border border-blue-200 bg-blue-50 p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] font-black text-blue-900">
                  <Activity size={13} />
                  バックグラウンド更新中
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {payload.runningJobs.map((job) => (
                    <span key={`${job.jobType}-${job.startedAt}`} className="border border-blue-200 bg-white px-2 py-1 font-mono text-[9px] font-bold text-blue-800">
                      {job.jobType} / {sourceTime(job.startedAt)}
                    </span>
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
  return (
    <div className="flex items-center justify-between gap-2 bg-[var(--color-surface-subtle)] px-2 py-1.5 text-[10px]">
      <span className="font-black text-[var(--color-text-secondary)]">{label}</span>
      <span className={`text-right font-mono font-bold ${status?.fresh ? 'text-emerald-700' : 'text-amber-800'}`}>
        {sourceTime(status?.updatedAt ?? null)}
      </span>
    </div>
  )
}

function StatusDetail({ label, status }: { label: string; status?: MarketStatus }) {
  const rows = [
    ['価格', status?.price],
    ['PMS/PFS/PES', status?.pms],
    ['特徴量', status?.features],
    ['ML候補', status?.candidates],
    ['Physics候補', status?.physicsCandidates],
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
    </div>
  )
}
