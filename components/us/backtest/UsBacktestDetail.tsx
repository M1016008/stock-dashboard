'use client'

// components/us/backtest/UsBacktestDetail.tsx
//
// 結果行を展開したときの詳細。detail API の値を並べるだけで、原因や見通しの文章は作らない
// (API も generatedNarrative=false)。
// - 上昇/下落の切替で、選択結果・チャート範囲 (結果日まで) を取り直す
// - リクエストは AbortController で打ち切り、取得済みの組み合わせは再利用する

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, ExternalLink } from 'lucide-react'
import { fmtUsd, usStockHref } from '@/components/us/UsMarketMomentumParts'
import { HitFlags, Missing, SignedPct, StageRow } from '@/components/us/backtest/UsBacktestParts'
import { UsBacktestOutcomeChart } from '@/components/us/backtest/UsBacktestOutcomeChart'
import {
  FOCUS_RING,
  MUTED_TEXT,
  fetchJson,
  fmtRatio,
  fmtReasonValue,
  isAbortError,
  type UsBacktestDetailResponse,
  type UsBacktestMove,
  type UsBacktestResult,
} from '@/components/us/backtest/usBacktestShared'

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: UsBacktestDetailResponse }

export function UsBacktestDetail({
  row,
  initialMove,
  id,
}: {
  row: UsBacktestResult
  initialMove: UsBacktestMove
  id: string
}) {
  const [move, setMove] = useState<UsBacktestMove>(initialMove)
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [retry, setRetry] = useState(0)
  const cache = useRef(new Map<string, UsBacktestDetailResponse>())
  const key = `${row.ticker}|${row.date}|${row.horizonDays}|${move}`

  useEffect(() => {
    const cached = cache.current.get(key)
    if (cached) {
      setState({ status: 'ready', data: cached })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })
    const params = new URLSearchParams({ ticker: row.ticker, date: row.date, horizon: String(row.horizonDays), move })
    fetchJson<UsBacktestDetailResponse>(`/api/us/backtest/detail?${params}`, controller.signal)
      .then((data) => {
        cache.current.set(key, data)
        setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        setState({ status: 'error', message: (error as Error).message })
      })
    return () => controller.abort()
  }, [key, row.ticker, row.date, row.horizonDays, move, retry])

  const data = state.status === 'ready' ? state.data : null
  const result = data?.result ?? row
  const outcome = data?.selectedOutcome
  const moveLabel = move === 'down' ? '最大下落' : '最大上昇'

  return (
    <div id={id} className="min-w-0 bg-[var(--color-surface-subtle)] px-3 py-3 sm:px-4" aria-busy={state.status === 'loading'}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="inline-flex h-7 overflow-hidden rounded-[4px] border border-[var(--color-border-default)] bg-white" role="group" aria-label="表示する値動き">
          <MoveButton active={move === 'up'} onClick={() => setMove('up')} icon={<ArrowUpRight size={13} aria-hidden />}>上昇</MoveButton>
          <MoveButton active={move === 'down'} onClick={() => setMove('down')} icon={<ArrowDownRight size={13} aria-hidden />}>下落</MoveButton>
        </div>
        <p className="min-w-0 text-[12px] text-[var(--color-text-primary)]">
          <span className={MUTED_TEXT}>選択結果 </span>
          <strong className="font-semibold">{moveLabel}</strong>{' '}
          {outcome ? (
            <>
              <SignedPct value={outcome.returnPct} className="font-semibold" />
              <span className={MUTED_TEXT}> · </span>
              <span className="font-mono tabular-nums">{outcome.date ?? <Missing />}</span>
              <span className={MUTED_TEXT}> · 基準日から </span>
              <span className="font-mono tabular-nums">{outcome.sessions ?? <Missing />}</span>
              <span className={MUTED_TEXT}>営業日</span>
            </>
          ) : state.status === 'loading' ? <span className={MUTED_TEXT}>読み込み中</span> : <Missing />}
        </p>
        <Link
          href={usStockHref(row.ticker, row.date)}
          prefetch={false}
          className={`ml-auto inline-flex items-center gap-1 rounded-[3px] text-[11px] font-medium text-[var(--color-brand-700)] hover:underline ${FOCUS_RING}`}
        >
          {row.ticker} を基準日で開く
          <ExternalLink size={12} aria-hidden />
        </Link>
      </div>

      {state.status === 'error' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[4px] border border-[#f0b8b8] bg-[var(--color-price-up-bg)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]" role="alert">
          <span className="min-w-0 flex-1">{state.message}</span>
          <button type="button" onClick={() => setRetry((value) => value + 1)} className={`rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 py-0.5 text-[11px] font-semibold text-[var(--color-brand-700)] ${FOCUS_RING}`}>
            再試行
          </button>
        </div>
      )}

      <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
        <div className="min-w-0">
          {data ? (
            <UsBacktestOutcomeChart
              key={key}
              points={data.chart}
              basisDate={result.date}
              basisClose={result.close}
              outcomeDate={data.selectedOutcome.date}
              outcomeReturnPct={data.selectedOutcome.returnPct}
              move={move}
            />
          ) : (
            <div className="h-[244px] animate-pulse rounded-[4px] bg-[var(--color-surface-muted)]" aria-hidden />
          )}
          {data && data.chart.length > 0 && (
            <p className={`mt-1 text-[10px] ${MUTED_TEXT}`}>
              表示範囲 {data.chart[0].date} 〜 {data.chart[data.chart.length - 1].date}
              {data.selectedOutcome.date ? `（${moveLabel}日まで）` : `（${moveLabel}日が未取得のため基準日まで）`}
            </p>
          )}
        </div>

        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 gap-y-1 text-[12px]">
          <FactRow label="基準日">{result.date}</FactRow>
          <FactRow label="基準日終値">{result.close == null ? <Missing /> : fmtUsd(result.close)}</FactRow>
          <FactRow label={`期間騰落（${result.horizonDays}営業日）`}><SignedPct value={result.returnPct} /></FactRow>
          <FactRow label="最大上昇">
            <SignedPct value={result.maxReturnPct} />
            <span className={`ml-1 text-[10px] ${MUTED_TEXT}`}>{result.maxReturnDate ?? ''}{result.daysToMax != null ? ` · ${result.daysToMax}営業日` : ''}</span>
          </FactRow>
          <FactRow label="最大下落">
            <SignedPct value={result.minReturnPct} />
            <span className={`ml-1 text-[10px] ${MUTED_TEXT}`}>{result.minReturnDate ?? ''}{result.daysToMin != null ? ` · ${result.daysToMin}営業日` : ''}</span>
          </FactRow>
          <FactRow label="到達"><HitFlags hits={[[10, result.hit10], [20, result.hit20], [40, result.hit40]]} /></FactRow>
          <FactRow label="6ステージ">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <StageRow stages={result.stages} />
              {result.patternCode && <span className={`font-mono text-[11px] ${MUTED_TEXT}`}>{result.patternCode}</span>}
            </span>
          </FactRow>
          <FactRow label="出来高倍率(20)">{fmtRatio(result.volumeRatio20) ?? <Missing />}</FactRow>
          <FactRow label="値幅 / ATR20">
            <PlainPct value={result.rangePct} /><span className={MUTED_TEXT}> / </span><PlainPct value={result.atr20Pct} />
          </FactRow>
          <FactRow label="MA乖離 5/25/75">
            <SignedPct value={result.ma5PosPct} /><span className={MUTED_TEXT}> / </span>
            <SignedPct value={result.ma25PosPct} /><span className={MUTED_TEXT}> / </span>
            <SignedPct value={result.ma75PosPct} />
          </FactRow>
        </dl>
      </div>

      <section className="mt-3 border-t border-[var(--color-border-soft)] pt-2" aria-label="シグナル根拠">
        <h4 className="text-[11px] font-semibold text-[var(--color-text-secondary)]">シグナル根拠（基準日 {result.date}）</h4>
        {result.signalCodes.length === 0 ? (
          <p className={`mt-1 text-[11px] ${MUTED_TEXT}`}>この基準日に記録されたシグナルはありません。</p>
        ) : (
          <ul className="mt-1 grid min-w-0 gap-x-6 gap-y-2 md:grid-cols-2">
            {result.signalCodes.map((code) => {
              const evidence = data?.evidence.find((item) => item.signalCode === code)
              return (
                <li key={code} className="min-w-0 text-[11px]">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-mono font-semibold text-[var(--color-text-primary)]">{code}</span>
                    {evidence?.label && <span className="text-[var(--color-text-secondary)]">{evidence.label}</span>}
                  </span>
                  {data == null
                    ? <span className={MUTED_TEXT}>{state.status === 'error' ? '根拠を取得できませんでした' : '読み込み中'}</span>
                    : evidence ? <ReasonView reason={evidence.reason} /> : <span className={MUTED_TEXT}>根拠データ未取得</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <p className={`mt-2 text-[10px] ${MUTED_TEXT}`}>
        過去の基準日時点のデータと、その後の実績値です。解説文は生成していません。将来の値動きの予測や売買推奨ではありません。
      </p>
    </div>
  )
}

function MoveButton({ active, onClick, icon, children }: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 border-l border-[var(--color-border-soft)] px-2.5 text-[11px] font-semibold first:border-l-0 ${FOCUS_RING} focus-visible:relative ${
        active ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className={`whitespace-nowrap text-[11px] leading-5 ${MUTED_TEXT}`}>{label}</dt>
      <dd className="m-0 min-w-0 font-mono leading-5 tabular-nums text-[var(--color-text-primary)]">{children}</dd>
    </>
  )
}

function PlainPct({ value }: { value: number | null }) {
  if (value == null) return <Missing />
  return <span className="font-mono tabular-nums">{value.toFixed(2)}%</span>
}

function ReasonView({ reason }: { reason: unknown }) {
  if (reason == null) return <span className={`block ${MUTED_TEXT}`}>根拠の詳細なし</span>
  if (typeof reason !== 'object' || Array.isArray(reason)) {
    return <span className="block break-words font-mono text-[var(--color-text-secondary)]">{fmtReasonValue(reason)}</span>
  }
  const entries = Object.entries(reason as Record<string, unknown>)
  if (entries.length === 0) return <span className={`block ${MUTED_TEXT}`}>根拠の詳細なし</span>
  return (
    <dl className="mt-0.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      {entries.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className={`font-mono ${MUTED_TEXT}`}>{name}</dt>
          <dd className="m-0 min-w-0 break-words font-mono text-[var(--color-text-secondary)]">{fmtReasonValue(value)}</dd>
        </div>
      ))}
    </dl>
  )
}
