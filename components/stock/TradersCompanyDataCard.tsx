'use client'

import { Building2, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

type CompanyData = {
  ticker: string
  name: string | null
  featureSummary: string | null
  companyUrl: string | null
  listingDate: string | null
  fields: Record<string, string>
  sourceUrl: string
  fetchedAt: number
  stale: boolean
}

type CompanyDataResponse = {
  available: boolean
  source: string
  data: CompanyData | null
}

export function TradersCompanyDataCard({ ticker }: { ticker: string }) {
  const [response, setResponse] = useState<CompanyDataResponse | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/traders-company-data/${encodeURIComponent(ticker)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((result) => result.ok ? result.json() : null)
      .then((data) => setResponse(data as CompanyDataResponse | null))
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') setResponse(null)
      })
    return () => controller.abort()
  }, [ticker])

  const additionalFields = useMemo(() => {
    if (!response?.data?.fields) return []
    return Object.entries(response.data.fields)
      .filter(([label]) => !['URL', '上場日', '特色'].includes(label))
  }, [response])

  const data = response?.available ? response.data : null
  if (!data) return null

  return (
    <section className="card overflow-hidden p-0" aria-labelledby="traders-company-data-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Building2 size={15} className="text-[var(--color-brand-700)]" />
          <div>
            <h2 id="traders-company-data-title" className="text-[12px] font-black text-[var(--color-brand-900)]">
              企業データ
            </h2>
            <p className="text-[9px] font-bold text-[var(--color-text-tertiary)]">
              現在の企業基本情報
            </p>
          </div>
        </div>
        <a
          href={data.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[10px] font-black text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]"
        >
          トレーダーズ・ウェブ
          <ExternalLink size={11} />
        </a>
      </div>

      <div className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,0.8fr)]">
        {data.featureSummary && (
          <div className="min-w-0">
            <div className="mb-1 text-[9px] font-black text-[var(--color-text-tertiary)]">特色</div>
            <p className="text-[12px] font-semibold leading-6 text-[var(--color-text-primary)]">
              {data.featureSummary}
            </p>
          </div>
        )}
        <dl className={`grid content-start gap-x-3 gap-y-2 text-[10px] sm:grid-cols-[78px_minmax(0,1fr)] ${
          data.featureSummary
            ? 'border-t border-[var(--color-border-soft)] pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0'
            : 'lg:col-span-2'
        }`}>
          {data.companyUrl && (
            <>
              <dt className="font-bold text-[var(--color-text-tertiary)]">公式サイト</dt>
              <dd className="min-w-0">
                <a
                  href={data.companyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1 break-all font-black text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]"
                >
                  {data.companyUrl}
                  <ExternalLink size={10} className="shrink-0" />
                </a>
              </dd>
            </>
          )}
          {data.listingDate && (
            <>
              <dt className="font-bold text-[var(--color-text-tertiary)]">上場日</dt>
              <dd className="font-mono font-black text-[var(--color-text-primary)]">{data.listingDate}</dd>
            </>
          )}
          {additionalFields.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-bold text-[var(--color-text-tertiary)]">{label}</dt>
              <dd className="font-semibold text-[var(--color-text-primary)]">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="border-t border-[var(--color-border-soft)] px-3 py-1.5 text-[9px] font-bold text-[var(--color-text-tertiary)]">
        取得 {formatFetchedAt(data.fetchedAt)}
        {data.stale ? ' / 前回取得値を表示中' : ''}
      </div>
    </section>
  )
}

function formatFetchedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '-'
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(timestamp * 1000))
}
