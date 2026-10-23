'use client'

import { useMemo, useState } from 'react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { TwoYearLineFilterControl, TwoYearLineResultBadge } from '@/components/screener/TwoYearLineFilter'
import {
  buildTwoYearLineRegistry,
  matchesTwoYearLineQuery,
  selectTwoYearLineSummaryForQuery,
  type TwoYearLineFilter,
  type TwoYearLinePatternFilter,
  type TwoYearLineSummary,
} from '@/lib/two-year-line-registry'
import type { OHLCV } from '@/types/stock'

type PeriodShape = Readonly<{ startYear: number; open: number; close: number; months: number }>

const SHAPES: readonly PeriodShape[] = [
  { startYear: 2016, open: 100, close: 80, months: 24 },
  { startYear: 2018, open: 80, close: 102, months: 24 },
  { startYear: 2020, open: 132, close: 106, months: 24 },
  { startYear: 2022, open: 106, close: 124, months: 24 },
  { startYear: 2024, open: 124, close: 148, months: 24 },
  { startYear: 2026, open: 148, close: 172, months: 18 },
]

const HISTORY = SHAPES.flatMap(buildMonthlyFixture)
const MARKET_SESSIONS = HISTORY.map((row) => row.date)

export function TwoYearChartFixtureClient() {
  const [filter, setFilter] = useState<TwoYearLineFilter>('either')
  const [pattern, setPattern] = useState<TwoYearLinePatternFilter>('either')
  const [angleMin, setAngleMin] = useState('')
  const [angleMax, setAngleMax] = useState('')
  const query = {
    status: filter,
    pattern,
    minAngleDeg: angleMin.trim() ? Number(angleMin) : null,
    maxAngleDeg: angleMax.trim() ? Number(angleMax) : null,
  } as const
  const fixtureRows = useMemo(() => {
    const definitions = [
      { market: 'JP' as const, ticker: 'JP-CONFIRMED', name: '最新確定3本型', history: HISTORY.filter((row) => row.date <= '2026-01-15'), asOfDate: '2026-01-15' },
      { market: 'JP' as const, ticker: 'JP-PROVISIONAL', name: '最新暫定4本型', history: HISTORY, asOfDate: MARKET_SESSIONS.at(-1)! },
      { market: 'US' as const, ticker: 'US-BOTH', name: '確定3本型・暫定4本型', history: HISTORY, asOfDate: MARKET_SESSIONS.at(-1)! },
      { market: 'US' as const, ticker: 'US-NONE', name: '該当なし', history: HISTORY.slice(0, 24), asOfDate: '2018-01-15' },
    ]
    return definitions.map((definition) => {
      const sessions = definition.history.map((row) => row.date)
      const registry = buildTwoYearLineRegistry({
        market: definition.market,
        securityKey: `fixture:${definition.market}:${definition.ticker}`,
        asOfDate: definition.asOfDate,
        priceBasisVersion: 'fixture-v1',
        history: definition.history,
        exchangeSessions: sessions,
      })
      return { ...definition, registry }
    })
  }, [])
  const filteredRows = fixtureRows
    .map((row) => ({ ...row, selected: selectTwoYearLineSummaryForQuery([row.registry.latestConfirmed, row.registry.latestProvisional].filter((value): value is TwoYearLineSummary => value !== null), query) }))
    .filter((row) => matchesTwoYearLineQuery([row.registry.latestConfirmed, row.registry.latestProvisional].filter((value): value is TwoYearLineSummary => value !== null), query))

  return (
    <main style={{ maxWidth: 1320, margin: '0 auto', padding: '20px 16px 48px' }}>
      <header style={{ marginBottom: 16 }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12, fontWeight: 700 }}>LOCAL FIXTURE / NO PRODUCTION DATA</p>
        <h1 style={{ margin: '4px 0 6px', fontSize: 24, letterSpacing: 0 }}>24か月足と上昇終値ライン</h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
          偶数年開始の2暦年ブロックです。確定ラインは実線、形成中の足から成立した暫定ラインは点線で表示します。
        </p>
      </header>
      <section style={{ border: '1px solid var(--color-border-default)', borderRadius: 8, background: '#fff', padding: 12 }}>
        <CandlestickChart
          ticker="FIXTURE-24M"
          market="JP"
          interval="D"
          height={560}
          historyData={HISTORY}
          marketSessions={MARKET_SESSIONS}
          marketAsOfDate={MARKET_SESSIONS.at(-1)}
          historyPeriod="all"
          showTwoYearLines
          showTimeframeSelector
          toolbarVariant="segmented"
          summaryVariant="strip"
        />
      </section>
      <section style={{ marginTop: 16, border: '1px solid var(--color-border-default)', borderRadius: 8, background: '#fff', padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: '0 0 4px', fontSize: 16, letterSpacing: 0 }}>検索条件との一致</h2>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12 }}>合成JP/USユニバース。Production通信は行いません。</p>
          </div>
          <TwoYearLineFilterControl
            value={filter}
            onChange={setFilter}
            pattern={pattern}
            onPatternChange={setPattern}
            angleMin={angleMin}
            angleMax={angleMax}
            onAngleMinChange={setAngleMin}
            onAngleMaxChange={setAngleMax}
          />
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }} data-testid="two-year-fixture-search-results">
          {filteredRows.map((row) => (
            <div key={`${row.market}:${row.ticker}`} className="grid gap-1 border-t border-[var(--color-border-soft)] pt-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-2">
              <span className="min-w-0"><b>{row.ticker}</b> <small style={{ color: 'var(--text-secondary)' }}>{row.name}</small></span>
              <TwoYearLineResultBadge
                status={row.selected?.status}
                pattern={row.selected?.pattern}
                periods={row.selected?.sourcePeriods}
                startClose={row.selected?.lineStartClose}
                endClose={row.selected?.lineEndClose}
                angleDeg={row.selected?.angleDeg}
                lastCandleRisePct={row.selected?.lastCandleRisePct}
                confirmedDistancePct={row.selected?.distancePct}
              />
            </div>
          ))}
          {filteredRows.length === 0 && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>該当する合成銘柄はありません。</p>}
        </div>
      </section>
    </main>
  )
}

function buildMonthlyFixture(shape: PeriodShape): OHLCV[] {
  return Array.from({ length: shape.months }, (_, index) => {
    const year = shape.startYear + Math.floor(index / 12)
    const month = (index % 12) + 1
    const progress = shape.months === 1 ? 1 : index / (shape.months - 1)
    const close = shape.open + (shape.close - shape.open) * progress
    const previous = index === 0
      ? shape.open
      : shape.open + (shape.close - shape.open) * ((index - 1) / (shape.months - 1))
    return {
      date: `${year}-${String(month).padStart(2, '0')}-15`,
      open: previous,
      high: Math.max(previous, close) + 3,
      low: Math.min(previous, close) - 3,
      close,
      volume: 1_000_000 + index * 10_000,
    }
  })
}
