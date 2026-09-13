'use client'

import { Bell, ChevronDown, LoaderCircle, Save, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { SavedTriggerDefinition } from '@/lib/trigger-definition'
import {
  MAX_CANDIDATES_IN_DIGEST,
  TRIGGER_NOTIFICATION_CONTRACT_VERSION,
  type TriggerNotificationSettings,
  type TriggerNotificationSettingsResponse,
  type TriggerNotificationSettingsValues,
} from '@/lib/trigger-notification'

type EventSettingKey = Exclude<
  keyof TriggerNotificationSettingsValues,
  'dailyDigestEnabled' | 'lifecycleAlertEnabled' | 'maxCandidatesInDigest'
>

interface NotificationDraft extends Omit<TriggerNotificationSettingsValues, 'maxCandidatesInDigest'> {
  maxCandidatesInDigest: string
}

const PRIMARY_EVENTS: Array<{ key: EventSettingKey; label: string }> = [
  { key: 'includeNew', label: '新規候補' },
  { key: 'includeReEntry', label: '再エントリー' },
  { key: 'includeStatusChangedToNear', label: 'NEAR入り' },
  { key: 'includeStatusChangedToInZone', label: 'Trigger Zone入り' },
  { key: 'includeRebounded', label: 'Zoneから反発' },
  { key: 'includeBrokeBelowZone', label: 'Zone下抜け' },
]

const EXIT_EVENTS: Array<{ key: EventSettingKey; label: string }> = [
  { key: 'includeCoreConditionExit', label: '基本条件から離脱' },
  { key: 'includeStageFilterExit', label: 'Stage条件から離脱' },
  { key: 'includeUniverseFilterExit', label: '市場・価格・流動性条件から離脱' },
  { key: 'includeDataUnavailable', label: 'データ不足・更新なし' },
  { key: 'includeOtherExited', label: 'その他の候補離脱' },
]

function draftFromSettings(settings: TriggerNotificationSettings): NotificationDraft {
  return {
    dailyDigestEnabled: settings.dailyDigestEnabled,
    lifecycleAlertEnabled: settings.lifecycleAlertEnabled,
    maxCandidatesInDigest: String(settings.maxCandidatesInDigest),
    includeNew: settings.includeNew,
    includeReEntry: settings.includeReEntry,
    includeStatusChangedToNear: settings.includeStatusChangedToNear,
    includeStatusChangedToInZone: settings.includeStatusChangedToInZone,
    includeRebounded: settings.includeRebounded,
    includeBrokeBelowZone: settings.includeBrokeBelowZone,
    includeCoreConditionExit: settings.includeCoreConditionExit,
    includeStageFilterExit: settings.includeStageFilterExit,
    includeUniverseFilterExit: settings.includeUniverseFilterExit,
    includeDataUnavailable: settings.includeDataUnavailable,
    includeOtherExited: settings.includeOtherExited,
  }
}

function valuesFromDraft(draft: NotificationDraft): TriggerNotificationSettingsValues | null {
  const maxCandidatesInDigest = Number(draft.maxCandidatesInDigest)
  if (!Number.isInteger(maxCandidatesInDigest)
    || maxCandidatesInDigest < 1
    || maxCandidatesInDigest > MAX_CANDIDATES_IN_DIGEST) return null
  return { ...draft, maxCandidatesInDigest }
}

function SwitchControl({ checked, label, onChange, disabled = false }: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-7 min-w-[68px] shrink-0 items-center gap-1.5 rounded-full border px-1.5 text-[9px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)] disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-text-tertiary)]'}`}
    >
      <span className={`h-4 w-4 rounded-full border border-black/10 bg-white shadow-sm transition-transform ${checked ? 'translate-x-[2px]' : ''}`} aria-hidden />
      <span>{checked ? 'ON' : 'OFF'}</span>
    </button>
  )
}

function EventCheckbox({ event, checked, disabled, onChange }: {
  event: { key: EventSettingKey; label: string }
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={`flex min-h-9 items-center gap-2 text-[11px] leading-4 ${disabled ? 'cursor-not-allowed text-[var(--color-text-tertiary)]' : 'cursor-pointer text-[var(--color-text-secondary)]'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(eventValue) => onChange(eventValue.target.checked)}
        className="h-4 w-4 shrink-0 accent-[var(--color-brand-700)]"
      />
      <span>{event.label}</span>
    </label>
  )
}

export function TriggerNotificationSettingsPanel({ definition }: {
  definition: SavedTriggerDefinition
}) {
  const panelId = useId()
  const panelTitleId = `${panelId}-title`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const requestSequence = useRef(0)
  const abortController = useRef<AbortController | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [serverSettings, setServerSettings] = useState<TriggerNotificationSettingsValues | null>(null)
  const [draft, setDraft] = useState<NotificationDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const draftValues = draft ? valuesFromDraft(draft) : null
  const dirty = Boolean(draft && serverSettings && (
    !draftValues || JSON.stringify(draftValues) !== JSON.stringify(serverSettings)
  ))

  const requestClose = () => {
    if (dirty && !window.confirm('未保存の通知設定を破棄して閉じますか？')) return
    abortController.current?.abort()
    requestSequence.current += 1
    setDraft(serverSettings ? { ...serverSettings, maxCandidatesInDigest: String(serverSettings.maxCandidatesInDigest) } : null)
    setError(null)
    setMessage(null)
    setOpen(false)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])

  useEffect(() => {
    if (!open) return
    abortController.current?.abort()
    const controller = new AbortController()
    abortController.current = controller
    const sequence = ++requestSequence.current
    setLoading(true)
    setError(null)
    setMessage(null)
    void (async () => {
      try {
        const response = await fetch(`/api/trigger-discovery/saved/${definition.id}/notification-settings`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const body = await response.json() as TriggerNotificationSettingsResponse | { message?: string }
        if (!response.ok || !('settings' in body)) {
          throw new Error('message' in body && body.message ? body.message : '通知設定を取得できませんでした。')
        }
        if (body.contractVersion !== TRIGGER_NOTIFICATION_CONTRACT_VERSION) {
          throw new Error('通知設定の契約バージョンが一致しません。')
        }
        if (sequence !== requestSequence.current) return
        const values = valuesFromDraft(draftFromSettings(body.settings))
        if (!values) throw new Error('通知設定の候補件数が有効範囲外です。')
        setServerSettings(values)
        setDraft(draftFromSettings(body.settings))
      } catch (loadError) {
        if (controller.signal.aborted || sequence !== requestSequence.current) return
        setError(loadError instanceof Error ? loadError.message : '通知設定を取得できませんでした。')
      } finally {
        if (sequence === requestSequence.current) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [definition.id, open, reloadToken])

  const updateBoolean = (key: Exclude<keyof NotificationDraft, 'maxCandidatesInDigest'>, value: boolean) => {
    setDraft((current) => current ? { ...current, [key]: value } : current)
    setError(null)
    setMessage(null)
  }

  const saveSettings = async () => {
    if (!draft) return
    const values = valuesFromDraft(draft)
    if (!values) {
      setError(`表示候補数は1〜${MAX_CANDIDATES_IN_DIGEST}件の整数で指定してください。`)
      return
    }
    abortController.current?.abort()
    const controller = new AbortController()
    abortController.current = controller
    const sequence = ++requestSequence.current
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch(`/api/trigger-discovery/saved/${definition.id}/notification-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
        cache: 'no-store',
        signal: controller.signal,
      })
      const body = await response.json() as TriggerNotificationSettingsResponse | { message?: string }
      if (!response.ok || !('settings' in body)) {
        throw new Error('message' in body && body.message ? body.message : '通知設定を保存できませんでした。')
      }
      if (body.contractVersion !== TRIGGER_NOTIFICATION_CONTRACT_VERSION) {
        throw new Error('通知設定の契約バージョンが一致しません。')
      }
      if (sequence !== requestSequence.current) return
      const savedValues = valuesFromDraft(draftFromSettings(body.settings))
      if (!savedValues) throw new Error('保存された通知設定の候補件数が有効範囲外です。')
      setServerSettings(savedValues)
      setDraft(draftFromSettings(body.settings))
      setMessage('通知設定を保存しました。')
    } catch (saveError) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setError(saveError instanceof Error ? saveError.message : '通知設定を保存できませんでした。')
    } finally {
      if (sequence === requestSequence.current) setSaving(false)
    }
  }

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    if (event.key !== 'Tab' || !panelRef.current) return
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
    ))
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const timeframeLabel = definition.evaluationConfig.timeframe === 'BIWEEKLY' ? '2週足' : '月足'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center gap-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] font-medium text-[var(--color-text-secondary)] outline-none hover:border-[var(--color-brand-300)] hover:text-[var(--color-brand-700)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      >
        <Bell size={12} aria-hidden />通知設定
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] flex justify-end">
          <button type="button" aria-label="通知設定を閉じる" onClick={requestClose} className="absolute inset-0 cursor-default bg-slate-950/25" />
          <section
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={panelTitleId}
            onKeyDown={handlePanelKeyDown}
            className="relative h-full w-full max-w-[680px] overflow-y-auto border-l border-[var(--color-border)] bg-white shadow-2xl"
          >
            <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id={panelTitleId} className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-[var(--color-text-primary)]"><Bell size={15} aria-hidden />通知設定</h2>
                    {dirty && <span className="rounded-[3px] bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800">通知設定に変更あり</span>}
                  </div>
                  <p className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]"><strong>{timeframeLabel}</strong><span className="mx-1.5 text-[var(--color-text-tertiary)]">｜</span>{definition.name}</p>
                </div>
                <button ref={closeRef} type="button" onClick={requestClose} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-text-tertiary)] outline-none hover:bg-[var(--color-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]" aria-label="通知設定を閉じる"><X size={16} aria-hidden /></button>
              </div>
            </header>

            <div className="px-4 py-5 sm:px-6">
              {loading && !draft ? (
                <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-[11px] text-[var(--color-text-secondary)]"><LoaderCircle size={15} className="animate-spin" aria-hidden />通知設定を読み込んでいます。</div>
              ) : error && !draft ? (
                <div className="border-l-2 border-red-500 bg-red-50 px-3 py-3 text-[11px] text-red-800">
                  <p role="alert">{error}</p>
                  <button type="button" onClick={() => setReloadToken((value) => value + 1)} className="mt-2 font-semibold underline underline-offset-2">再読み込み</button>
                </div>
              ) : draft ? (
                <>
                  <div className="grid gap-7 lg:grid-cols-2 lg:gap-8">
                    <section aria-labelledby={`${panelId}-digest`}>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 id={`${panelId}-digest`} className="text-[13px] font-semibold text-[var(--color-text-primary)]">毎日の候補まとめ</h3>
                          <p className="mt-1 text-[10px] leading-5 text-[var(--color-text-tertiary)]">毎日の評価結果から、現在のTrigger候補をまとめます。</p>
                        </div>
                        <SwitchControl checked={draft.dailyDigestEnabled} label="毎日の候補まとめ" disabled={saving} onChange={(checked) => updateBoolean('dailyDigestEnabled', checked)} />
                      </div>
                      <div className="mt-4 border-l-2 border-[var(--color-border-soft)] pl-3">
                        <label htmlFor={`${panelId}-digest-count`} className="block text-[10px] font-medium text-[var(--color-text-secondary)]">表示候補数</label>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
                          <span>上位</span>
                          <input
                            id={`${panelId}-digest-count`}
                            type="number"
                            min={1}
                            max={MAX_CANDIDATES_IN_DIGEST}
                            value={draft.maxCandidatesInDigest}
                            disabled={!draft.dailyDigestEnabled || saving}
                            onChange={(event) => {
                              setDraft((current) => current ? { ...current, maxCandidatesInDigest: event.target.value } : current)
                              setError(null)
                              setMessage(null)
                            }}
                            className="h-9 w-20 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-right text-[12px] tabular-nums outline-none focus:border-[var(--color-brand-500)] focus:ring-1 focus:ring-[var(--color-brand-100)] disabled:bg-[var(--color-surface-muted)] disabled:text-[var(--color-text-tertiary)]"
                          />
                          <span>件</span>
                        </div>
                        <p className="mt-2 text-[9px] leading-4 text-[var(--color-text-tertiary)]">候補の並び順は、このTriggerに保存されている並び順を使用します。</p>
                      </div>
                    </section>

                    <section aria-labelledby={`${panelId}-lifecycle`}>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h3 id={`${panelId}-lifecycle`} className="text-[13px] font-semibold text-[var(--color-text-primary)]">状態変化のお知らせ</h3>
                          <p className="mt-1 text-[10px] leading-5 text-[var(--color-text-tertiary)]">新規候補やTrigger Zoneへの接近・進入など、前回評価から変化があった銘柄をまとめます。</p>
                        </div>
                        <SwitchControl checked={draft.lifecycleAlertEnabled} label="状態変化のお知らせ" disabled={saving} onChange={(checked) => updateBoolean('lifecycleAlertEnabled', checked)} />
                      </div>
                      <fieldset className="mt-3" disabled={!draft.lifecycleAlertEnabled || saving}>
                        <legend className="sr-only">通知する状態変化</legend>
                        <div className="grid grid-cols-2 gap-x-3">
                          {PRIMARY_EVENTS.map((event) => (
                            <EventCheckbox key={event.key} event={event} checked={draft[event.key]} disabled={!draft.lifecycleAlertEnabled || saving} onChange={(checked) => updateBoolean(event.key, checked)} />
                          ))}
                        </div>
                        <details className="mt-2 border-t border-[var(--color-border-soft)] pt-2">
                          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[10px] font-medium text-[var(--color-brand-700)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]">
                            <ChevronDown size={12} aria-hidden />詳細な離脱通知
                          </summary>
                          <div className="mt-2 grid gap-x-3 sm:grid-cols-2">
                            {EXIT_EVENTS.map((event) => (
                              <EventCheckbox key={event.key} event={event} checked={draft[event.key]} disabled={!draft.lifecycleAlertEnabled || saving} onChange={(checked) => updateBoolean(event.key, checked)} />
                            ))}
                          </div>
                        </details>
                      </fieldset>
                    </section>
                  </div>

                  <p className="mt-6 border-t border-[var(--color-border-soft)] pt-3 text-[9px] leading-4 text-[var(--color-text-tertiary)]">Gmail自動配信は未設定です。通知設定をONにすると通知内容は生成されますが、メール送信は行われません。</p>
                  <div className="sticky bottom-0 -mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
                    <div className="min-h-4 text-[10px]">
                      {error ? <span role="alert" className="text-red-700">{error}</span> : message ? <span role="status" className="text-[var(--color-brand-700)]">{message}</span> : dirty ? <span className="text-amber-800">未保存の変更があります。</span> : <span className="text-[var(--color-text-tertiary)]">保存済みです。</span>}
                    </div>
                    <button type="button" disabled={saving || !dirty} onClick={() => void saveSettings()} className="inline-flex h-9 items-center gap-1.5 rounded-[3px] bg-[var(--color-brand-700)] px-4 text-[11px] font-semibold text-white outline-none hover:bg-[var(--color-brand-800)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)] disabled:cursor-not-allowed disabled:opacity-45">
                      {saving ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <Save size={13} aria-hidden />}
                      {saving ? '保存中…' : '通知設定を保存'}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </section>
        </div>
      )}
    </>
  )
}
