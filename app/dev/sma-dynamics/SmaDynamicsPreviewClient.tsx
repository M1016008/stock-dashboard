'use client'

// Renders the stock-detail SMA Dynamics Lab from synthetic fixtures only. The real
// SmaDynamicsSection runs with an injected fixture adapter: no fetch, no API, no database.
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { SmaDynamicsSection, type SmaDynamicsHistorySource } from '@/components/stock/sma-dynamics/SmaDynamicsSection'
import { SMA_DYNAMICS_DEFAULT_SETTINGS, type SmaDynamicsSettings, type SmaExternalScenarioInput, type SmaScenarioHandoff } from '@/components/stock/sma-dynamics/SmaDynamicsView'
import { scenarioFixtureSet, SMA_SCENARIO_FIXTURE_CALENDAR_VERSION } from '@/lib/sma-dynamics-scenario-fixtures'
import { parseScenarioEvidence } from '@/lib/sma-dynamics-scenario-evidence'
import { normalizeSmaLabPeriods, SMA_LAB_FOCUS_OPTIONS, SMA_LAB_RANGES, smaLabDefaultHorizon, smaLabHorizonOptions } from '@/lib/sma-dynamics-lab'
import { parseSmaDynamicsLink, type SmaLinkIntent } from '@/lib/sma-dynamics-link'
import { isSmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import { SMA_LAB_ANALYSIS_MODES } from '@/lib/sma-dynamics-scenario'
import { SMA_DYNAMICS_FIXTURES, type SmaDynamicsFixture } from '@/lib/sma-dynamics-fixtures'

export type PreviewLoadMode = 'ready' | 'loading' | 'error' | 'unconnected'

const PREVIEW_MODES: Array<{ id: PreviewLoadMode; label: string }> = [
  { id: 'ready', label: '通常' },
  { id: 'loading', label: '読み込み中' },
  { id: 'error', label: '取得失敗' },
  { id: 'unconnected', label: '未接続' },
]

const FIXTURE_DELAY_MS = 120

function fixtureFor(market: string, ticker: string): SmaDynamicsFixture | undefined {
  return SMA_DYNAMICS_FIXTURES.find((item) => item.market === market && item.ticker === ticker)
}

function buildFixtureSource(mode: Exclude<PreviewLoadMode, 'unconnected'>): SmaDynamicsHistorySource {
  return {
    id: `fixture:${mode}`,
    label: '合成Fixture (開発用・ネットワーク非接続)',
    priceBasis: () => '合成データ',
    load: (identity, signal) => new Promise((resolve, reject) => {
      if (mode === 'loading') return
      const timer = window.setTimeout(() => {
        if (mode === 'error') reject(new Error('HTTP 500 (preview)'))
        else resolve(fixtureFor(identity.market, identity.ticker)?.rows ?? [])
      }, FIXTURE_DELAY_MS)
      signal.addEventListener('abort', () => window.clearTimeout(timer))
    }),
  }
}

// Stable identities so switching securities exercises the real keyed reset, not a remount.
const FIXTURE_SOURCES: Record<PreviewLoadMode, SmaDynamicsHistorySource | null> = {
  ready: buildFixtureSource('ready'),
  loading: buildFixtureSource('loading'),
  error: buildFixtureSource('error'),
  unconnected: null,
}

export interface PreviewQuery {
  fixtureId: string
  mode: PreviewLoadMode
  settings: SmaDynamicsSettings
  maximized: boolean
  /** Phase 3B scenario candidate selected on load (validated by the lab like a click). */
  scenarioId: string | null
  /** The shared link contract (smalab=1&...): opens the lab like a link from the six-stage candidate list. */
  linkIntent: SmaLinkIntent | null
}

/**
 * Deep-link for review/screenshots, e.g. ?fixture=us-falling&tf=1W&focus=future&horizon=5&sma=5,25&max=1&lab=solver
 * or ?fixture=jp-rising&scenario=jp-template-continuation (opens the Scenario Analysis state at the scenario's horizon).
 */
export function parsePreviewQuery(search: string): PreviewQuery {
  const params = new URLSearchParams(search)
  const fixtureId = SMA_DYNAMICS_FIXTURES.some((item) => item.id === params.get('fixture')) ? params.get('fixture')! : SMA_DYNAMICS_FIXTURES[0].id
  const scenario = scenarioFixtureSet(fixtureId)?.candidates.find((candidate) => candidate.id === params.get('scenario')) ?? null
  const parsedScenario = scenario ? parseScenarioEvidence(scenario.envelope) : null
  const scenarioHorizon = parsedScenario?.ok ? parsedScenario.envelope.forecastHorizonBars : null
  const mode = PREVIEW_MODES.find((item) => item.id === params.get('mode'))?.id ?? 'ready'
  const tf = params.get('tf')
  const timeframe = isSmaLabTimeframeId(tf) ? tf : SMA_DYNAMICS_DEFAULT_SETTINGS.timeframe
  const horizon = scenarioHorizon ?? Number(params.get('horizon'))
  // Any integer SMA period 3..300 is accepted; anything else is dropped.
  const periods = normalizeSmaLabPeriods((params.get('sma') ?? '').split(',').map((token) => (/^\d{1,3}$/.test(token.trim()) ? Number(token) : Number.NaN)))
  return {
    fixtureId,
    mode,
    maximized: params.get('max') === '1',
    scenarioId: scenario?.id ?? null,
    linkIntent: parseSmaDynamicsLink(params),
    settings: {
      timeframe,
      periods: params.has('sma') ? periods : SMA_DYNAMICS_DEFAULT_SETTINGS.periods,
      range: SMA_LAB_RANGES.find((item) => item.id === params.get('range'))?.id ?? SMA_DYNAMICS_DEFAULT_SETTINGS.range,
      horizon: smaLabHorizonOptions(timeframe).includes(horizon) ? horizon : timeframe === SMA_DYNAMICS_DEFAULT_SETTINGS.timeframe ? SMA_DYNAMICS_DEFAULT_SETTINGS.horizon : smaLabDefaultHorizon(timeframe),
      focus: SMA_LAB_FOCUS_OPTIONS.find((item) => item.id === params.get('focus'))?.id ?? 'both',
      analysis: scenario ? 'scenario' : SMA_LAB_ANALYSIS_MODES.find((item) => item.id === params.get('lab'))?.id ?? SMA_DYNAMICS_DEFAULT_SETTINGS.analysis,
      compare: [...SMA_DYNAMICS_DEFAULT_SETTINGS.compare],
    },
  }
}

export function SmaDynamicsPreviewClient() {
  const [query, setQuery] = useState<PreviewQuery | null>(null)
  useEffect(() => setQuery(parsePreviewQuery(window.location.search)), [])
  if (!query) return null
  return <PreviewBody query={query} />
}

function PreviewBody({ query }: { query: PreviewQuery }) {
  const [fixtureId, setFixtureId] = useState(query.fixtureId)
  const [mode, setMode] = useState<PreviewLoadMode>(query.mode)
  const fixture = SMA_DYNAMICS_FIXTURES.find((item) => item.id === fixtureId) ?? SMA_DYNAMICS_FIXTURES[0]
  const [lastHandoff, setLastHandoff] = useState<SmaScenarioHandoff | null>(null)
  // Phase 3B: synthetic scenario evidence exists only for some price fixtures; the others render the default lab.
  const externalScenarios = useMemo((): SmaExternalScenarioInput | undefined => {
    const set = scenarioFixtureSet(fixture.id)
    return set ? {
      candidates: set.candidates,
      historyBasis: set.historyBasis,
      securityPermanentId: { status: 'unavailable', reason: '合成Fixtureには恒久IDがありません' },
      calendarVersion: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION,
      onHandoff: setLastHandoff,
      initialSelectedId: fixture.id === query.fixtureId ? query.scenarioId ?? undefined : undefined,
    } : undefined
  }, [fixture.id, query.fixtureId, query.scenarioId])

  return (
    <div className="flex min-w-0 flex-col gap-3 pb-6">
      <div className="border-b border-[var(--color-border-default)] pb-3">
        <p className="m-0 text-[12px] font-bold text-[var(--color-brand-700)]">開発用プレビュー ・ 合成データのみ ・ Production非接続</p>
        {/* Mirrors the stock-detail header so the lab is reviewed in context. */}
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1" data-preview-security>
          <span className="font-mono text-[22px] font-bold leading-none text-[var(--color-brand-800)]">{fixture.ticker}</span>
          <span className="text-[18px] font-bold leading-tight text-[var(--color-text-primary)]">{fixture.name}</span>
          <span className="rounded-[var(--radius-sm)] border border-[var(--color-border-default)] px-1.5 text-[11px] font-bold text-[var(--color-text-secondary)]">{fixture.market}</span>
          {fixture.analysisDate && <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">分析基準日 {fixture.analysisDate}</span>}
        </div>
      </div>

      <SmaDynamicsSection
        market={fixture.market}
        ticker={fixture.ticker}
        name={fixture.name}
        analysisDate={fixture.analysisDate}
        source={FIXTURE_SOURCES[mode]}
        defaultOpen
        persistOpenPreference={false}
        defaultMaximized={query.maximized}
        initialSettings={query.settings}
        externalScenarios={externalScenarios}
        linkIntent={query.linkIntent}
      />

      <details className="group rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)]" data-preview-developer-panel>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[12px] font-bold text-[var(--color-text-secondary)] sm:min-h-9 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={13} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
          開発者パネル (Fixture・読み込み状態)
        </summary>
        <div className="flex flex-col gap-2.5 border-t border-[var(--color-border-soft)] px-3 py-3">
          <label className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
            Fixture (銘柄切替のシミュレーション)
            <select
              aria-label="Fixture (銘柄切替のシミュレーション)"
              value={fixture.id}
              onChange={(event) => setFixtureId(event.target.value)}
              className="min-h-11 min-w-0 max-w-full rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2 text-[12px] sm:min-h-8"
            >
              {SMA_DYNAMICS_FIXTURES.map((item) => (
                <option key={item.id} value={item.id}>{item.market} {item.ticker} ・ {item.label}</option>
              ))}
            </select>
          </label>
          <div role="group" aria-label="読み込み状態" className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[12px] font-bold text-[var(--color-text-secondary)]">読み込み状態</span>
            {PREVIEW_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="btn"
                data-size="sm"
                data-variant={mode === item.id ? 'primary' : undefined}
                aria-pressed={mode === item.id}
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="m-0 text-[12px] font-medium text-[var(--color-text-secondary)]">
            {fixture.market} ・ {fixture.description}
            {fixture.analysisDate && <span className="font-mono"> ・ analysisDate={fixture.analysisDate}</span>}
          </p>
          <p className="m-0 text-[12px] font-medium text-[var(--color-text-secondary)]" data-preview-scenario-evidence>
            シナリオFixture: {externalScenarios ? `${externalScenarios.candidates.length}件 (合成・Phase 3B)` : 'なし (この銘柄では従来表示)'}
            {lastHandoff && <span className="font-mono"> ・ 最後の引き継ぎ {lastHandoff.candidateId} → {lastHandoff.target} ({lastHandoff.closes.length}本)</span>}
          </p>
        </div>
      </details>
    </div>
  )
}
