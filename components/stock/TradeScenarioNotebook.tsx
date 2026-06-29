'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { MarketCode } from '@/lib/markets'
import type { StockQuote } from '@/types/stock'
import type {
  TradeScenario,
  TradeScenarioConfidence,
  TradeScenarioDirection,
  TradeScenarioStatus,
} from '@/lib/trade-scenarios/types'

interface DateRange {
  startDate: string
  endDate: string
  sourceLabel?: string
}

interface TradeScenarioNotebookProps {
  ticker: string
  name: string
  market?: MarketCode
  quote: StockQuote | null
  selectedRange: DateRange | null
  context?: Record<string, string | null | undefined>
}

interface ScenarioFormState {
  direction: TradeScenarioDirection
  confidence: TradeScenarioConfidence
  horizonDays: string
  entryPlanPrice: string
  targetPrice: string
  stopLossPrice: string
  thesis: string
  invalidation: string
}

const DIRECTION_LABELS: Record<TradeScenarioDirection, string> = {
  bullish: '上昇シナリオ',
  bearish: '下落シナリオ',
  watch: '見送り観察',
}

const CONFIDENCE_LABELS: Record<TradeScenarioConfidence, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

const STATUS_LABELS: Record<TradeScenarioStatus, string> = {
  open: '検証中',
  reviewed: '振り返り済み',
  archived: '非表示',
}

function initialForm(price: number | null | undefined): ScenarioFormState {
  return {
    direction: 'bullish',
    confidence: 'medium',
    horizonDays: '20',
    entryPlanPrice: price ? String(Math.round(price * 10) / 10) : '',
    targetPrice: price ? String(Math.round(price * 1.08 * 10) / 10) : '',
    stopLossPrice: price ? String(Math.round(price * 0.95 * 10) / 10) : '',
    thesis: '',
    invalidation: '',
  }
}

function fmtMoney(value: number | null | undefined, market: MarketCode = 'JP'): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (market === 'US') return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function numberFromInput(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function outcomeColor(tone: TradeScenario['outcome']['tone']): string {
  if (tone === 'up') return 'var(--price-up)'
  if (tone === 'down') return 'var(--price-down)'
  return 'var(--text-secondary)'
}

function riskRewardText(form: ScenarioFormState): string {
  const entry = numberFromInput(form.entryPlanPrice)
  const target = numberFromInput(form.targetPrice)
  const stop = numberFromInput(form.stopLossPrice)
  if (entry == null || target == null || stop == null) return '損益比 -'
  const reward = form.direction === 'bearish' ? entry - target : target - entry
  const risk = form.direction === 'bearish' ? stop - entry : entry - stop
  if (reward <= 0 || risk <= 0) return '目標/撤退価格を確認'
  return `損益比 1:${(reward / risk).toFixed(2)}`
}

export function TradeScenarioNotebook({
  ticker,
  name,
  market = 'JP',
  quote,
  selectedRange,
  context,
}: TradeScenarioNotebookProps) {
  const [scenarios, setScenarios] = useState<TradeScenario[]>([])
  const [form, setForm] = useState<ScenarioFormState>(() => initialForm(quote?.price))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({})

  const hasSelectedRange = Boolean(selectedRange?.startDate && selectedRange?.endDate)
  const contextItems = useMemo(() => [
    `市場: ${market === 'US' ? '米国株' : '日本株'}`,
    context?.marketSegment ? `市場: ${context.marketSegment}` : null,
    context?.marginType ? `信用区分: ${context.marginType}` : null,
    context?.sector17 ? `17業種: ${context.sector17}` : null,
    hasSelectedRange && selectedRange ? `根拠範囲: ${selectedRange.startDate} → ${selectedRange.endDate}` : null,
  ].filter(Boolean) as string[], [context, hasSelectedRange, selectedRange, market])

  const reload = useCallback(async () => {
    const res = await fetch(`/api/trade/scenarios?ticker=${encodeURIComponent(ticker)}&market=${encodeURIComponent(market)}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    setScenarios(payload.scenarios ?? [])
    const drafts: Record<string, string> = {}
    for (const scenario of payload.scenarios ?? []) drafts[scenario.id] = scenario.reviewMemo ?? ''
    setReviewDrafts(drafts)
  }, [ticker, market])

  useEffect(() => {
    if (!quote?.price) return
    setForm((prev) => {
      if (prev.entryPlanPrice || prev.targetPrice || prev.stopLossPrice) return prev
      return initialForm(quote.price)
    })
  }, [quote?.price])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    reload()
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  useEffect(() => {
    function onScenarioSaved(event: Event) {
      const detail = (event as CustomEvent<{ ticker?: string; market?: string }>).detail
      if (detail?.market && detail.market !== market) return
      if (detail?.ticker && detail.ticker !== ticker) return
      reload().catch((e) => setError((e as Error).message))
    }
    window.addEventListener('trade-scenario-saved', onScenarioSaved)
    return () => window.removeEventListener('trade-scenario-saved', onScenarioSaved)
  }, [reload, ticker, market])

  function setDirection(direction: TradeScenarioDirection) {
    setForm((prev) => {
      const entry = numberFromInput(prev.entryPlanPrice) ?? quote?.price ?? null
      if (!entry) return { ...prev, direction }
      if (direction === 'bearish') {
        return {
          ...prev,
          direction,
          targetPrice: String(Math.round(entry * 0.92 * 10) / 10),
          stopLossPrice: String(Math.round(entry * 1.05 * 10) / 10),
        }
      }
      if (direction === 'bullish') {
        return {
          ...prev,
          direction,
          targetPrice: String(Math.round(entry * 1.08 * 10) / 10),
          stopLossPrice: String(Math.round(entry * 0.95 * 10) / 10),
        }
      }
      return { ...prev, direction, targetPrice: '', stopLossPrice: '' }
    })
  }

  async function createScenario() {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const res = await fetch('/api/trade/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker,
          market,
          name,
          direction: form.direction,
          confidence: form.confidence,
          horizonDays: Number(form.horizonDays),
          entryPlanPrice: numberFromInput(form.entryPlanPrice),
          targetPrice: numberFromInput(form.targetPrice),
          stopLossPrice: numberFromInput(form.stopLossPrice),
          thesis: form.thesis,
          invalidation: form.invalidation,
          anchorDate: selectedRange?.endDate ?? null,
          selectedStartDate: selectedRange?.startDate ?? null,
          selectedEndDate: selectedRange?.endDate ?? null,
          sourceRangeLabel: selectedRange?.sourceLabel ?? null,
          context: {
            selectedRange,
            quotePrice: quote?.price ?? null,
            quoteChangePct: quote?.changePercent ?? null,
            ...context,
          },
        }),
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.message ?? payload.error ?? `HTTP ${res.status}`)
      setMessage('売買シナリオを保存しました。')
      setForm(initialForm(quote?.price))
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function updateScenario(id: string, patch: { status?: TradeScenarioStatus; reviewMemo?: string | null }) {
    setError('')
    setMessage('')
    const res = await fetch(`/api/trade/scenarios/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const payload = await res.json()
    if (!res.ok) {
      setError(payload.message ?? payload.error ?? `HTTP ${res.status}`)
      return
    }
    setMessage('シナリオを更新しました。')
    setScenarios((prev) => prev.map((item) => item.id === id ? payload.scenario : item).filter((item) => item.status !== 'archived'))
  }

  const canSave = form.thesis.trim().length >= 4 && Number(form.horizonDays) > 0 && !saving

  return (
    <section className="card" style={notebookStyle}>
      <div style={headerStyle}>
        <div>
          <div className="section-header" style={{ margin: 0 }}>売買シナリオノート</div>
          <p style={subTextStyle}>
            実注文ではなく、分析時点の仮説を保存して後日答え合わせする練習機能です。
          </p>
        </div>
        <span style={virtualBadgeStyle}>仮説検証用</span>
      </div>

      <div style={notebookGridStyle}>
        <div style={formPanelStyle}>
          <div style={miniHeaderStyle}>
            <strong>新規シナリオ</strong>
            <span>{hasSelectedRange ? '選択範囲を根拠として保存します' : '範囲未選択でも保存できます'}</span>
          </div>

          <div style={directionGridStyle}>
            {(['bullish', 'bearish', 'watch'] as TradeScenarioDirection[]).map((direction) => (
              <button
                key={direction}
                type="button"
                onClick={() => setDirection(direction)}
                style={directionButtonStyle(form.direction === direction, direction)}
              >
                {DIRECTION_LABELS[direction]}
              </button>
            ))}
          </div>

          <div style={inputGridStyle}>
            <Label label="検証期間">
              <select
                value={form.horizonDays}
                onChange={(e) => setForm((prev) => ({ ...prev, horizonDays: e.target.value }))}
                style={inputStyle}
              >
                <option value="5">5営業日</option>
                <option value="10">10営業日</option>
                <option value="20">20営業日</option>
                <option value="40">40営業日</option>
                <option value="60">60営業日</option>
                <option value="90">90営業日</option>
              </select>
            </Label>
            <Label label="自信度">
              <select
                value={form.confidence}
                onChange={(e) => setForm((prev) => ({ ...prev, confidence: e.target.value as TradeScenarioConfidence }))}
                style={inputStyle}
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </Label>
            <Label label="想定価格">
              <input value={form.entryPlanPrice} onChange={(e) => setForm((prev) => ({ ...prev, entryPlanPrice: e.target.value }))} style={inputStyle} inputMode="decimal" />
            </Label>
            <Label label="目標価格">
              <input value={form.targetPrice} onChange={(e) => setForm((prev) => ({ ...prev, targetPrice: e.target.value }))} style={inputStyle} inputMode="decimal" />
            </Label>
            <Label label="撤退価格">
              <input value={form.stopLossPrice} onChange={(e) => setForm((prev) => ({ ...prev, stopLossPrice: e.target.value }))} style={inputStyle} inputMode="decimal" />
            </Label>
          </div>

          <div style={contextBoxStyle}>
            <strong>{riskRewardText(form)}</strong>
            <span>基準価格は保存時点の直近日足終値を使い、未来情報は保存後の答え合わせにだけ使います。</span>
            {contextItems.length > 0 && (
              <div style={contextPillRowStyle}>
                {contextItems.map((item) => <span key={item} style={contextPillStyle}>{item}</span>)}
              </div>
            )}
          </div>

          <Label label="エントリー/見送り理由">
            <textarea
              value={form.thesis}
              onChange={(e) => setForm((prev) => ({ ...prev, thesis: e.target.value }))}
              placeholder="例: 日足S2→S3候補、PFS改善、25日線上向き。決算前なので半分だけ想定、など"
              style={textareaStyle}
            />
          </Label>
          <Label label="シナリオが崩れる条件">
            <textarea
              value={form.invalidation}
              onChange={(e) => setForm((prev) => ({ ...prev, invalidation: e.target.value }))}
              placeholder="例: 25日線を明確に割る、PMSが低下継続、出来高が伴わない、など"
              style={textareaStyle}
            />
          </Label>

          <button type="button" onClick={createScenario} disabled={!canSave} style={saveButtonStyle(canSave)}>
            {saving ? '保存中...' : 'シナリオを保存'}
          </button>
          {error && <p style={errorStyle}>エラー: {error}</p>}
          {message && <p style={messageStyle}>{message}</p>}
        </div>

        <div style={listPanelStyle}>
          <div style={miniHeaderStyle}>
            <strong>保存済みシナリオ</strong>
            <span>{loading ? '読込中...' : `${scenarios.length}件`}</span>
          </div>
          {loading ? (
            <p style={emptyStyle}>読込中...</p>
          ) : scenarios.length === 0 ? (
            <p style={emptyStyle}>まだシナリオはありません。チャートやステージ範囲を見ながら仮説を保存できます。</p>
          ) : (
            <div style={scenarioListStyle}>
              {scenarios.map((scenario) => (
                <ScenarioCard
                  key={scenario.id}
                  scenario={scenario}
                  market={market}
                  reviewValue={reviewDrafts[scenario.id] ?? ''}
                  onReviewChange={(value) => setReviewDrafts((prev) => ({ ...prev, [scenario.id]: value }))}
                  onSaveReview={() => updateScenario(scenario.id, { status: 'reviewed', reviewMemo: reviewDrafts[scenario.id] ?? '' })}
                  onArchive={() => updateScenario(scenario.id, { status: 'archived' })}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function Label({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={labelStyle}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function ScenarioCard({
  scenario,
  market,
  reviewValue,
  onReviewChange,
  onSaveReview,
  onArchive,
}: {
  scenario: TradeScenario
  market: MarketCode
  reviewValue: string
  onReviewChange: (value: string) => void
  onSaveReview: () => void
  onArchive: () => void
}) {
  const outcome = scenario.outcome
  const tone = outcomeColor(outcome.tone)
  return (
    <article style={scenarioCardStyle}>
      <div style={scenarioTopStyle}>
        <div>
          <strong style={scenarioTitleStyle}>{DIRECTION_LABELS[scenario.direction]}</strong>
          <div style={scenarioMetaStyle}>
            {scenario.anchorDate}基準 / {scenario.horizonDays}営業日 / 自信度{CONFIDENCE_LABELS[scenario.confidence]} / {STATUS_LABELS[scenario.status]}
          </div>
        </div>
        <span style={{ ...outcomeBadgeStyle, color: tone, borderColor: tone }}>{outcome.label}</span>
      </div>

      <div style={scenarioMetricGridStyle}>
        <Metric label="基準終値" value={fmtMoney(scenario.anchorClose, market)} />
        <Metric label="最大上昇" value={fmtPct(outcome.maxRisePct)} tone={outcome.maxRisePct} />
        <Metric label="最大下落" value={fmtPct(outcome.maxDrawdownPct)} tone={outcome.maxDrawdownPct} />
        <Metric label="終値変化" value={fmtPct(outcome.endReturnPct)} tone={outcome.endReturnPct} />
      </div>

      <div style={scenarioPlanStyle}>
        <span>想定 {fmtMoney(scenario.entryPlanPrice, market)}</span>
        <span>目標 {fmtMoney(scenario.targetPrice, market)}</span>
        <span>撤退 {fmtMoney(scenario.stopLossPrice, market)}</span>
      </div>

      <p style={scenarioNoteStyle}>{outcome.note}</p>
      {scenario.targetPrice != null && outcome.targetHitDate && (
        <p style={scenarioTinyStyle}>目標到達: {outcome.targetHitDate}（{outcome.targetHitDay}営業日目）</p>
      )}
      {scenario.stopLossPrice != null && outcome.stopHitDate && (
        <p style={scenarioTinyStyle}>撤退到達: {outcome.stopHitDate}（{outcome.stopHitDay}営業日目）</p>
      )}
      {scenario.selectedStartDate && scenario.selectedEndDate && (
        <p style={scenarioRangeStyle}>
          根拠範囲: {scenario.selectedStartDate} → {scenario.selectedEndDate}
          {scenario.sourceRangeLabel ? ` / ${scenario.sourceRangeLabel}` : ''}
        </p>
      )}

      <details style={detailsStyle}>
        <summary>根拠と振り返り</summary>
        <div style={detailsBodyStyle}>
          <div>
            <strong>仮説</strong>
            <p>{scenario.thesis}</p>
          </div>
          {scenario.invalidation && (
            <div>
              <strong>崩れる条件</strong>
              <p>{scenario.invalidation}</p>
            </div>
          )}
          <Label label="振り返りメモ">
            <textarea
              value={reviewValue}
              onChange={(e) => onReviewChange(e.target.value)}
              placeholder="実際の値動き、想定との差、次に改善する点"
              style={textareaStyle}
            />
          </Label>
          <div style={scenarioActionRowStyle}>
            <button type="button" onClick={onSaveReview} style={smallPrimaryButtonStyle}>振り返り保存</button>
            <button type="button" onClick={onArchive} style={smallGhostButtonStyle}>非表示</button>
          </div>
        </div>
      </details>
    </article>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div style={metricStyle}>
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  )
}

const notebookStyle: CSSProperties = {
  padding: '14px',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '12px',
  flexWrap: 'wrap',
  marginBottom: '10px',
}

const subTextStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--text-muted)',
  fontSize: '11px',
  lineHeight: 1.6,
}

const virtualBadgeStyle: CSSProperties = {
  border: '1px solid rgba(14, 165, 233, 0.3)',
  borderRadius: '999px',
  background: 'rgba(14, 165, 233, 0.08)',
  color: '#0369a1',
  fontSize: '11px',
  fontWeight: 800,
  padding: '5px 9px',
}

const notebookGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))',
  gap: '10px',
}

const formPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '9px',
  minWidth: 0,
}

const listPanelStyle: CSSProperties = {
  ...formPanelStyle,
  background: '#fff',
}

const miniHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
}

const directionGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '6px',
}

function directionButtonStyle(active: boolean, direction: TradeScenarioDirection): CSSProperties {
  const color = direction === 'bullish' ? 'var(--price-up)' : direction === 'bearish' ? 'var(--price-down)' : 'var(--text-secondary)'
  return {
    border: `1px solid ${active ? color : 'var(--border-subtle)'}`,
    borderRadius: 'var(--radius-sm)',
    background: active ? 'rgba(15, 23, 42, 0.04)' : '#fff',
    color,
    fontSize: '11px',
    fontWeight: 800,
    padding: '8px 6px',
    cursor: 'pointer',
  }
}

const inputGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
  gap: '7px',
}

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 700,
}

const inputStyle: CSSProperties = {
  height: '32px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  padding: '0 8px',
}

const textareaStyle: CSSProperties = {
  minHeight: '66px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-primary)',
  fontSize: '12px',
  lineHeight: 1.55,
  padding: '8px',
  resize: 'vertical',
}

const contextBoxStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.55,
  padding: '8px',
  display: 'grid',
  gap: '5px',
}

const contextPillRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '5px',
}

const contextPillStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  fontWeight: 700,
  padding: '3px 7px',
}

function saveButtonStyle(enabled: boolean): CSSProperties {
  return {
    height: '34px',
    border: '1px solid var(--accent-primary)',
    borderRadius: 'var(--radius-sm)',
    background: enabled ? 'var(--accent-primary)' : 'var(--bg-surface)',
    color: enabled ? '#fff' : 'var(--text-muted)',
    fontSize: '12px',
    fontWeight: 800,
    cursor: enabled ? 'pointer' : 'not-allowed',
  }
}

const errorStyle: CSSProperties = {
  margin: 0,
  color: 'var(--price-down)',
  fontSize: '11px',
  fontWeight: 700,
}

const messageStyle: CSSProperties = {
  margin: 0,
  color: 'var(--price-up)',
  fontSize: '11px',
  fontWeight: 700,
}

const emptyStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '11px',
  lineHeight: 1.6,
  margin: 0,
}

const scenarioListStyle: CSSProperties = {
  display: 'grid',
  gap: '8px',
  maxHeight: '720px',
  overflow: 'auto',
  paddingRight: '2px',
}

const scenarioCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '9px',
  display: 'grid',
  gap: '8px',
}

const scenarioTopStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  alignItems: 'flex-start',
}

const scenarioTitleStyle: CSSProperties = {
  fontSize: '12px',
}

const scenarioMetaStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  marginTop: '2px',
}

const outcomeBadgeStyle: CSSProperties = {
  border: '1px solid var(--border-base)',
  borderRadius: '999px',
  background: '#fff',
  fontSize: '10px',
  fontWeight: 800,
  padding: '4px 7px',
  whiteSpace: 'nowrap',
}

const scenarioMetricGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: '5px',
}

const metricStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '6px',
  display: 'grid',
  gap: '2px',
  fontSize: '10px',
}

const scenarioPlanStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '5px 9px',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
}

const scenarioNoteStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.55,
}

const scenarioTinyStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: '10px',
}

const scenarioRangeStyle: CSSProperties = {
  margin: 0,
  color: 'var(--accent-primary)',
  fontSize: '10px',
  fontWeight: 700,
}

const detailsStyle: CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: '7px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
}

const detailsBodyStyle: CSSProperties = {
  display: 'grid',
  gap: '7px',
  marginTop: '7px',
}

const scenarioActionRowStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  flexWrap: 'wrap',
}

const smallPrimaryButtonStyle: CSSProperties = {
  border: '1px solid var(--accent-primary)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--accent-primary)',
  color: '#fff',
  fontSize: '11px',
  fontWeight: 800,
  padding: '6px 9px',
  cursor: 'pointer',
}

const smallGhostButtonStyle: CSSProperties = {
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  fontWeight: 800,
  padding: '6px 9px',
  cursor: 'pointer',
}
