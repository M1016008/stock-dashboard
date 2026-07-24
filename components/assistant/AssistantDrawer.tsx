'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Bot, ChevronRight, Loader2, MessageSquareText, Send, Sparkles, X } from 'lucide-react'
import type { AssistantChatResponse, AssistantConversationMessage, AssistantPageContext, AssistantResultRow } from '@/lib/assistant/types'

interface AssistantStatusResponse {
  enabled: boolean
  configured: boolean
  model: string | null
  reason?: AssistantChatResponse['openai']['reason']
}

interface AssistantChatEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  response?: AssistantChatResponse
}

function marketFromPath(pathname: string): AssistantPageContext['market'] {
  if (pathname.startsWith('/us')) return 'US'
  if (pathname.startsWith('/commodities')) return 'COMMODITY'
  return 'JP'
}

function tickerFromPath(pathname: string): string | null {
  const jp = pathname.match(/^\/stock\/([^/?#]+)/)
  if (jp?.[1]) return decodeURIComponent(jp[1])
  const us = pathname.match(/^\/us\/stock\/([^/?#]+)/)
  if (us?.[1]) return decodeURIComponent(us[1])
  return null
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString()
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function formatScore(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2)
}

function formatRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

function formatLift(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function openAiStatusLabel(response: AssistantChatResponse): string {
  if (response.source === 'openai') return `OpenAI / ${response.model}`
  const status = response.openai
  if (!status?.enabled) return 'ローカル判定フォールバック / OpenAIアシスタント無効'
  if (!status?.configured) return 'ローカル判定フォールバック / OPENAI_API_KEY未設定'
  if (status.reason === 'placeholder_api_key') return 'ローカル判定フォールバック / OpenAIキーがプレースホルダー'
  if (status.reason === 'api_error') return `ローカル判定フォールバック / OpenAI API ${status.statusCode ?? ''}`.trim()
  if (status.reason === 'invalid_response') return 'ローカル判定フォールバック / OpenAI応答形式を確認'
  if (status.reason === 'parse_error') return 'ローカル判定フォールバック / OpenAI JSON解析失敗'
  if (status.reason === 'request_failed') return 'ローカル判定フォールバック / OpenAI接続失敗'
  return 'ローカル判定フォールバック'
}

export function assistantStatusText(status: AssistantStatusResponse | null): string {
  if (!status) return 'OpenAI接続状態を確認中...'
  if (!status.enabled) return 'OpenAIアシスタントは無効化されています。ローカル判定で動作します。'
  if (status.reason === 'placeholder_api_key') return 'OPENAI_API_KEY がプレースホルダーです。有効なキーを .env.local に設定してください。'
  if (!status.configured) return 'OPENAI_API_KEY 未設定です。ローカル判定で動作します。'
  return `OpenAI接続設定あり / ${status.model}`
}

function ResultRowCard({ row }: { row: AssistantResultRow }) {
  const content = (
    <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-3 transition-colors hover:border-[var(--color-brand-500)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {row.ticker && <span className="font-mono text-[12px] font-black text-[var(--color-brand-800)]">{row.ticker}</span>}
            <span className="truncate text-[13px] font-black text-[var(--color-text-primary)]">{row.name ?? row.ticker ?? '候補'}</span>
            {row.stageCode && (
              <span className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-1.5 py-0.5 font-mono text-[10px] font-bold">
                {row.stageCode}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            {row.price != null && <span>株価 {formatNumber(row.price)}</span>}
            {row.changePct != null && (
              <span className={row.changePct >= 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'}>
                {formatPct(row.changePct)}
              </span>
            )}
            {row.avgVolume20d != null && <span>20日平均出来高 {formatNumber(row.avgVolume20d)}</span>}
            {row.avgVolume20d == null && row.avgVolume30d != null && <span>平均出来高 {formatNumber(row.avgVolume30d)}</span>}
            {row.marginType && <span>{row.marginType}</span>}
            {row.rank != null && <span>#{row.rank}</span>}
            {row.physicalMomentumScore != null && <span>PMS {formatScore(row.physicalMomentumScore)}</span>}
            {row.physicalForceScore != null && <span>PFS {formatScore(row.physicalForceScore)}</span>}
            {row.shortTermCheckLabel && <span>{row.shortTermCheckLabel}</span>}
          </div>
          {row.reason && <p className="mt-2 line-clamp-4 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">{row.reason}</p>}
          {(row.modelEvidence?.length || row.mlEvidenceSummary) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {row.modelEvidence?.map((evidence) => (
                <span
                  key={`${row.ticker}-${evidence.direction}-${evidence.horizonDays}`}
                  className={`rounded-[3px] border px-2 py-1 text-[10px] font-black ${
                    evidence.direction === 'down'
                      ? 'border-[rgba(30,64,175,0.28)] bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
                      : 'border-[rgba(185,28,28,0.28)] bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
                  }`}
                  title={`評価日 ${evidence.evaluationDate ?? '-'} / サンプル ${evidence.sampleCount?.toLocaleString() ?? '-'}`}
                >
                  過去検証 {evidence.direction === 'down' ? '下落' : '上昇'}{evidence.horizonDays}日 top60 {formatRate(evidence.top60HitRate)} lift {formatLift(evidence.liftTop60VsBaseline)}
                  {evidence.top60AdverseRate != null ? ` 逆行 ${formatRate(evidence.top60AdverseRate)}` : ''}
                </span>
              ))}
              {row.mlEvidenceSummary && (
                <span className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
                  {row.mlEvidenceSummary}
                </span>
              )}
            </div>
          )}
        </div>
        {row.href && <ChevronRight size={16} className="mt-1 shrink-0 text-[var(--color-text-tertiary)]" />}
      </div>
    </div>
  )
  return row.href ? (
    <Link
      href={row.href}
      prefetch={false}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
      title="別タブで開く"
    >
      {content}
    </Link>
  ) : content
}

export function AssistantResponseCard({ response, onRun }: { response: AssistantChatResponse; onRun: (message: string) => void }) {
  return (
    <div className="space-y-3">
      <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[12px] font-black text-[var(--color-text-primary)]">
            {response.responseType === 'clarify' ? '確認したいこと' : 'データに基づく回答'}
          </span>
          <span className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-1.5 py-0.5 text-[9px] font-black text-[var(--color-text-tertiary)]">
            {response.responseType === 'clarify' ? '聞き返し' : 'DB検索'}
          </span>
        </div>
        <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">{response.message}</p>
        {response.interpretedConditions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {response.interpretedConditions.map((condition) => (
              <span key={condition} className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] font-bold text-[var(--color-text-secondary)]">
                {condition}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          {openAiStatusLabel(response)}
        </div>
      </div>

      {response.clarificationQuestions.length > 0 && (
        <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-3">
          <div className="mb-2 text-[11px] font-black text-[var(--color-text-primary)]">このまま答えられます</div>
          <div className="flex flex-wrap gap-2">
            {response.clarificationQuestions.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onRun(item)}
                className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-1.5 text-left text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}

      {response.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {response.actions.map((action) => (
            <Link
              key={`${action.label}-${action.href}`}
              href={action.href}
              prefetch={false}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--color-brand-600)] bg-white px-3 py-2 text-[11px] font-black text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]"
            >
              {action.label}
              <ChevronRight size={13} />
            </Link>
          ))}
        </div>
      )}

      {response.sections.map((section) => (
        <section key={`${section.tool}-${section.title}`} className="rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
          <div className="mb-2">
            <div className="text-[12px] font-black text-[var(--color-text-primary)]">{section.title}</div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{section.summary}</p>
          </div>
          <div className="space-y-2">
            {section.rows.slice(0, 8).map((row, index) => (
              <ResultRowCard key={`${section.tool}-${row.ticker ?? index}-${index}`} row={row} />
            ))}
            {section.rows.length === 0 && (
              <div className="rounded-[6px] border border-dashed border-[var(--color-border-default)] bg-white p-3 text-[11px] font-bold text-[var(--color-text-tertiary)]">
                条件に合う表示候補はありませんでした。
              </div>
            )}
          </div>
        </section>
      ))}

      {response.followups.length > 0 && (
        <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-3">
          <div className="mb-2 text-[11px] font-black text-[var(--color-text-primary)]">続けて聞く</div>
          <div className="flex flex-wrap gap-2">
            {response.followups.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onRun(item)}
                className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-1.5 text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function AssistantDrawer() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<AssistantChatEntry[]>([])
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatusResponse | null>(null)
  const ticker = tickerFromPath(pathname)
  const context = useMemo<AssistantPageContext>(() => ({
    pathname,
    search: searchParams.toString(),
    ticker,
    market: marketFromPath(pathname),
    universe: searchParams.get('universe'),
  }), [pathname, searchParams, ticker])
  const suggestions = useMemo(() => {
    if (ticker) {
      return [
        `${ticker}に似た銘柄を探して`,
        `${ticker}の下落リスクを見て`,
        'この銘柄と同じ形で、まだ初動っぽい候補を探して',
      ]
    }
    if (pathname.startsWith('/earnings')) {
      return ['決算が近くて出来高が多い銘柄', '日経225で決算前の上昇候補', '貸借銘柄だけに絞って']
    }
    if (pathname.startsWith('/hex-stage')) {
      return ['日経225で好転候補を探して', '下落警戒が強い貸借銘柄', '出来高が多い順で候補を出して']
    }
    return ['日経225で初動候補を探して', '下落警戒が強い銘柄', '良さそうな銘柄を相談したい']
  }, [pathname, ticker])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/assistant/status', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((json) => {
        if (!cancelled && json) setAssistantStatus(json as AssistantStatusResponse)
      })
      .catch(() => {
        if (!cancelled) setAssistantStatus(null)
      })
    return () => { cancelled = true }
  }, [open])

  const run = async (message: string) => {
    const text = message.trim()
    if (!text || loading) return
    setOpen(true)
    setInput('')
    setLoading(true)
    setError(null)
    const userEntry: AssistantChatEntry = {
      id: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: 'user',
      content: text,
    }
    const history: AssistantConversationMessage[] = messages
      .map((item) => ({ role: item.role, content: item.content }))
      .slice(-8)
    setMessages((prev) => [...prev, userEntry])
    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context, history }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? 'AIアシスタントの実行に失敗しました。')
      const assistantResponse = json as AssistantChatResponse
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: assistantResponse.message,
          response: assistantResponse,
        },
      ])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void run(input)
  }

  if (pathname.startsWith('/ai/research')) return null

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-3 z-50 inline-flex h-11 w-11 items-center justify-center gap-2 rounded-[6px] border border-[var(--color-brand-700)] bg-[var(--color-brand-800)] px-0 text-[13px] font-black text-white shadow-[0_12px_30px_rgba(16,32,52,0.28)] transition-colors hover:bg-[var(--color-brand-900)] xl:w-auto xl:px-3"
          style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
          aria-label="AI銘柄リサーチを開く"
          title="AI銘柄リサーチ"
        >
          <Sparkles size={17} strokeWidth={2.4} />
          <span className="hidden xl:inline">AI銘柄リサーチ</span>
        </button>
      )}

      {open && (
        <div
          className="fixed right-3 z-50 flex max-h-[calc(100dvh-24px)] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-[8px] border border-[var(--color-border-strong)] bg-white shadow-[0_18px_48px_rgba(16,32,52,0.30)]"
          style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border-default)] bg-[var(--color-brand-800)] px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-white/25 bg-white/10">
                <Bot size={18} />
              </span>
              <div>
                <div className="text-[13px] font-black">AI銘柄リサーチ</div>
                <div className="text-[10px] font-bold text-white/75">会話で条件化 / DB根拠で候補表示</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] hover:bg-white/10"
              aria-label="閉じる"
            >
              <X size={17} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto bg-[var(--color-surface-subtle)] p-4">
            <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              <div className="mb-2 flex items-center gap-2 font-black text-[var(--color-text-primary)]">
                <MessageSquareText size={15} />
                抽象的な相談から条件を具体化します
              </div>
              <div className="mb-2 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1.5 text-[10px] font-bold text-[var(--color-text-tertiary)]">
                {assistantStatusText(assistantStatus)}
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => void run(item)}
                    className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-1.5 text-left text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            {loading && (
              <div className="mt-3 flex items-center gap-2 rounded-[6px] border border-[var(--color-border-default)] bg-white p-3 text-[12px] font-bold text-[var(--color-text-secondary)]">
                <Loader2 size={15} className="animate-spin" />
                AIが必要な機能を選び、候補を取得しています。
              </div>
            )}

            {error && (
              <div className="mt-3 rounded-[6px] border border-[var(--color-price-down)] bg-white p-3 text-[12px] font-bold text-[var(--color-price-down)]">
                {error}
              </div>
            )}

            {messages.length > 0 && (
              <div className="mt-3 space-y-3">
                {messages.map((item) => (
                  <div key={item.id} className={item.role === 'user' ? 'ml-8' : 'mr-3'}>
                    {item.role === 'user' ? (
                      <div className="rounded-[6px] border border-[var(--color-brand-200)] bg-white p-3 text-[12px] font-bold leading-relaxed text-[var(--color-text-primary)]">
                        {item.content}
                      </div>
                    ) : item.response ? (
                      <AssistantResponseCard response={item.response} onRun={(next) => void run(next)} />
                    ) : (
                      <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                        {item.content}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={onSubmit} className="border-t border-[var(--color-border-default)] bg-white p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="例: 最近動き出しそうな貸借銘柄をPMSと6ステージ重視で探して"
                className="min-h-[46px] flex-1 resize-none rounded-[6px] border border-[var(--color-border-default)] px-3 py-2 text-[12px] font-semibold leading-relaxed outline-none focus:border-[var(--color-brand-600)]"
                rows={2}
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="inline-flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[6px] bg-[var(--color-brand-800)] text-white transition-colors hover:bg-[var(--color-brand-900)] disabled:cursor-not-allowed disabled:opacity-45"
                aria-label="送信"
              >
                {loading ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
              </button>
            </div>
            <div className="mt-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
              AIは読み取り専用のDB/APIだけを使います。根拠がない内容は候補として出さない設計です。
            </div>
          </form>
        </div>
      )}
    </>
  )
}
