'use client'

// components/us/trigger-discovery/UsSavedTriggerBar.tsx
//
// US 条件トリガーの「保存済みTrigger」帯。検索フォームと結果の間に 1 段で置く。
// - API は US 専用 (/api/us/trigger-discovery/saved/**) だけを使う。日本株の保存 API は呼ばない
// - 基準日は保存しない。読込時は親が最新データ日で request を組み直して即時検索する
// - 「最新を評価」は明示操作のときだけ実行する (自動実行しない)。結果は評価日・候補数・再利用だけを短く出す
// - 通知設定は既存の TriggerNotificationSettingsPanel を US の apiBase で再利用する (メール送信は行わない)
// - 比較・保存に使う設定値 (currentConfigs) は親が buildUsTriggerRequest から作って渡す。ここでは再計算しない

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Bookmark, Copy, LoaderCircle, Pencil, Play, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { TriggerNotificationSettingsPanel } from '@/components/trigger-discovery/TriggerNotificationSettingsPanel'
import { fmtCount } from '@/components/us/UsMarketMomentumParts'
import { FOCUS_RING } from '@/components/us/trigger-discovery/UsTriggerControls'
import { timeframeLabel } from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'
import {
  SAVED_TRIGGER_CONTRACT_VERSION,
  SAVED_TRIGGER_NAME_MAX_LENGTH,
  type SavedTriggerDefinition,
  type SavedTriggerDetailResponse,
  type SavedTriggerEvaluationConfig,
  type SavedTriggerListResponse,
  type SavedTriggerViewConfig,
} from '@/lib/trigger-definition'
import {
  TRIGGER_EVALUATION_CONTRACT_VERSION,
  type TriggerEvaluationRunResponse,
} from '@/lib/trigger-evaluation'

export const US_SAVED_TRIGGER_API_BASE = '/api/us/trigger-discovery/saved'

export interface UsSavedTriggerConfigs {
  evaluationConfig: SavedTriggerEvaluationConfig
  viewConfig: SavedTriggerViewConfig
}

type SaveMode = 'create' | 'copy' | 'rename'
type PendingAction = 'load' | 'save' | 'update' | 'archive'

interface EvaluationSummary {
  definitionId: string
  resolvedAsOf: string
  finalMatched: number
  reused: boolean
}

const SAVE_MODE_LABELS: Record<SaveMode, string> = {
  create: '新規保存',
  copy: '別名で保存',
  rename: '名前を変更',
}

const SELECT_CLASS = 'h-8 min-w-0 flex-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-500)] focus:ring-1 focus:ring-[var(--color-brand-100)] disabled:text-[var(--color-text-tertiary)]'

/** キー順に依存しない比較用の文字列。サーバーから戻った JSON とクライアントの正規化結果を比べる */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function messageFrom(body: unknown): string | null {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' && body.message) {
    return body.message
  }
  return null
}

async function requestJson(url: string, init: RequestInit, fallback: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('通信に失敗しました。接続を確認して再度お試しください。')
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) throw new Error(messageFrom(body) ?? fallback)
  return body
}

function definitionFrom(body: unknown, fallback: string): SavedTriggerDefinition {
  const detail = body as SavedTriggerDetailResponse | null
  if (!detail || !('definition' in detail) || !detail.definition) throw new Error(fallback)
  if (detail.contractVersion !== SAVED_TRIGGER_CONTRACT_VERSION) throw new Error('保存済みTriggerの形式が想定と異なります。ページを再読み込みしてください。')
  return detail.definition
}

async function fetchSavedDefinitions(signal: AbortSignal | undefined): Promise<SavedTriggerDefinition[]> {
  const body = await requestJson(US_SAVED_TRIGGER_API_BASE, { signal }, '保存済みTriggerを取得できませんでした。') as SavedTriggerListResponse | null
  if (!body || !Array.isArray(body.definitions)) throw new Error('保存済みTriggerを取得できませんでした。')
  if (body.contractVersion !== SAVED_TRIGGER_CONTRACT_VERSION) throw new Error('保存済みTriggerの形式が想定と異なります。ページを再読み込みしてください。')
  return body.definitions
}

export function UsSavedTriggerBar({
  activeId,
  onActiveIdChange,
  currentConfigs,
  currentConfigsError,
  latestAsOf,
  onLoad,
}: {
  /** 読込・保存済みで、現在のフォームの基になっている定義 */
  activeId: string | null
  onActiveIdChange: (id: string | null) => void
  /** savedTriggerConfigsFromSearchRequest(buildUsTriggerRequest(...)) の結果。入力が不正なら null */
  currentConfigs: UsSavedTriggerConfigs | null
  currentConfigsError: string | null
  latestAsOf: string | null
  /** 定義を draft/view へ戻して検索する (親が最新データ日で request を組む) */
  onLoad: (definition: SavedTriggerDefinition) => void
}) {
  const [definitions, setDefinitions] = useState<SavedTriggerDefinition[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listReload, setListReload] = useState(0)
  const [selectedId, setSelectedId] = useState(activeId ?? '')
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [saveMode, setSaveMode] = useState<SaveMode | null>(null)
  const [saveName, setSaveName] = useState('')
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null)
  const [evaluation, setEvaluation] = useState<EvaluationSummary | null>(null)

  const lifecycle = useRef<AbortController | null>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const editorOpener = useRef<HTMLElement | null>(null)

  const activeDefinition = definitions.find((definition) => definition.id === activeId) ?? null
  const hasUnsavedChanges = Boolean(activeDefinition) && (
    !currentConfigs
    || stableStringify(currentConfigs.evaluationConfig) !== stableStringify(activeDefinition!.evaluationConfig)
    || stableStringify(currentConfigs.viewConfig) !== stableStringify(activeDefinition!.viewConfig)
  )
  const busy = pending != null
  const activeEvaluation = evaluation && evaluation.definitionId === activeDefinition?.id ? evaluation : null
  const evaluatingActive = evaluatingId != null && evaluatingId === activeDefinition?.id

  /* ---------- lifecycle ---------- */

  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    return () => controller.abort()
  }, [])

  // 銘柄詳細からの復元などで親の activeId が変わったら、選択欄も合わせる。
  useEffect(() => {
    setSelectedId(activeId ?? '')
  }, [activeId])

  useEffect(() => {
    const controller = new AbortController()
    setListState('loading')
    void (async () => {
      try {
        const next = await fetchSavedDefinitions(controller.signal)
        if (controller.signal.aborted) return
        setDefinitions(next)
        setListState('ready')
      } catch (loadError) {
        if (controller.signal.aborted) return
        setListState('error')
        setError(loadError instanceof Error ? loadError.message : '保存済みTriggerを取得できませんでした。')
      }
    })()
    return () => controller.abort()
  }, [listReload])

  useEffect(() => {
    if (saveMode) nameInputRef.current?.focus()
  }, [saveMode])

  /* ---------- helpers ---------- */

  const isAborted = () => lifecycle.current?.signal.aborted ?? true

  const startAction = (action: PendingAction) => {
    setPending(action)
    setError(null)
    setMessage(null)
  }

  const fail = (actionError: unknown, fallback: string) => {
    if (isAborted()) return
    if (actionError instanceof DOMException && actionError.name === 'AbortError') return
    setError(actionError instanceof Error ? actionError.message : fallback)
  }

  const restoreFocus = () => {
    window.requestAnimationFrame(() => {
      const opener = editorOpener.current
      editorOpener.current = null
      if (opener && opener.isConnected && !(opener as HTMLButtonElement).disabled) opener.focus()
      else selectRef.current?.focus()
    })
  }

  /** 一覧を取り直す。失敗しても直前の操作結果は残す */
  const refreshList = async (ensure?: SavedTriggerDefinition) => {
    try {
      const next = await fetchSavedDefinitions(lifecycle.current?.signal)
      if (isAborted()) return
      setDefinitions(ensure && !next.some((definition) => definition.id === ensure.id) ? [ensure, ...next] : next)
      setListState('ready')
    } catch {
      if (isAborted() || !ensure) return
      setDefinitions((current) => [ensure, ...current.filter((definition) => definition.id !== ensure.id)])
    }
  }

  /* ---------- 読込 ---------- */

  const loadSelected = async () => {
    if (!selectedId || busy) return
    startAction('load')
    setSaveMode(null)
    try {
      const body = await requestJson(
        `${US_SAVED_TRIGGER_API_BASE}/${encodeURIComponent(selectedId)}`,
        { signal: lifecycle.current?.signal },
        '保存済みTriggerを読み込めませんでした。',
      )
      const definition = definitionFrom(body, '保存済みTriggerを読み込めませんでした。')
      if (isAborted()) return
      setDefinitions((current) => current.map((item) => (item.id === definition.id ? definition : item)))
      onActiveIdChange(definition.id)
      onLoad(definition)
      setMessage(`「${definition.name}」を読み込みました。基準日は最新データ日（${latestAsOf ?? '—'}）です。`)
    } catch (loadError) {
      fail(loadError, '保存済みTriggerを読み込めませんでした。')
    } finally {
      if (!isAborted()) setPending(null)
    }
  }

  /* ---------- 保存 ---------- */

  const openEditor = (mode: SaveMode, opener: HTMLElement) => {
    editorOpener.current = opener
    setSaveMode(mode)
    setSaveName(mode === 'rename' ? activeDefinition?.name ?? '' : mode === 'copy' && activeDefinition ? `${activeDefinition.name} のコピー`.slice(0, SAVED_TRIGGER_NAME_MAX_LENGTH) : '')
    setError(null)
    setMessage(null)
  }

  const closeEditor = () => {
    setSaveMode(null)
    setSaveName('')
    restoreFocus()
  }

  const submitEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!saveMode || busy) return
    const name = saveName.trim()
    if (!name) {
      setError('Trigger名を入力してください。')
      nameInputRef.current?.focus()
      return
    }
    if (saveMode !== 'rename' && !currentConfigs) {
      setError(currentConfigsError ?? '検索条件を確認してください。')
      return
    }
    if (saveMode === 'rename' && !activeDefinition) return
    const mode = saveMode
    startAction('save')
    try {
      const isRename = mode === 'rename'
      const body = await requestJson(
        isRename ? `${US_SAVED_TRIGGER_API_BASE}/${encodeURIComponent(activeDefinition!.id)}` : US_SAVED_TRIGGER_API_BASE,
        {
          method: isRename ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isRename ? { name } : { name, ...currentConfigs }),
          signal: lifecycle.current?.signal,
        },
        isRename ? '名前を変更できませんでした。' : 'Trigger条件を保存できませんでした。',
      )
      const definition = definitionFrom(body, '保存結果を確認できませんでした。')
      if (isAborted()) return
      await refreshList(definition)
      if (isAborted()) return
      onActiveIdChange(definition.id)
      setSelectedId(definition.id)
      setSaveMode(null)
      setSaveName('')
      setMessage(isRename ? `名前を「${definition.name}」に変更しました。` : `「${definition.name}」を保存しました。`)
      restoreFocus()
    } catch (saveError) {
      fail(saveError, '保存できませんでした。')
    } finally {
      if (!isAborted()) setPending(null)
    }
  }

  const overwrite = async () => {
    if (!activeDefinition || busy) return
    if (!currentConfigs) {
      setError(currentConfigsError ?? '検索条件を確認してください。')
      return
    }
    startAction('update')
    setSaveMode(null)
    try {
      const body = await requestJson(
        `${US_SAVED_TRIGGER_API_BASE}/${encodeURIComponent(activeDefinition.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentConfigs),
          signal: lifecycle.current?.signal,
        },
        '上書き保存できませんでした。',
      )
      const definition = definitionFrom(body, '保存結果を確認できませんでした。')
      if (isAborted()) return
      setDefinitions((current) => current.map((item) => (item.id === definition.id ? definition : item)))
      setMessage(`「${definition.name}」を現在の条件で上書きしました。`)
    } catch (updateError) {
      fail(updateError, '上書き保存できませんでした。')
    } finally {
      if (!isAborted()) setPending(null)
    }
  }

  /* ---------- アーカイブ ---------- */

  const archive = async () => {
    if (!activeDefinition || busy) return
    if (!window.confirm(`「${activeDefinition.name}」をアーカイブしますか？\n一覧と通知の対象から外れます。現在の検索条件と結果はそのまま残ります。`)) return
    const target = activeDefinition
    startAction('archive')
    setSaveMode(null)
    try {
      const body = await requestJson(
        `${US_SAVED_TRIGGER_API_BASE}/${encodeURIComponent(target.id)}`,
        { method: 'DELETE', signal: lifecycle.current?.signal },
        'アーカイブできませんでした。',
      ) as { archived?: unknown } | null
      if (body?.archived !== true) throw new Error('アーカイブできませんでした。')
      if (isAborted()) return
      setDefinitions((current) => current.filter((definition) => definition.id !== target.id))
      onActiveIdChange(null)
      setSelectedId('')
      setEvaluation((current) => (current?.definitionId === target.id ? null : current))
      setMessage(`「${target.name}」をアーカイブしました。現在の検索条件はそのままです。`)
      window.requestAnimationFrame(() => selectRef.current?.focus())
      void refreshList()
    } catch (archiveError) {
      fail(archiveError, 'アーカイブできませんでした。')
    } finally {
      if (!isAborted()) setPending(null)
    }
  }

  /* ---------- 最新を評価 (明示操作のみ) ---------- */

  const evaluateLatest = async () => {
    if (!activeDefinition || !latestAsOf || evaluatingId) return
    const target = activeDefinition
    setEvaluatingId(target.id)
    setError(null)
    setMessage(null)
    try {
      const body = await requestJson(
        `${US_SAVED_TRIGGER_API_BASE}/${encodeURIComponent(target.id)}/evaluate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestedAsOf: latestAsOf }),
          signal: lifecycle.current?.signal,
        },
        '評価を完了できませんでした。時間をおいて再度お試しください。',
      ) as TriggerEvaluationRunResponse | null
      if (!body?.evaluation || body.contractVersion !== TRIGGER_EVALUATION_CONTRACT_VERSION) {
        throw new Error('評価結果の形式が想定と異なります。ページを再読み込みしてください。')
      }
      if (body.evaluation.status === 'FAILED') throw new Error('評価を完了できませんでした。時間をおいて再度お試しください。')
      if (isAborted()) return
      setEvaluation({
        definitionId: target.id,
        resolvedAsOf: body.evaluation.resolvedAsOf,
        finalMatched: body.evaluation.counts.finalMatched,
        reused: body.reused,
      })
    } catch (evaluateError) {
      fail(evaluateError, '評価を完了できませんでした。')
    } finally {
      if (!isAborted()) setEvaluatingId(null)
    }
  }

  /* ---------- 表示 ---------- */

  const emptyLabel = listState === 'loading'
    ? '読み込み中…'
    : listState === 'error'
      ? '一覧を取得できません'
      : definitions.length
        ? '保存済みTriggerを選択'
        : '保存済みのTriggerはありません'

  const statusText = message
    ?? (activeEvaluation
      ? `${activeEvaluation.resolvedAsOf} 時点で評価：候補 ${fmtCount(activeEvaluation.finalMatched)}件${activeEvaluation.reused ? '（同じ条件・日付の評価を再利用）' : ''}`
      : '')

  return (
    <section
      data-us-saved-trigger-bar
      aria-labelledby="us-saved-trigger-heading"
      aria-busy={busy || listState === 'loading'}
      className="panel px-3 py-2.5 sm:px-3.5"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h2 id="us-saved-trigger-heading" className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            <Bookmark size={13} aria-hidden />保存済みTrigger
          </h2>
          <div className="flex min-w-0 flex-1 basis-56 items-center gap-1.5 sm:max-w-[400px]">
            <select
              ref={selectRef}
              aria-label="保存済みTrigger"
              value={selectedId}
              disabled={listState !== 'ready' || busy || definitions.length === 0}
              onChange={(event) => setSelectedId(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">{emptyLabel}</option>
              {definitions.map((definition) => (
                <option key={definition.id} value={definition.id}>{definition.name}｜{timeframeLabel(definition.evaluationConfig.timeframe)}</option>
              ))}
            </select>
            {listState === 'error' ? (
              <button type="button" className={`btn shrink-0 ${FOCUS_RING}`} onClick={() => { setError(null); setListReload((value) => value + 1) }}>
                <RefreshCw size={12} aria-hidden />再取得
              </button>
            ) : (
              <button
                type="button"
                className={`btn shrink-0 text-[var(--color-brand-700)] ${FOCUS_RING}`}
                disabled={!selectedId || busy}
                onClick={() => void loadSelected()}
              >
                {pending === 'load' ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : null}
                読み込む
              </button>
            )}
          </div>
          {activeDefinition && (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
              <span className="shrink-0 text-[var(--color-text-tertiary)]">編集中</span>
              <strong className="min-w-0 max-w-[220px] truncate font-medium text-[var(--color-text-primary)]" title={activeDefinition.name}>{activeDefinition.name}</strong>
              <span className="shrink-0 rounded-[3px] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-medium">{timeframeLabel(activeDefinition.evaluationConfig.timeframe)}</span>
              {hasUnsavedChanges
                ? <strong className="shrink-0 rounded-[3px] bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800">未保存の変更</strong>
                : <span className="shrink-0 text-[var(--color-text-tertiary)]">保存済み</span>}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="保存済みTriggerの操作">
          {activeDefinition ? (
            <>
              <button
                type="button"
                className={`btn ${FOCUS_RING}`}
                disabled={busy || !hasUnsavedChanges}
                aria-describedby="us-saved-trigger-note"
                onClick={() => void overwrite()}
              >
                {pending === 'update' ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <Save size={12} aria-hidden />}
                上書き保存
              </button>
              <button type="button" className={`btn ${FOCUS_RING}`} disabled={busy} onClick={(event) => openEditor('copy', event.currentTarget)}>
                <Copy size={12} aria-hidden />別名で保存
              </button>
              <button type="button" className={`btn ${FOCUS_RING}`} disabled={busy} onClick={(event) => openEditor('rename', event.currentTarget)}>
                <Pencil size={12} aria-hidden />名前変更
              </button>
              <button
                type="button"
                className={`btn ${FOCUS_RING}`}
                disabled={!latestAsOf || evaluatingId != null || pending === 'archive'}
                aria-describedby="us-saved-trigger-note"
                onClick={() => void evaluateLatest()}
              >
                {evaluatingActive ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <Play size={12} aria-hidden />}
                {evaluatingActive ? '評価中…' : '最新を評価'}
              </button>
              <TriggerNotificationSettingsPanel key={activeDefinition.id} definition={activeDefinition} apiBase={US_SAVED_TRIGGER_API_BASE} />
              <button
                type="button"
                disabled={busy || evaluatingActive}
                onClick={() => void archive()}
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-text-tertiary)] hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
                aria-label={`「${activeDefinition.name}」をアーカイブ`}
                title="アーカイブ"
              >
                {pending === 'archive' ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <Trash2 size={13} aria-hidden />}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`btn ${FOCUS_RING}`}
              disabled={busy || listState === 'loading'}
              onClick={(event) => openEditor('create', event.currentTarget)}
            >
              <Save size={12} aria-hidden />現在の条件を保存
            </button>
          )}
        </div>
      </div>

      {saveMode && (
        <form
          onSubmit={(event) => void submitEditor(event)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.preventDefault()
              closeEditor()
            }
          }}
          className="mt-2 flex min-w-0 flex-wrap items-center gap-2 border-l-2 border-[var(--color-brand-300)] pl-2"
        >
          <label htmlFor="us-saved-trigger-name" className="shrink-0 text-[10px] font-semibold text-[var(--color-text-secondary)]">{SAVE_MODE_LABELS[saveMode]}</label>
          <input
            id="us-saved-trigger-name"
            ref={nameInputRef}
            value={saveName}
            maxLength={SAVED_TRIGGER_NAME_MAX_LENGTH}
            required
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setSaveName(event.target.value)}
            placeholder="Trigger名"
            className="h-8 min-w-0 flex-1 basis-40 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] outline-none focus:border-[var(--color-brand-500)] focus:ring-1 focus:ring-[var(--color-brand-100)] sm:max-w-[320px]"
          />
          <button type="submit" className={`btn ${FOCUS_RING}`} data-variant="primary" disabled={busy || !saveName.trim()}>
            {pending === 'save' ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <Save size={12} aria-hidden />}
            {saveMode === 'rename' ? '名前を更新' : '保存する'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={closeEditor}
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-muted)] disabled:opacity-40 ${FOCUS_RING}`}
            aria-label="保存をキャンセル"
            title="キャンセル（Esc）"
          >
            <X size={13} aria-hidden />
          </button>
        </form>
      )}

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
        <span id="us-saved-trigger-note" className="min-w-0">
          {activeDefinition && hasUnsavedChanges
            ? '未保存の変更は通知・評価に含まれません。評価は保存済みの条件で行います。'
            : `基準日は保存されません。読み込み・評価は最新データ日（${latestAsOf ?? '—'}）で行います。`}
        </span>
        {error && <span role="alert" className="min-w-0 text-red-700">{error}</span>}
        <span role="status" aria-live="polite" className={`min-w-0 tabular-nums ${statusText ? 'text-[var(--color-brand-700)]' : 'sr-only'}`}>
          {statusText}
        </span>
      </div>
    </section>
  )
}
