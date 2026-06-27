'use client'

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Bot,
  CalendarDays,
  Database,
  History,
  Loader2,
  MessageSquareText,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
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

const RESEARCH_STORAGE_KEY = 'stockboard.aiResearch.session.v2'
const LEGACY_RESEARCH_SESSION_STORAGE_KEY = 'stockboard.aiResearch.session.v1'
const SAVED_RESEARCH_CONVERSATIONS_KEY = 'stockboard.aiResearch.savedConversations.v1'
const MAX_STORED_MESSAGES = 24
const MAX_SAVED_CONVERSATIONS = 30
const DEFAULT_ANCHOR_TICKER = '7003'
const DEFAULT_ANCHOR_END_DATE = '2026-05-11'
const DEFAULT_ANCHOR_LOOKBACK_DAYS = 60
const DEFAULT_ANCHOR_LIMIT = 20

type ResearchMode = 'chat' | 'historicalAnchor'
type AnchorPatternDirection = 'down' | 'up'
type AnchorUniverse = 'all' | 'nikkei225' | 'margin'

interface StoredAssistantResearchSession {
  messages?: AssistantChatEntry[]
  input?: string
  researchMode?: ResearchMode
  anchorForm?: HistoricalAnchorFormState
  activeSavedConversationId?: string | null
  savedAt?: number
}

interface SavedAssistantResearchConversation {
  id: string
  title: string
  messages: AssistantChatEntry[]
  createdAt: number
  updatedAt: number
  firstUserMessage: string | null
}

interface HistoricalAnchorFormState {
  anchorTicker: string
  anchorEndDate: string
  lookbackTradingDays: string
  patternDirection: AnchorPatternDirection
  universe: AnchorUniverse
  limit: string
  rankingMode: 'shape'
}

const DEFAULT_ANCHOR_FORM: HistoricalAnchorFormState = {
  anchorTicker: DEFAULT_ANCHOR_TICKER,
  anchorEndDate: DEFAULT_ANCHOR_END_DATE,
  lookbackTradingDays: String(DEFAULT_ANCHOR_LOOKBACK_DAYS),
  patternDirection: 'down',
  universe: 'all',
  limit: String(DEFAULT_ANCHOR_LIMIT),
  rankingMode: 'shape',
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

function readStoredSession(): StoredAssistantResearchSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(RESEARCH_STORAGE_KEY)
      ?? window.sessionStorage.getItem(LEGACY_RESEARCH_SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredAssistantResearchSession
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function sanitizeMessages(messages: AssistantChatEntry[]): AssistantChatEntry[] {
  return messages.slice(-MAX_STORED_MESSAGES)
}

function sanitizeResearchMode(value: unknown): ResearchMode {
  return value === 'historicalAnchor' ? 'historicalAnchor' : 'chat'
}

function sanitizeAnchorForm(value: unknown): HistoricalAnchorFormState {
  if (!value || typeof value !== 'object') return DEFAULT_ANCHOR_FORM
  const raw = value as Partial<HistoricalAnchorFormState>
  const anchorTicker = typeof raw.anchorTicker === 'string' && raw.anchorTicker.trim()
    ? raw.anchorTicker.trim().toUpperCase().replace(/\.T$/i, '').slice(0, 8)
    : DEFAULT_ANCHOR_FORM.anchorTicker
  const anchorEndDate = typeof raw.anchorEndDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.anchorEndDate)
    ? raw.anchorEndDate
    : DEFAULT_ANCHOR_FORM.anchorEndDate
  const lookback = Number(raw.lookbackTradingDays)
  const limit = Number(raw.limit)
  return {
    anchorTicker,
    anchorEndDate,
    lookbackTradingDays: Number.isFinite(lookback)
      ? String(Math.min(180, Math.max(10, Math.round(lookback))))
      : DEFAULT_ANCHOR_FORM.lookbackTradingDays,
    patternDirection: raw.patternDirection === 'up' ? 'up' : 'down',
    universe: raw.universe === 'nikkei225' || raw.universe === 'margin' ? raw.universe : 'all',
    limit: Number.isFinite(limit)
      ? String(Math.min(30, Math.max(1, Math.round(limit))))
      : DEFAULT_ANCHOR_FORM.limit,
    rankingMode: 'shape',
  }
}

function writeStoredSession(session: StoredAssistantResearchSession): void {
  if (typeof window === 'undefined') return
  try {
    const payload = JSON.stringify({
      ...session,
      messages: session.messages ? sanitizeMessages(session.messages) : undefined,
      savedAt: Date.now(),
    })
    window.localStorage.setItem(RESEARCH_STORAGE_KEY, payload)
    window.sessionStorage.setItem(LEGACY_RESEARCH_SESSION_STORAGE_KEY, payload)
  } catch {
    // 保存失敗は会話機能そのものを止めない。
  }
}

function buildHistoricalAnchorPrompt(form: HistoricalAnchorFormState): string {
  const ticker = form.anchorTicker.trim().toUpperCase().replace(/\.T$/i, '') || DEFAULT_ANCHOR_TICKER
  const endDate = form.anchorEndDate || DEFAULT_ANCHOR_END_DATE
  const lookback = Math.min(180, Math.max(10, Math.round(Number(form.lookbackTradingDays) || DEFAULT_ANCHOR_LOOKBACK_DAYS)))
  const limit = Math.min(30, Math.max(1, Math.round(Number(form.limit) || DEFAULT_ANCHOR_LIMIT)))
  const directionText = form.patternDirection === 'up'
    ? '上昇前のチャート形状'
    : '下落前のチャート形状'
  const purposeText = form.patternDirection === 'up'
    ? '今後上昇に転じる可能性がある銘柄を早期に見つけること'
    : '今後下落に転じる可能性がある銘柄を早期に見つけること'
  const universeText = form.universe === 'nikkei225'
    ? '対象は日本株の日経225採用銘柄に限定してください。'
    : form.universe === 'margin'
      ? '対象は日本株の貸借銘柄を優先してください。'
      : '対象は日本株市場全体です。'
  return [
    `${ticker}が${endDate}以前の約${lookback}営業日間に形成していた「${directionText}」と、現在のチャート形状が類似している銘柄を${limit}件抽出してください。`,
    `目的は、${ticker}と同様に、${purposeText}です。`,
    universeText,
    'ランキングは形状類似を最優先にしてください。',
    'アンカーは基準日1点ではなく、指定期間全体の形状として扱ってください。',
    'PMS/PFS、物理ML順位、6ステージ、移動平均線の収縮・拡散、過去検証は補助根拠として表示してください。',
    '未来の値動きは検索条件には混ぜず、過去検証・ML評価としてのみ補足してください。',
  ].join(' ')
}

function readSavedConversations(): SavedAssistantResearchConversation[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(SAVED_RESEARCH_CONVERSATIONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedAssistantResearchConversation[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item.id === 'string' && Array.isArray(item.messages))
      .map((item) => ({
        ...item,
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '保存した会話',
        messages: sanitizeMessages(item.messages),
        createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
        firstUserMessage: typeof item.firstUserMessage === 'string' ? item.firstUserMessage : null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SAVED_CONVERSATIONS)
  } catch {
    return []
  }
}

function writeSavedConversations(conversations: SavedAssistantResearchConversation[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      SAVED_RESEARCH_CONVERSATIONS_KEY,
      JSON.stringify(conversations.slice(0, MAX_SAVED_CONVERSATIONS).map((item) => ({
        ...item,
        messages: sanitizeMessages(item.messages),
      }))),
    )
  } catch {
    // 保存失敗は会話機能そのものを止めない。
  }
}

function clearStoredSession(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(RESEARCH_STORAGE_KEY)
    window.sessionStorage.removeItem(LEGACY_RESEARCH_SESSION_STORAGE_KEY)
  } catch {
    // no-op
  }
}

function titleFromMessages(messages: AssistantChatEntry[]): string {
  const firstUser = messages.find((item) => item.role === 'user')?.content.trim()
  if (!firstUser) return '保存したAIリサーチ'
  return firstUser.length > 34 ? `${firstUser.slice(0, 34)}...` : firstUser
}

function firstUserMessage(messages: AssistantChatEntry[]): string | null {
  return messages.find((item) => item.role === 'user')?.content.trim() || null
}

function formatSavedAt(value: number): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return ''
  }
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
  const [storageReady, setStorageReady] = useState(false)
  const [activeSavedConversationId, setActiveSavedConversationId] = useState<string | null>(null)
  const [savedConversations, setSavedConversations] = useState<SavedAssistantResearchConversation[]>([])
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [researchMode, setResearchMode] = useState<ResearchMode>('chat')
  const [anchorForm, setAnchorForm] = useState<HistoricalAnchorFormState>(DEFAULT_ANCHOR_FORM)
  const initialPromptKeyRef = useRef<string | null>(null)

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

  useEffect(() => {
    const stored = readStoredSession()
    if (stored?.messages?.length) setMessages(sanitizeMessages(stored.messages))
    if (typeof stored?.input === 'string') setInput(stored.input)
    if (stored?.researchMode) setResearchMode(sanitizeResearchMode(stored.researchMode))
    if (stored?.anchorForm) setAnchorForm(sanitizeAnchorForm(stored.anchorForm))
    if (typeof stored?.activeSavedConversationId === 'string') {
      setActiveSavedConversationId(stored.activeSavedConversationId)
    }
    setSavedConversations(readSavedConversations())
    setStorageReady(true)
  }, [])

  useEffect(() => {
    if (!storageReady) return
    writeStoredSession({ messages, input, researchMode, anchorForm, activeSavedConversationId })
  }, [activeSavedConversationId, anchorForm, input, messages, researchMode, storageReady])

  useEffect(() => {
    if (!storageReady) return
    if (searchParams.get('mode') !== 'historical-anchor') return
    setResearchMode('historicalAnchor')
    setAnchorForm((prev) => sanitizeAnchorForm({
      ...prev,
      anchorTicker: searchParams.get('anchorTicker') ?? prev.anchorTicker,
      anchorEndDate: searchParams.get('anchorEndDate') ?? prev.anchorEndDate,
      lookbackTradingDays: searchParams.get('lookbackTradingDays') ?? prev.lookbackTradingDays,
    }))
  }, [searchParams, storageReady])

  useEffect(() => {
    if (!saveNotice) return
    const timer = window.setTimeout(() => setSaveNotice(null), 2600)
    return () => window.clearTimeout(timer)
  }, [saveNotice])

  const clearConversation = () => {
    clearStoredSession()
    setMessages([])
    setInput('')
    setError(null)
    setActiveSavedConversationId(null)
    setSaveNotice(null)
  }

  const updateAnchorForm = (patch: Partial<HistoricalAnchorFormState>) => {
    setAnchorForm((prev) => ({ ...prev, ...patch }))
  }

  const saveCurrentConversation = () => {
    if (messages.length === 0) return
    const now = Date.now()
    const existing = activeSavedConversationId
      ? savedConversations.find((item) => item.id === activeSavedConversationId)
      : null
    const id = existing?.id ?? `saved-${now}-${Math.random().toString(16).slice(2)}`
    const item: SavedAssistantResearchConversation = {
      id,
      title: existing?.title ?? titleFromMessages(messages),
      messages: sanitizeMessages(messages),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      firstUserMessage: firstUserMessage(messages),
    }
    const next = [item, ...savedConversations.filter((conversation) => conversation.id !== id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SAVED_CONVERSATIONS)
    writeSavedConversations(next)
    setSavedConversations(next)
    setActiveSavedConversationId(id)
    setSaveNotice(existing ? '保存済みの会話を更新しました' : 'この会話を保存しました')
  }

  const loadSavedConversation = (id: string) => {
    const item = savedConversations.find((conversation) => conversation.id === id)
    if (!item) return
    const restoredMessages = sanitizeMessages(item.messages)
    setMessages(restoredMessages)
    setInput('')
    setError(null)
    setActiveSavedConversationId(item.id)
    setSaveNotice('保存した会話を開きました')
    writeStoredSession({ messages: restoredMessages, input: '', activeSavedConversationId: item.id })
  }

  const deleteSavedConversation = (id: string) => {
    const next = savedConversations.filter((conversation) => conversation.id !== id)
    writeSavedConversations(next)
    setSavedConversations(next)
    if (activeSavedConversationId === id) setActiveSavedConversationId(null)
    setSaveNotice('保存した会話を削除しました')
  }

  const run = async (message: string, options: { reset?: boolean } = {}) => {
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
    const historySource = options.reset ? [] : messages
    const history: AssistantConversationMessage[] = historySource
      .map((item) => ({ role: item.role, content: item.content }))
      .slice(-10)
    if (options.reset) {
      clearStoredSession()
      setActiveSavedConversationId(null)
      setMessages([userEntry])
    } else {
      setMessages((prev) => [...prev, userEntry])
    }

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

  useEffect(() => {
    if (!storageReady) return
    const prompt = searchParams.get('prompt')?.trim()
    if (!prompt) return
    const autoRun = searchParams.get('autoRun') === '1'
    const reset = searchParams.get('reset') === '1'
    const key = `${autoRun ? 'run' : 'fill'}:${reset ? 'reset' : 'keep'}:${prompt}`
    if (initialPromptKeyRef.current === key) return
    initialPromptKeyRef.current = key
    setResearchMode('chat')
    if (autoRun) {
      void run(prompt, { reset })
      return
    }
    if (reset) {
      clearStoredSession()
      setMessages([])
      setActiveSavedConversationId(null)
    }
    setInput(prompt)
  }, [searchParams, storageReady])

  const runHistoricalAnchorSearch = () => {
    const prompt = buildHistoricalAnchorPrompt(sanitizeAnchorForm(anchorForm))
    void run(prompt)
  }

  const useAnchorPreset7003 = () => {
    setResearchMode('historicalAnchor')
    setAnchorForm(DEFAULT_ANCHOR_FORM)
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[13px] font-black text-[var(--color-text-primary)]">
                  <Search size={16} />
                  探したい条件を入力
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">
                    会話はこのブラウザに自動保存
                  </span>
                  {messages.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={saveCurrentConversation}
                        title="今の会話を保存して、あとから開けるようにします"
                        className="rounded-[4px] border border-[var(--color-brand-600)] bg-white px-2 py-1 text-[10px] font-black text-[var(--color-brand-800)] transition-colors hover:bg-[var(--color-surface-subtle)]"
                      >
                        {activeSavedConversationId ? '保存を更新' : 'この会話を保存'}
                      </button>
                      <button
                        type="button"
                        onClick={clearConversation}
                        title="この画面の会話履歴だけを消して、新しい相談を始めます"
                        className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-subtle)]"
                      >
                        新しい会話
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setResearchMode('chat')}
                  className={`rounded-[6px] border px-3 py-2 text-left transition-colors ${
                    researchMode === 'chat'
                      ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)]'
                      : 'border-[var(--color-border-default)] bg-white hover:bg-[var(--color-surface-subtle)]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[12px] font-black text-[var(--color-text-primary)]">
                    <MessageSquareText size={15} />
                    通常会話
                  </div>
                  <p className="mt-1 text-[10px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                    自由文で相談し、必要ならAIが条件を聞き返します。
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setResearchMode('historicalAnchor')}
                  className={`rounded-[6px] border px-3 py-2 text-left transition-colors ${
                    researchMode === 'historicalAnchor'
                      ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)]'
                      : 'border-[var(--color-border-default)] bg-white hover:bg-[var(--color-surface-subtle)]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[12px] font-black text-[var(--color-text-primary)]">
                    <History size={15} />
                    過去アンカー類似
                  </div>
                  <p className="mt-1 text-[10px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                    特定銘柄の過去局面に、今まさに近い銘柄を探します。
                  </p>
                </button>
              </div>
              {saveNotice && (
                <div className="rounded-[4px] border border-[var(--color-brand-200)] bg-[var(--color-brand-50)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--color-brand-800)]">
                  {saveNotice}
                </div>
              )}
              {researchMode === 'chat' ? (
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
              ) : (
                <div className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 text-[13px] font-black text-[var(--color-text-primary)]">
                        <Target size={16} />
                        過去アンカー類似検索
                      </div>
                      <p className="mt-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                        アンカー期間全体の物理特徴量を平均し、現在の銘柄形状と比較します。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={useAnchorPreset7003}
                      className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 py-1.5 text-[10px] font-black text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]"
                    >
                      7003下落前プリセット
                    </button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-6">
                    <label className="md:col-span-1">
                      <span className="mb-1 block text-[10px] font-black text-[var(--color-text-tertiary)]">銘柄</span>
                      <input
                        value={anchorForm.anchorTicker}
                        onChange={(event) => updateAnchorForm({ anchorTicker: event.target.value })}
                        className="h-10 w-full rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 font-mono text-[13px] font-black outline-none focus:border-[var(--color-brand-600)]"
                        inputMode="text"
                      />
                    </label>
                    <label className="md:col-span-2">
                      <span className="mb-1 flex items-center gap-1 text-[10px] font-black text-[var(--color-text-tertiary)]">
                        <CalendarDays size={12} />
                        アンカー終了日
                      </span>
                      <input
                        type="date"
                        value={anchorForm.anchorEndDate}
                        onChange={(event) => updateAnchorForm({ anchorEndDate: event.target.value })}
                        className="h-10 w-full rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold outline-none focus:border-[var(--color-brand-600)]"
                      />
                    </label>
                    <label className="md:col-span-1">
                      <span className="mb-1 block text-[10px] font-black text-[var(--color-text-tertiary)]">営業日</span>
                      <input
                        type="number"
                        min={10}
                        max={180}
                        value={anchorForm.lookbackTradingDays}
                        onChange={(event) => updateAnchorForm({ lookbackTradingDays: event.target.value })}
                        className="h-10 w-full rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold outline-none focus:border-[var(--color-brand-600)]"
                      />
                    </label>
                    <label className="md:col-span-1">
                      <span className="mb-1 block text-[10px] font-black text-[var(--color-text-tertiary)]">局面</span>
                      <select
                        value={anchorForm.patternDirection}
                        onChange={(event) => updateAnchorForm({ patternDirection: event.target.value === 'up' ? 'up' : 'down' })}
                        className="h-10 w-full rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold outline-none focus:border-[var(--color-brand-600)]"
                      >
                        <option value="down">下落前</option>
                        <option value="up">上昇前</option>
                      </select>
                    </label>
                    <label className="md:col-span-1">
                      <span className="mb-1 block text-[10px] font-black text-[var(--color-text-tertiary)]">件数</span>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={anchorForm.limit}
                        onChange={(event) => updateAnchorForm({ limit: event.target.value })}
                        className="h-10 w-full rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold outline-none focus:border-[var(--color-brand-600)]"
                      />
                    </label>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <label>
                      <span className="mb-1 block text-[10px] font-black text-[var(--color-text-tertiary)]">対象</span>
                      <select
                        value={anchorForm.universe}
                        onChange={(event) => updateAnchorForm({
                          universe: event.target.value === 'nikkei225' || event.target.value === 'margin'
                            ? event.target.value
                            : 'all',
                        })}
                        className="h-10 w-full rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold outline-none focus:border-[var(--color-brand-600)]"
                      >
                        <option value="all">日本株全体</option>
                        <option value="nikkei225">日経225</option>
                        <option value="margin">貸借銘柄を優先</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={runHistoricalAnchorSearch}
                      disabled={loading || !anchorForm.anchorTicker.trim() || !anchorForm.anchorEndDate}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-[var(--color-brand-800)] px-4 text-[13px] font-black text-white transition-colors hover:bg-[var(--color-brand-900)] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                      この条件で検索
                    </button>
                  </div>
                  <div className="mt-3 rounded-[5px] border border-[var(--color-border-default)] bg-white px-3 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                    <span className="font-black text-[var(--color-text-primary)]">解釈:</span>{' '}
                    {anchorForm.anchorTicker || DEFAULT_ANCHOR_TICKER} の {anchorForm.anchorEndDate || DEFAULT_ANCHOR_END_DATE} 以前
                    約{anchorForm.lookbackTradingDays || DEFAULT_ANCHOR_LOOKBACK_DAYS}営業日の
                    {anchorForm.patternDirection === 'up' ? '上昇前形状' : '下落前形状'}に、今まさに近い銘柄を形状類似優先で探します。
                  </div>
                </div>
              )}
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
          <section className="rounded-[8px] border border-[var(--color-brand-200)] bg-white p-4">
            <div className="flex items-start gap-2">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] border border-[var(--color-brand-200)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]">
                <History size={16} />
              </span>
              <div>
                <h2 className="text-[13px] font-black text-[var(--color-text-primary)]">過去アンカー類似モード</h2>
                <p className="mt-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                  「あの銘柄があの時期に崩れる直前の形」に、今まさに近い銘柄を探す専用検索です。
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={useAnchorPreset7003}
                className="rounded-[5px] border border-[var(--color-brand-600)] bg-[var(--color-brand-800)] px-3 py-2 text-left text-[11px] font-black leading-relaxed text-white transition-colors hover:bg-[var(--color-brand-900)]"
              >
                7003下落前を型にする
              </button>
              <button
                type="button"
                onClick={() => {
                  setResearchMode('historicalAnchor')
                  setAnchorForm((prev) => ({ ...prev, patternDirection: 'up' }))
                }}
                className="rounded-[5px] border border-[var(--color-border-default)] bg-white px-3 py-2 text-left text-[11px] font-black leading-relaxed text-[var(--color-brand-800)] transition-colors hover:bg-[var(--color-surface-subtle)]"
              >
                上昇前形状で探す
              </button>
            </div>
            <p className="mt-3 text-[10px] font-bold leading-relaxed text-[var(--color-text-tertiary)]">
              ランキングは形状類似を主軸にし、PMS/PFS・物理ML・過去検証は補助根拠として表示します。
            </p>
          </section>

          <section className="rounded-[8px] border border-[var(--color-border-strong)] bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[13px] font-black text-[var(--color-text-primary)]">保存した会話</h2>
              <span className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] font-black text-[var(--color-text-tertiary)]">
                {savedConversations.length}件
              </span>
            </div>
            {savedConversations.length === 0 ? (
              <p className="mt-3 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                気に入った結果が出たら「この会話を保存」を押すと、ここから後で開けます。
              </p>
            ) : (
              <div className="mt-3 max-h-[320px] space-y-2 overflow-auto pr-1">
                {savedConversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={`rounded-[6px] border bg-white p-2 ${
                      conversation.id === activeSavedConversationId
                        ? 'border-[var(--color-brand-600)]'
                        : 'border-[var(--color-border-default)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => loadSavedConversation(conversation.id)}
                      className="block w-full text-left"
                    >
                      <div className="line-clamp-2 text-[12px] font-black leading-relaxed text-[var(--color-brand-800)]">
                        {conversation.title}
                      </div>
                      <div className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
                        更新 {formatSavedAt(conversation.updatedAt)} / {conversation.messages.length}件
                      </div>
                    </button>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="line-clamp-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                        {conversation.firstUserMessage ?? '会話メモ'}
                      </span>
                      <button
                        type="button"
                        onClick={() => deleteSavedConversation(conversation.id)}
                        className="shrink-0 rounded-[4px] border border-[var(--color-border-default)] px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-subtle)]"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

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
