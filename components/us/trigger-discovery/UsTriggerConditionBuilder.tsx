'use client'

// components/us/trigger-discovery/UsTriggerConditionBuilder.tsx
//
// 検索条件フォーム。入力しても検索せず、送信 (ボタン / Enter) したときだけ親が検索する。
// - 既定値 (月足 20/25・Trigger距離 5%・Near 2%・$5以上・$5M以上) は見出し行に明示し、1 操作で戻せる
// - 過去日では取引所を選べない (当時の取引所情報がないため)。選択は保持し、最新日に戻すと再び効く

import { ChevronUp, LoaderCircle, Lock, RotateCcw, Search, X } from 'lucide-react'
import {
  TRIGGER_DISCOVERY_STAGE_AXES,
  type TriggerDiscoveryStageAxis,
  type TriggerDiscoveryStageFilterValue,
} from '@/lib/trigger-discovery-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import type { UsTriggerDiscoveryOptionsResponse } from '@/lib/us-trigger-discovery-contract'
import { fmtCount } from '@/components/us/UsMarketMomentumParts'
import {
  DisclosureSummary,
  FIELD_LABEL,
  FOCUS_RING,
  Field,
  HelpPopover,
  MetaBadge,
} from '@/components/us/trigger-discovery/UsTriggerControls'
import {
  STAGE_AXIS_LABELS,
  US_TRIGGER_DEFAULTS,
  isDefaultUsTriggerDraft,
  isPastUsTriggerDate,
  timeframeLabel,
  type UsTriggerDraft,
  type UsTriggerDraftStringKey,
} from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'

const STAGE_VALUES: TriggerDiscoveryStageFilterValue[] = [1, 2, 3, 4, 5, 6, 'unknown']

export function UsTriggerConditionBuilder({
  draft,
  onDraftChange,
  options,
  loading,
  hasResult,
  onSubmit,
  onCancelSearch,
  onClose,
  onReset,
}: {
  draft: UsTriggerDraft
  onDraftChange: (update: (current: UsTriggerDraft) => UsTriggerDraft) => void
  options: UsTriggerDiscoveryOptionsResponse
  loading: boolean
  hasResult: boolean
  onSubmit: () => void
  onCancelSearch: () => void
  onClose: () => void
  onReset: () => void
}) {
  const set = (key: UsTriggerDraftStringKey, value: string) => onDraftChange((current) => ({ ...current, [key]: value }))
  const past = isPastUsTriggerDate(draft.asOf, options.latestAsOf)
  const unit = draft.timeframe === 'BIWEEKLY' ? '本' : 'か月'
  const stageAxisCount = TRIGGER_DISCOVERY_STAGE_AXES.filter((axis) => draft.stageFilters[axis]?.length).length
  const volumeActive = draft.volumeMin.trim() !== '' || draft.volumeMax.trim() !== ''
  const atDefaults = isDefaultUsTriggerDraft(draft)
  const exchangeLabel = (value: string) => options.exchanges.find((exchange) => exchange.value === value)?.label ?? value
  const exchangeSummary = past
    ? '取引所指定なし（過去日）'
    : draft.exchanges.length > 0 ? draft.exchanges.map(exchangeLabel).join(' / ') : '全取引所'
  const draftSummary = [
    `${timeframeLabel(draft.timeframe)} ${draft.ma1Period || '—'}/${draft.ma2Period || '—'}`,
    `Trigger距離 ${draft.maxDistance || '—'}%以内`,
    `基準日 ${draft.asOf || '—'}`,
    exchangeSummary,
  ].join(' ・ ')

  const toggleExchange = (value: string) => onDraftChange((current) => ({
    ...current,
    exchanges: current.exchanges.includes(value)
      ? current.exchanges.filter((item) => item !== value)
      : [...current.exchanges, value],
  }))

  const toggleStage = (axis: TriggerDiscoveryStageAxis, value: TriggerDiscoveryStageFilterValue) => onDraftChange((current) => {
    const values = current.stageFilters[axis] ?? []
    const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
    const stageFilters = { ...current.stageFilters }
    if (next.length > 0) stageFilters[axis] = next
    else delete stageFilters[axis]
    return { ...current, stageFilters }
  })

  return (
    <form
      data-us-trigger-builder
      aria-labelledby="us-trigger-builder-heading"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!loading) onSubmit()
      }}
      className="panel"
    >
      <div className="panel-head">
        <div className="min-w-0">
          <h2 id="us-trigger-builder-heading" tabIndex={-1} className="outline-none">検索条件</h2>
          <p>
            既定値：月足・MA {US_TRIGGER_DEFAULTS.ma1Period}/{US_TRIGGER_DEFAULTS.ma2Period}・Trigger距離 {US_TRIGGER_DEFAULTS.maxDistancePct}%・Near {US_TRIGGER_DEFAULTS.nearDistancePct}%・株価 ${US_TRIGGER_DEFAULTS.priceMinUsd}以上・平均売買代金 ${US_TRIGGER_DEFAULTS.tradingValueMinUsdM}M以上（すべて変更できます）
          </p>
        </div>
        <button type="button" onClick={onReset} disabled={atDefaults} className="btn" data-size="sm" data-variant="ghost">
          <RotateCcw size={12} aria-hidden />既定値に戻す
        </button>
      </div>

      <section aria-labelledby="us-trigger-conditions" className="border-b border-[var(--color-border-soft)] px-3.5 py-3.5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <h3 id="us-trigger-conditions" className="text-[13px] font-semibold text-[var(--color-text-primary)]">1. Trigger条件</h3>
            <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
              移動平均 2 本で作る価格帯（Trigger Zone）と、接近とみなす距離を指定します。{draft.timeframe === 'BIWEEKLY' ? '2週足の終値' : '月足の終値'}で計算します。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-tertiary)]">
            <span className="font-medium">固定条件</span>
            <span className="inline-flex items-center gap-0.5">
              MA方向 <strong className="font-semibold text-[var(--color-text-secondary)]">2本とも上向き</strong>
              <HelpPopover title="2本とも上向き" align="end">
                <p>MA 1 と MA 2 の両方が上向いている銘柄だけを評価します。どちらかが横ばい・下向きの銘柄は対象外です。</p>
              </HelpPopover>
            </span>
            <span className="inline-flex items-center gap-0.5">
              接近方向 <strong className="font-semibold text-[var(--color-text-secondary)]">上から</strong>
              <HelpPopover title="上から接近" align="end">
                <p>株価が Trigger Zone（MA 1〜MA 2 の間）より上にあり、Zone へ向かって近づいている銘柄を対象にします。</p>
                <p className="text-[10px] text-[var(--color-text-tertiary)]">Zone の下から上昇して近づく銘柄は対象外です。この 2 条件はエンジン側で固定しています。</p>
              </HelpPopover>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3 lg:max-w-[1000px] lg:grid-cols-6">
          <label className="block min-w-0">
            <span className={`mb-1 flex min-h-5 items-center ${FIELD_LABEL}`}>足種</span>
            <select
              value={draft.timeframe}
              onChange={(event) => {
                const next = event.target.value as TriggerDiscoveryTimeframe
                onDraftChange((current) => ({ ...current, timeframe: next }))
              }}
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-500)] focus:ring-1 focus:ring-[var(--color-brand-100)]"
            >
              {options.supportedTimeframes.map((timeframe) => (
                <option key={timeframe} value={timeframe}>{timeframeLabel(timeframe)}</option>
              ))}
            </select>
          </label>
          <Field label="MA 1" value={draft.ma1Period} onChange={(value) => set('ma1Period', value)} suffix={unit} type="number" inputMode="numeric" min={2} max={120} />
          <Field label="MA 2" value={draft.ma2Period} onChange={(value) => set('ma2Period', value)} suffix={unit} type="number" inputMode="numeric" min={2} max={120} />
          <Field
            label="Trigger距離"
            value={draft.maxDistance}
            onChange={(value) => set('maxDistance', value)}
            suffix="%以内"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="any"
            help={(
              <HelpPopover title="Trigger距離">
                <p>Trigger Zone（MA 1〜MA 2 の間の価格帯）まで、何％手前から「接近中」とみなすかを決めます。</p>
                <p className="text-[10px] text-[var(--color-text-tertiary)]">例：MA 1 が $100、MA 2 が $95 なら Zone は $95〜$100。5% 設定では、株価が上から Zone の 5% 以内に入ると候補になります。</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 border-t border-[var(--color-border-soft)] pt-2 text-[10px]">
                  <dt>Trigger距離以内</dt><dd>接近中</dd>
                  <dt>Near距離以内</dt><dd>近接</dd>
                  <dt>MA 1〜MA 2 の間</dt><dd>ゾーン内</dd>
                </dl>
              </HelpPopover>
            )}
          />
          <Field
            label="Near距離"
            value={draft.nearDistance}
            onChange={(value) => set('nearDistance', value)}
            suffix="%以内"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="any"
            help={(
              <HelpPopover title="Near距離">
                <p>Zone のさらに近くまで来た銘柄を「近接」とする距離です。Trigger距離以下で指定します。</p>
              </HelpPopover>
            )}
          />
          <Field
            label="基準日"
            value={draft.asOf}
            onChange={(value) => set('asOf', value)}
            type="date"
            action={options.latestAsOf && draft.asOf !== options.latestAsOf ? (
              <button
                type="button"
                onClick={() => set('asOf', options.latestAsOf!)}
                className={`rounded-[2px] text-[10px] font-medium text-[var(--color-brand-700)] hover:underline ${FOCUS_RING}`}
                aria-label={`基準日を最新データ日 ${options.latestAsOf} に戻す`}
              >
                最新へ
              </button>
            ) : null}
            help={(
              <HelpPopover title="基準日" align="end">
                <p>米国市場日の終値ベースで評価します。休場日を指定すると、その日以前の直近の取引日で評価します。</p>
                <p className="text-[10px] text-[var(--color-text-tertiary)]">最新データ日より前の日付は過去日として扱い、取引所では絞り込めません。母集団は価格履歴のカバレッジから作るため、公式な当時の上場銘柄リストではありません。</p>
              </HelpPopover>
            )}
          />
        </div>

        <details className="group mt-3">
          <DisclosureSummary
            meta={(
              <>
                {draft.spreadExpansionEnabled && <MetaBadge>MA間隔拡大 ON</MetaBadge>}
                {draft.belowZoneToleranceEnabled && <MetaBadge>Zone下抜け ON</MetaBadge>}
                {!draft.spreadExpansionEnabled && !draft.belowZoneToleranceEnabled && <span className="font-normal text-[var(--color-text-tertiary)]">追加条件なし</span>}
              </>
            )}
          >
            追加のTrigger条件
          </DisclosureSummary>
          <div className="mt-1.5 divide-y divide-[var(--color-border-soft)] border-l-2 border-[var(--color-border-soft)] pl-3 lg:max-w-[860px]">
            <div className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--color-text-primary)]">
                  <label className="inline-flex min-h-8 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.spreadExpansionEnabled}
                      onChange={(event) => onDraftChange((current) => ({ ...current, spreadExpansionEnabled: event.target.checked }))}
                      className="h-4 w-4 rounded border-[var(--color-border-default)] accent-[var(--color-brand-700)]"
                    />
                    MA間隔拡大
                  </label>
                  <HelpPopover title="MA間隔拡大" align="start">
                    <p>MA 1 が MA 2 の上にあり、2 本の間隔が広がる傾向にある銘柄だけに絞ります。</p>
                    <p className="text-[10px] text-[var(--color-text-tertiary)]">一時的な縮小は許容し、比較区間のうち拡大した区間の比率で判定します。</p>
                  </HelpPopover>
                </span>
                <span className="text-[10px] text-[var(--color-text-tertiary)]">既定 OFF・Scoreへの加点なし</span>
              </div>
              {draft.spreadExpansionEnabled && (
                <div className="mt-2 grid w-full grid-cols-2 gap-x-3 sm:w-auto sm:grid-cols-[170px_170px]">
                  <Field label="比較区間数" value={draft.spreadLookbackIntervals} onChange={(value) => set('spreadLookbackIntervals', value)} suffix="区間" type="number" inputMode="numeric" min={2} max={24} />
                  <Field label="最低拡大区間比率" value={draft.minExpansionRatioPct} onChange={(value) => set('minExpansionRatioPct', value)} suffix="%" type="number" inputMode="decimal" min={0} max={100} />
                </div>
              )}
            </div>
            <div className="pt-3">
              <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-[12px] font-medium text-[var(--color-text-primary)]">
                <input
                  type="checkbox"
                  checked={draft.belowZoneToleranceEnabled}
                  onChange={(event) => onDraftChange((current) => ({ ...current, belowZoneToleranceEnabled: event.target.checked }))}
                  className="h-4 w-4 rounded border-[var(--color-border-default)] accent-[var(--color-brand-700)]"
                />
                Zone下抜けも候補に含める
              </label>
              <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">上から Zone へ接近し、Zone 下限をわずかに下回った銘柄も「下抜け」として残します。</p>
              {draft.belowZoneToleranceEnabled && (
                <div className="mt-2 w-[170px] max-w-full">
                  <Field label="最大下抜け幅" value={draft.maxBelowZonePct} onChange={(value) => set('maxBelowZonePct', value)} suffix="%" type="number" inputMode="decimal" min={0.01} max={20} step="any" />
                </div>
              )}
            </div>
          </div>
        </details>
      </section>

      <section aria-labelledby="us-trigger-universe" className="border-b border-[var(--color-border-soft)] px-3.5 py-3.5">
        <div className="mb-3 min-w-0">
          <h3 id="us-trigger-universe" className="text-[13px] font-semibold text-[var(--color-text-primary)]">2. 対象銘柄</h3>
          <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">株価は USD 終値、平均売買代金は直近 {draft.liquidityLookbackSessions || '—'} 営業日の平均（$M = 百万ドル）です。空欄は制限なし。</p>
        </div>
        <div className="grid gap-x-5 gap-y-3 md:grid-cols-2 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,.75fr)_minmax(0,.75fr)]">
          <fieldset className="min-w-0 md:col-span-2 lg:col-span-1" disabled={past} aria-describedby={past ? 'us-trigger-exchange-locked' : undefined}>
            <legend className={`mb-1 flex min-h-5 items-center ${FIELD_LABEL}`}>
              取引所{past ? '' : '（未選択はすべて）'}
            </legend>
            {past ? (
              <div id="us-trigger-exchange-locked" className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[3px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">
                <Lock size={12} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
                <span>過去日は取引所で絞り込めません（当時の取引所情報がないため）</span>
                {draft.exchanges.length > 0 && (
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">選択中の {draft.exchanges.length} 件は最新日に戻すと再び使います</span>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {options.exchanges.map((exchange) => {
                  const selected = draft.exchanges.includes(exchange.value)
                  return (
                    <label key={exchange.value} className={`inline-flex h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-[3px] border px-2 text-[11px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-brand-200)] ${selected ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] font-medium text-[var(--color-brand-800)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-300)]'}`}>
                      <input type="checkbox" className="sr-only" checked={selected} onChange={() => toggleExchange(exchange.value)} />
                      {exchange.label}
                      <span className="text-[9px] tabular-nums text-[var(--color-text-tertiary)]">{fmtCount(exchange.count)}</span>
                    </label>
                  )
                })}
                {options.exchanges.length === 0 && <span className="text-[11px] text-[var(--color-text-tertiary)]">取引所の一覧を取得できませんでした（すべての取引所が対象です）</span>}
              </div>
            )}
          </fieldset>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="株価 下限" value={draft.priceMin} onChange={(value) => set('priceMin', value)} prefix="$" inputMode="decimal" placeholder="なし" />
            <Field label="株価 上限" value={draft.priceMax} onChange={(value) => set('priceMax', value)} prefix="$" inputMode="decimal" placeholder="なし" />
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="平均売買代金 下限" value={draft.tradingValueMinM} onChange={(value) => set('tradingValueMinM', value)} prefix="$" suffix="M" inputMode="decimal" placeholder="なし" />
            <Field label="平均売買代金 上限" value={draft.tradingValueMaxM} onChange={(value) => set('tradingValueMaxM', value)} prefix="$" suffix="M" inputMode="decimal" placeholder="なし" />
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-0.5">
          <details className="group">
            <DisclosureSummary
              meta={(
                <>
                  <span className="font-normal tabular-nums text-[var(--color-text-tertiary)]">平均期間 {draft.liquidityLookbackSessions || '—'}営業日</span>
                  {volumeActive && <MetaBadge>出来高 指定あり</MetaBadge>}
                </>
              )}
            >
              出来高・平均期間
            </DisclosureSummary>
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-3 border-l-2 border-[var(--color-border-soft)] pl-3 sm:grid-cols-3 lg:max-w-[560px]">
              <Field label="平均出来高 下限" value={draft.volumeMin} onChange={(value) => set('volumeMin', value)} suffix="株" inputMode="numeric" placeholder="なし" />
              <Field label="平均出来高 上限" value={draft.volumeMax} onChange={(value) => set('volumeMax', value)} suffix="株" inputMode="numeric" placeholder="なし" />
              <Field label="平均期間" value={draft.liquidityLookbackSessions} onChange={(value) => set('liquidityLookbackSessions', value)} suffix="営業日" type="number" inputMode="numeric" min={1} max={252} />
            </div>
          </details>

          <details className="group">
            <DisclosureSummary
              meta={stageAxisCount > 0
                ? <span className="font-normal text-[var(--color-text-secondary)]">{stageAxisCount}軸を指定中</span>
                : <span className="font-normal text-[var(--color-text-tertiary)]">指定なし</span>}
            >
              6ステージで絞り込む
            </DisclosureSummary>
            <div className="mt-1.5 border-l-2 border-[var(--color-border-soft)] pb-1 pl-3">
              <p className="mb-2 text-[10px] leading-4 text-[var(--color-text-tertiary)]">軸ごとに対象の Stage を選びます。未選択の軸は条件に含めません。「—」は Stage 不明です。</p>
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => (
                  <div key={axis} role="group" aria-label={`${STAGE_AXIS_LABELS[axis]}の Stage`} className="flex flex-wrap items-center gap-1">
                    <span className="w-7 shrink-0 text-[10px] font-semibold text-[var(--color-text-secondary)]" aria-hidden>{STAGE_AXIS_LABELS[axis]}</span>
                    {STAGE_VALUES.map((value) => {
                      const selected = draft.stageFilters[axis]?.includes(value) ?? false
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => toggleStage(axis, value)}
                          aria-pressed={selected}
                          aria-label={`${STAGE_AXIS_LABELS[axis]} ${value === 'unknown' ? 'Stage不明' : `Stage ${value}`}`}
                          className={`h-7 min-w-7 rounded-[3px] border px-1 text-[10px] tabular-nums ${FOCUS_RING} ${selected ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-50)] font-semibold text-[var(--color-brand-800)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-300)]'}`}
                        >
                          {value === 'unknown' ? '—' : value}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
              {stageAxisCount > 0 && (
                <button
                  type="button"
                  onClick={() => onDraftChange((current) => ({ ...current, stageFilters: {} }))}
                  className={`mt-2 h-8 rounded-[3px] px-2 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-brand-700)] ${FOCUS_RING}`}
                >
                  Stage の選択をクリア
                </button>
              )}
            </div>
          </details>
        </div>
      </section>

      <div data-us-trigger-action-bar className="flex flex-col gap-2.5 bg-[var(--color-surface-subtle)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="break-words text-[11px] font-medium tabular-nums text-[var(--color-text-secondary)]">{draftSummary}</p>
          <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
            入力を変えても自動では検索しません。保存・通知は米国株専用、期間検証は日本株のみ対応しています。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {hasResult && !loading && (
            <button type="button" onClick={onClose} className="btn" data-variant="ghost">
              <ChevronUp size={13} aria-hidden />変更せずに閉じる
            </button>
          )}
          {loading && (
            <button type="button" onClick={onCancelSearch} className="btn">
              <X size={13} aria-hidden />中止
            </button>
          )}
          <button
            type="submit"
            disabled={loading}
            className="btn min-w-[168px] flex-1 sm:flex-none"
            data-variant="primary"
            data-size="lg"
          >
            {loading ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <Search size={15} aria-hidden />}
            {loading ? '検索中…' : 'Triggerを検索'}
          </button>
        </div>
      </div>
    </form>
  )
}
