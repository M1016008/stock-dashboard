'use client'

// components/us/backtest/UsBacktestControls.tsx
//
// Explorer 上部の 1 枚のパネル。上段 = 基準日・検証期間・結果確定範囲、下段 = フィルター。
// - 基準日は select + 前後ボタン (全日付をグリッド表示しない)
// - 結果確定済みの基準日は検証期間ごとに異なる。市場最新日とは別の行で示す
// - フィルターは下書きを「適用」で反映する (入力のたびに再取得しない)
// - 分類 (Sector/Industry/Exchange) は過去時点を保証できないため置かない

import { type FormEvent, type ReactNode, useId } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import {
  CONTROL,
  FIELD_LABEL,
  FOCUS_RING,
  MUTED_TEXT,
  RETURN_METRIC_LABELS,
  fmtCount,
  type UsBacktestDatesResponse,
  type UsBacktestFilterErrors,
  type UsBacktestFilterState,
  type UsBacktestHorizon,
  type UsBacktestReturnMetric,
} from '@/components/us/backtest/usBacktestShared'

/* ---------- 基準日・期間 ---------- */

export function UsBacktestContextBar({
  horizons,
  horizon,
  onHorizonChange,
  date,
  onDateChange,
  dates,
  datesLoading,
}: {
  horizons: readonly UsBacktestHorizon[]
  horizon: UsBacktestHorizon
  onHorizonChange: (horizon: UsBacktestHorizon) => void
  date: string | null
  onDateChange: (date: string) => void
  dates: UsBacktestDatesResponse | null
  datesLoading: boolean
}) {
  const dateId = useId()
  const list = dates?.dates ?? []
  const index = date ? list.findIndex((item) => item.date === date) : -1
  const selected = index >= 0 ? list[index] : null
  // dates は新しい順
  const older = index >= 0 && index < list.length - 1 ? list[index + 1].date : null
  const newer = index > 0 ? list[index - 1].date : null
  const coverage = dates?.coverage
  const disabled = datesLoading || list.length === 0

  return (
    <div className="flex min-w-0 flex-col gap-3 px-3 py-3 sm:px-4 xl:flex-row xl:items-end xl:gap-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <div className="min-w-0">
          <label htmlFor={dateId} className={`mb-1 block ${FIELD_LABEL}`}>基準日</label>
          <div className="flex items-center gap-1">
            <IconButton label="1つ前の基準日" disabled={disabled || !older} onClick={() => older && onDateChange(older)}>
              <ChevronLeft size={15} aria-hidden />
            </IconButton>
            <select
              id={dateId}
              value={selected?.date ?? ''}
              disabled={disabled}
              onChange={(event) => onDateChange(event.target.value)}
              className={`${CONTROL} w-[208px] font-mono tabular-nums disabled:bg-[var(--color-surface-subtle)]`}
            >
              {list.length === 0 && <option value="">{datesLoading ? '読み込み中' : '基準日なし'}</option>}
              {list.map((item) => (
                <option key={item.date} value={item.date}>
                  {item.date}（{fmtCount(item.totalTickers)}銘柄）
                </option>
              ))}
            </select>
            <IconButton label="1つ後の基準日" disabled={disabled || !newer} onClick={() => newer && onDateChange(newer)}>
              <ChevronRight size={15} aria-hidden />
            </IconButton>
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className={`mb-1 ${FIELD_LABEL}`}>検証期間（営業日）</legend>
          <div className="inline-flex h-8 max-w-full overflow-hidden rounded-[4px] border border-[var(--color-border-default)]">
            {horizons.map((value) => {
              const active = value === horizon
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${value}営業日`}
                  onClick={() => onHorizonChange(value)}
                  className={`min-w-[38px] border-l border-[var(--color-border-soft)] px-2 font-mono text-[12px] tabular-nums first:border-l-0 ${FOCUS_RING} focus-visible:relative ${
                    active
                      ? 'bg-[var(--color-brand-800)] font-semibold text-white'
                      : 'bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
                  }`}
                >
                  {value}
                </button>
              )
            })}
          </div>
        </fieldset>
      </div>

      <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-[repeat(3,minmax(0,auto))] sm:justify-between xl:justify-start xl:border-l xl:border-[var(--color-border-soft)] xl:pl-6" aria-busy={datesLoading}>
        <Fact label="基準日の対象">
          {selected
            ? <>{fmtCount(selected.totalTickers)}銘柄<span className={MUTED_TEXT}> · シグナル {fmtCount(selected.signalTickers)}</span></>
            : <Placeholder loading={datesLoading} />}
        </Fact>
        <Fact label={`結果確定済み基準日（${horizon}営業日）`}>
          {coverage?.firstOutcomeDate && coverage.latestOutcomeDate
            ? <>{coverage.firstOutcomeDate} 〜 {coverage.latestOutcomeDate}<span className={MUTED_TEXT}> · {fmtCount(coverage.availableDates)}日</span></>
            : <Placeholder loading={datesLoading} />}
        </Fact>
        <Fact label="市場データ最新日">
          {coverage?.marketLatestDate ?? <Placeholder loading={datesLoading} />}
        </Fact>
      </dl>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={`truncate text-[11px] ${MUTED_TEXT}`}>{label}</dt>
      <dd className="mt-0.5 break-words font-mono tabular-nums text-[var(--color-text-primary)]">{children}</dd>
    </div>
  )
}

function Placeholder({ loading }: { loading: boolean }) {
  return loading
    ? <span className={MUTED_TEXT}>読み込み中</span>
    : <span className={MUTED_TEXT}>N/A</span>
}

function IconButton({ label, disabled, onClick, children }: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

/* ---------- フィルター ---------- */

export function UsBacktestFilters({
  draft,
  onDraftChange,
  errors,
  canApply,
  dirty,
  activeCount,
  onApply,
  onReset,
  signalOptions,
}: {
  draft: UsBacktestFilterState
  onDraftChange: (next: UsBacktestFilterState) => void
  errors: UsBacktestFilterErrors
  canApply: boolean
  dirty: boolean
  activeCount: number
  onApply: () => void
  onReset: () => void
  signalOptions: string[]
}) {
  const ids = {
    search: useId(),
    stage: useId(),
    stageHelp: useId(),
    signal: useId(),
    signalList: useId(),
    metric: useId(),
    min: useId(),
    max: useId(),
    rangeHelp: useId(),
    target: useId(),
  }
  const set = <K extends keyof UsBacktestFilterState>(key: K, value: UsBacktestFilterState[K]) => onDraftChange({ ...draft, [key]: value })
  const rangeError = errors.returnMin ?? errors.returnMax ?? errors.range

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canApply) onApply()
  }

  return (
    <form
      onSubmit={submit}
      aria-label="検証結果の絞り込み"
      className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-2.5 border-t border-[var(--color-border-soft)] px-3 py-3 sm:px-4 md:grid-cols-6 xl:grid-cols-[minmax(0,1.6fr)_96px_minmax(0,1.2fr)_120px_112px_80px_80px_auto]"
    >
      <div className="col-span-2 min-w-0 md:col-span-2 xl:col-span-1">
        <label htmlFor={ids.search} className={`mb-1 block ${FIELD_LABEL}`}>ティッカー・銘柄名</label>
        <input
          id={ids.search}
          type="search"
          value={draft.search}
          maxLength={40}
          placeholder="例 AAPL / Apple"
          onChange={(event) => set('search', event.target.value)}
          className={CONTROL}
        />
      </div>

      <div className="min-w-0 md:col-span-1">
        <label htmlFor={ids.stage} className={`mb-1 block ${FIELD_LABEL}`}>6桁Stage</label>
        <input
          id={ids.stage}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft.stageCode}
          maxLength={6}
          placeholder="112233"
          aria-invalid={Boolean(errors.stageCode)}
          aria-describedby={errors.stageCode ? ids.stageHelp : undefined}
          onChange={(event) => set('stageCode', event.target.value.replace(/\s/g, ''))}
          className={`${CONTROL} font-mono tabular-nums ${errors.stageCode ? '!border-[var(--color-price-up)]' : ''}`}
        />
      </div>

      <div className="min-w-0 md:col-span-2 xl:col-span-1">
        <label htmlFor={ids.signal} className={`mb-1 block ${FIELD_LABEL}`}>シグナル（完全一致）</label>
        <input
          id={ids.signal}
          type="text"
          autoComplete="off"
          spellCheck={false}
          list={ids.signalList}
          value={draft.signal}
          maxLength={80}
          placeholder="シグナルコード"
          onChange={(event) => set('signal', event.target.value)}
          className={`${CONTROL} font-mono`}
        />
        <datalist id={ids.signalList}>
          {signalOptions.map((code) => <option key={code} value={code} />)}
        </datalist>
      </div>

      <div className="min-w-0 md:col-span-1">
        <label htmlFor={ids.target} className={`mb-1 block ${FIELD_LABEL}`}>到達</label>
        <select
          id={ids.target}
          value={draft.targetPct}
          onChange={(event) => set('targetPct', event.target.value as UsBacktestFilterState['targetPct'])}
          className={CONTROL}
        >
          <option value="">指定なし</option>
          <option value="10">+10% 到達</option>
          <option value="20">+20% 到達</option>
          <option value="40">+40% 到達</option>
        </select>
      </div>

      <div className="min-w-0 md:col-span-2 xl:col-span-1">
        <label htmlFor={ids.metric} className={`mb-1 block ${FIELD_LABEL}`}>騰落率の対象</label>
        <select
          id={ids.metric}
          value={draft.returnMetric}
          onChange={(event) => set('returnMetric', event.target.value as UsBacktestReturnMetric)}
          className={CONTROL}
        >
          {(Object.keys(RETURN_METRIC_LABELS) as UsBacktestReturnMetric[]).map((metric) => (
            <option key={metric} value={metric}>{RETURN_METRIC_LABELS[metric]}</option>
          ))}
        </select>
      </div>

      <NumberField id={ids.min} label="下限 %" value={draft.returnMin} invalid={Boolean(errors.returnMin || errors.range)} describedBy={rangeError ? ids.rangeHelp : undefined} onChange={(value) => set('returnMin', value)} />
      <NumberField id={ids.max} label="上限 %" value={draft.returnMax} invalid={Boolean(errors.returnMax || errors.range)} describedBy={rangeError ? ids.rangeHelp : undefined} onChange={(value) => set('returnMax', value)} />

      <div className="col-span-2 flex min-w-0 items-end justify-end gap-1.5 md:col-span-2 xl:col-span-1">
        <button
          type="button"
          onClick={onReset}
          disabled={activeCount === 0 && !dirty}
          className={`inline-flex h-8 items-center gap-1 rounded-[4px] px-2 text-[12px] font-medium text-[var(--color-brand-700)] hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
        >
          <RotateCcw size={13} aria-hidden />
          リセット
        </button>
        <button
          type="submit"
          disabled={!canApply}
          className={`inline-flex h-8 items-center rounded-[4px] border border-[var(--color-brand-800)] bg-[var(--color-brand-800)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--color-brand-900)] disabled:cursor-not-allowed disabled:border-[var(--color-border-default)] disabled:bg-[var(--color-surface-muted)] disabled:text-[var(--color-text-tertiary)] ${FOCUS_RING}`}
        >
          適用
        </button>
      </div>

      <p className="col-span-2 min-h-4 text-[11px] leading-4 md:col-span-6 xl:col-span-8" aria-live="polite">
        {errors.stageCode && <span id={ids.stageHelp} className="mr-3 text-[var(--color-price-up-mid)]">6桁Stage: {errors.stageCode}</span>}
        {rangeError && <span id={ids.rangeHelp} className="mr-3 text-[var(--color-price-up-mid)]">騰落率: {rangeError}</span>}
        {!errors.stageCode && !rangeError && (
          <span className={MUTED_TEXT}>
            {dirty ? '未適用の変更があります。「適用」で結果を更新します。' : activeCount > 0 ? `${activeCount}件の条件を適用中` : '条件なし（基準日の全銘柄）'}
            {' · '}騰落率はすべて基準日終値比（%）
          </span>
        )}
      </p>
    </form>
  )
}

function NumberField({ id, label, value, invalid, describedBy, onChange }: {
  id: string
  label: string
  value: string
  invalid: boolean
  describedBy?: string
  onChange: (value: string) => void
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={`mb-1 block ${FIELD_LABEL}`}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder="—"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} text-right font-mono tabular-nums ${invalid ? '!border-[var(--color-price-up)]' : ''}`}
      />
    </div>
  )
}
