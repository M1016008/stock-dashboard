'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Bot,
  Database,
  Loader2,
  MessageSquareText,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { AssistantResponseCard, assistantStatusText } from '@/components/assistant/AssistantDrawer'
import type {
  AssistantChatResponse,
  AssistantConversationMessage,
  AssistantPageContext,
} from '@/lib/assistant/types'

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

const PROMPT_GROUPS = [
  {
    title: '初動候補',
    prompts: [
      '日経225で初動候補を10件探して。PMSと6ステージを重視',
      '貸借銘柄で好転候補を探して。出来高も多い順で',
      'プライム市場で短期チェックが強い銘柄を見せて',
    ],
  },
  {
    title: 'リスク確認',
    prompts: [
      '下落警戒が強い銘柄を貸借銘柄中心で探して',
      '直近で勢いが弱くなっている日経225銘柄を見せて',
      '上昇候補だけど逆行リスクが高そうな銘柄を確認したい',
    ],
  },
  {
    title: '個別深掘り',
    prompts: [
      '6905に似た銘柄を探して',
      '5020の現在の形に近い過去パターンを見たい',
      '近い決算予定で出来高が多い銘柄を5件見せて',
    ],
  },
] as const

function marketFromPath(pathname: string): AssistantPageContext['market'] {
  if (pathname.startsWith('/us')) return 'US'
  if (pathname.startsWith('/commodities')) return 'COMMODITY'
  return 'JP'
}

function AssistantMessage({ item, onRun }: { item: AssistantChatEntry; onRun: (message: string) => void }) {
  if (item.role === 'user') {
    return (
      <div className="ml-auto max-w-[820px] rounded-[6px] border border-[var(--color-brand-200)] bg-white px-4 py-3 text-[13px] font-bold leading-relaxed text-[var(--color-text-primary)] shadow-sm">
        {item.content}
      </div>
    )
  }

  return (
    <div className="max-w-[920px]">
      {item.response ? (
        <AssistantResponseCard response={item.response} onRun={onRun} />
      ) : (
        <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-4 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          {item.content}
        </div>
      )}
    </div>
  )
}

export function AssistantResearchClient() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<AssistantChatEntry[]>([])
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatusResponse | null>(null)

  const context = useMemo<AssistantPageContext>(() => ({
    pathname,
    search: searchParams.toString(),
    ticker: searchParams.get('ticker'),
    market: marketFromPath(pathname),
    universe: searchParams.get('universe'),
  }), [pathname, searchParams])

  useEffect(() => {
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
  }, [])

  const run = async (message: string) => {
    const text = message.trim()
    if (!text || loading) return
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
      .slice(-10)
    setMessages((prev) => [...prev, userEntry])

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context, history }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? 'AI銘柄リサーチの実行に失敗しました。')
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

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[8px] border border-[var(--color-border-strong)] bg-white">
        <div className="grid gap-0 lg:grid-cols-[1fr_360px]">
          <div className="border-b border-[var(--color-border-default)] bg-[var(--color-brand-800)] p-5 text-white lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-[5px] border border-white/25 bg-white/10">
                <Bot size={20} />
              </span>
              <div>
                <h1 className="text-[22px] font-black tracking-normal">AI銘柄リサーチ</h1>
                <p className="mt-1 text-[12px] font-bold text-white/75">
                  自然言語の相談を、StockBoard内のDB検索と分析機能へつなぎます。
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              <div className="rounded-[6px] border border-white/20 bg-white/10 p-3">
                <div className="flex items-center gap-2 text-[11px] font-black text-white">
                  <MessageSquareText size={14} />
                  聞き返し
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-white/72">
                  条件が曖昧なときは、期間・市場・方向性を確認します。
                </p>
              </div>
              <div className="rounded-[6px] border border-white/20 bg-white/10 p-3">
                <div className="flex items-center gap-2 text-[11px] font-black text-white">
                  <Database size={14} />
                  DB根拠
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-white/72">
                  6ステージ、PMS、決算、ML類似候補などの既存データを参照します。
                </p>
              </div>
              <div className="rounded-[6px] border border-white/20 bg-white/10 p-3">
                <div className="flex items-center gap-2 text-[11px] font-black text-white">
                  <ShieldCheck size={14} />
                  読み取り専用
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-white/72">
                  注文・DB更新・管理操作は行わず、候補抽出だけに限定します。
                </p>
              </div>
            </div>
          </div>
          <aside className="bg-[var(--color-surface-subtle)] p-5">
            <div className="rounded-[6px] border border-[var(--color-border-default)] bg-white p-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-black text-[var(--color-text-primary)]">
                <Sparkles size={15} />
                接続状態
              </div>
              <p className="text-[11px] font-bold leading-relaxed text-[var(--color-text-secondary)]">
                {assistantStatusText(assistantStatus)}
              </p>
            </div>
            <div className="mt-3 rounded-[6px] border border-[var(--color-border-default)] bg-white p-3">
              <div className="mb-2 text-[12px] font-black text-[var(--color-text-primary)]">使い方</div>
              <div className="space-y-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                <p>まずは抽象的に相談しても大丈夫です。必要ならAIが条件を聞き返します。</p>
                <p>候補が出たら、銘柄カードから個別ページやスクリーナーへ移動できます。</p>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)]">
          <div className="border-b border-[var(--color-border-default)] bg-white p-4">
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="flex items-center gap-2 text-[13px] font-black text-[var(--color-text-primary)]">
                <Search size={16} />
                探したい条件を入力
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-end">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="例: 日経225で初動があり、貸借で、PMSと6ステージが強い候補を10件探して"
                  className="min-h-[78px] flex-1 resize-none rounded-[6px] border border-[var(--color-border-default)] px-3 py-2 text-[13px] font-semibold leading-relaxed outline-none focus:border-[var(--color-brand-600)]"
                  rows={3}
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[6px] bg-[var(--color-brand-800)] px-5 text-[13px] font-black text-white transition-colors hover:bg-[var(--color-brand-900)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  送信
                </button>
              </div>
            </form>
          </div>

          <div className="min-h-[420px] p-4">
            {messages.length === 0 && !loading && (
              <div className="rounded-[6px] border border-dashed border-[var(--color-border-default)] bg-white p-6 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-brand-800)]">
                  <MessageSquareText size={22} />
                </div>
                <div className="mt-3 text-[14px] font-black text-[var(--color-text-primary)]">
                  会話しながら候補を絞り込みます
                </div>
                <p className="mx-auto mt-2 max-w-[620px] text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                  「良さそうな銘柄」のような曖昧な相談でも、AIが条件を聞き返し、StockBoardのDBにある根拠から候補を返します。
                </p>
              </div>
            )}

            {loading && (
              <div className="mb-3 flex items-center gap-2 rounded-[6px] border border-[var(--color-border-default)] bg-white p-3 text-[12px] font-bold text-[var(--color-text-secondary)]">
                <Loader2 size={15} className="animate-spin" />
                AIが条件を整理し、必要なDB検索を実行しています。
              </div>
            )}

            {error && (
              <div className="mb-3 rounded-[6px] border border-[var(--color-price-down)] bg-white p-3 text-[12px] font-bold text-[var(--color-price-down)]">
                {error}
              </div>
            )}

            <div className="space-y-4">
              {messages.map((item) => (
                <AssistantMessage key={item.id} item={item} onRun={(next) => void run(next)} />
              ))}
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          {PROMPT_GROUPS.map((group) => (
            <section key={group.title} className="rounded-[8px] border border-[var(--color-border-strong)] bg-white p-4">
              <h2 className="text-[13px] font-black text-[var(--color-text-primary)]">{group.title}</h2>
              <div className="mt-3 space-y-2">
                {group.prompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void run(prompt)}
                    className="block w-full rounded-[6px] border border-[var(--color-border-default)] bg-white px-3 py-2 text-left text-[12px] font-bold leading-relaxed text-[var(--color-brand-800)] transition-colors hover:bg-[var(--color-surface-subtle)] disabled:opacity-50"
                    disabled={loading}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </section>
          ))}

          <section className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-4">
            <h2 className="text-[13px] font-black text-[var(--color-text-primary)]">参照できる主な情報</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {['6ステージ', 'PMS/PFS/PES', '短期ラベル', 'ML類似候補', '決算予定', '貸借/信用', '業種/市場区分', '出来高'].map((item) => (
                <span
                  key={item}
                  className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)]"
                >
                  {item}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
              返答はStockBoard内のデータ検索結果を前提にします。データが不足している条件は、追加条件の確認または候補なしとして扱います。
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}
