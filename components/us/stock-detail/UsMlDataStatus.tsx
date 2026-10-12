'use client'

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { loadUsMlStatus } from './usMlStatusResource'

type UsMlStatusTone = 'ok' | 'info' | 'warn' | 'missing'

interface UsMlStatusItem {
  key: string
  label: string
  status: UsMlStatusTone
  badge: string
  date: string | null
  count: number | null
  detail: string
  evidence: string[]
}

interface UsMlStatusResponse {
  ok: boolean
  market: 'US'
  ticker: string
  dbAvailable: boolean
  requestedDate?: string | null
  featureSet: string
  modelType: string
  summary: {
    status: UsMlStatusTone
    label: string
    detail: string
    latestMarketDate?: string | null
    healthCheckDate?: string | null
  }
  items: UsMlStatusItem[]
}

function statusColor(status: UsMlStatusTone): string {
  if (status === 'ok') return '#047857'
  if (status === 'info') return '#0369a1'
  if (status === 'warn') return '#b45309'
  return 'var(--color-text-tertiary)'
}

/** 類似・MLタブ末尾の「データの準備状況」。一覧は折りたたみ、閉じた状態では結論と市場日だけを示す */
export function UsMlDataStatus({ ticker, analysisDate }: { ticker: string; analysisDate: string | null }) {
  const [data, setData] = useState<UsMlStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setData(null)
    const params = new URLSearchParams()
    if (analysisDate) params.set('date', analysisDate)
    const query = params.toString()
    const url = `/api/us/ml-status/${encodeURIComponent(ticker)}${query ? `?${query}` : ''}`
    loadUsMlStatus<UsMlStatusResponse>(url)
      .then((payload) => payload ?? Promise.reject(new Error('status unavailable')))
      .then((payload: UsMlStatusResponse) => {
        if (!cancelled) setData(payload)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker, analysisDate])

  const available = Boolean(data?.dbAvailable)
  const summaryText = loading
    ? '確認中…'
    : error
      ? `取得できませんでした(${error})`
      : !available
        ? '準備状況を確認できません。価格・チャートは別データで表示される場合があります。'
        : data?.summary.label ?? '-'
  const summaryColor = !loading && !error && available && data ? statusColor(data.summary.status) : 'var(--color-text-tertiary)'

  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white" aria-labelledby="us-ml-status-title">
      <h2 id="us-ml-status-title" className="m-0">
        <button
          type="button"
          className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left sm:min-h-9"
          aria-expanded={available ? open : undefined}
          aria-controls={available ? 'us-ml-status-details' : undefined}
          onClick={() => setOpen((current) => !current)}
          disabled={!available}
        >
          <ChevronRight
            size={13}
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform ${open ? 'rotate-90' : ''} ${available ? '' : 'invisible'}`}
            aria-hidden="true"
          />
          <span className="text-[12px] font-bold text-[var(--color-text-secondary)]">データの準備状況</span>
          <span className="min-w-0 text-[12px] font-semibold" style={{ color: summaryColor }}>
            {summaryText}
          </span>
          {available && data?.summary.latestMarketDate && (
            <span className="ml-auto font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">市場日 {data.summary.latestMarketDate}</span>
          )}
        </button>
      </h2>
      {available && data && (
        <div id="us-ml-status-details" hidden={!open} className="border-t border-[var(--color-border-soft)] px-3 py-3">
          <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">{data.summary.detail}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
            <span>{data.featureSet}</span>
            {data.summary.healthCheckDate && <span>健康診断 {data.summary.healthCheckDate}</span>}
            {analysisDate && <span>{analysisDate}時点</span>}
          </div>
          <ul className="m-0 mt-2 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)] p-0">
            {data.items.map((item) => (
              <li key={item.key} className="grid min-w-0 gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 sm:block">
                  <span className="block text-[12px] font-bold text-[var(--color-text-primary)]">{item.label}</span>
                  <span className="text-[11px] font-bold" style={{ color: statusColor(item.status) }}>{item.badge}</span>
                  <span className="block font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
                    {item.date ?? '日付なし'}{item.count != null ? ` / ${item.count.toLocaleString('en-US')}件` : ''}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">{item.detail}</p>
                  {item.evidence.length > 0 && (
                    <p className="m-0 mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">
                      {item.evidence.slice(0, 4).map((line) => <span key={line}>{line}</span>)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-2 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
            物理ML候補ランキングは「最新トップ候補」を示すため、全銘柄が候補入りするわけではありません。候補外でも、価格・6ステージ・PMS・特徴量・類似検索・観察プランは個別銘柄分析に利用できます。
          </p>
        </div>
      )}
    </section>
  )
}
