'use client'

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
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
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
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

const LEGACY_RESEARCH_STORAGE_KEY = 'stockboard.aiResearch.session.v2'
const LEGACY_RESEARCH_SESSION_STORAGE_KEY = 'stockboard.aiResearch.session.v1'
const LEGACY_SAVED_RESEARCH_CONVERSATIONS_KEY = 'stockboard.aiResearch.savedConversations.v1'
const MAX_STORED_MESSAGES = 24
const MAX_SAVED_CONVERSATIONS = 30
const DEFAULT_ANCHOR_TICKER = '7003'
const DEFAULT_ANCHOR_END_DATE = '2026-05-11'
const DEFAULT_ANCHOR_LOOKBACK_DAYS = 60
const DEFAULT_ANCHOR_LIMIT = 20

type ResearchMode = 'chat' | 'historicalAnchor'
type ResearchMarket = Exclude<AssistantPageContext['market'], null | undefined>
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

const US_PROMPT_GROUPS = [
  {
    title: 'ML候補',
    prompts: [
      '米国株の物理ML上昇候補を10件見せて',
      '米国株でPMSと6ステージが強い初動候補を探して',
      '米国株で出来高が多く短期チェックが強い候補を見せて',
    ],
  },
  {
    title: 'リスク確認',
    prompts: [
      '米国株の物理ML下落警戒候補を10件見せて',
      '米国株でPMSが弱くなっている銘柄を探して',
      '米国株でMA200を下回り短期モメンタムも弱い候補を見せて',
    ],
  },
  {
    title: '個別深掘り',
    prompts: [
      'AAPLの現在の特徴量に似た米国株を5件探して',
      'MSFTの6ステージ、PMS、物理MLの状態を整理して',
      'NVDAと特徴量が近い米国株を出来高が多い順で見せて',
    ],
  },
] as const

const JP_REFERENCE_ITEMS = [
  '6ステージ',
  'PMS/PFS/PES',
  '短期ラベル',
  'ML類似候補',
  '決算予定',
  '貸借/信用',
  '業種/市場区分',
  '出来高',
] as const

const US_REFERENCE_ITEMS = [
  '6ステージ',
  'PMS/PFS/PES',
  '短期ラベル',
  '物理ML',
  'ML類似候補',
  'SEC業種',
  '取引所',
  '出来高',
] as const

function marketFromContext(pathname: string, marketParam: string | null): ResearchMarket {
  if (marketParam === 'US' || marketParam === 'JP' || marketParam === 'COMMODITY') {
    return marketParam
  }
  if (pathname.startsWith('/us')) return 'US'
  if (pathname.startsWith('/commodities')) return 'COMMODITY'
  return 'JP'
}

function researchStorageKey(market: ResearchMarket): string {
  return `stockboard.aiResearch.session.v3.${market}`
}

function savedResearchConversationsKey(market: ResearchMarket): string {
  return `stockboard.aiResearch.savedConversations.v2.${market}`
}

function legacySessionStorageKey(market: ResearchMarket): string {
  return `${LEGACY_RESEARCH_SESSION_STORAGE_KEY}.${market}`
}

function readStoredSession(market: ResearchMarket): StoredAssistantResearchSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(researchStorageKey(market))
      ?? window.sessionStorage.getItem(legacySessionStorageKey(market))
      ?? (market === 'JP'
        ? window.localStorage.getItem(LEGACY_RESEARCH_STORAGE_KEY)
          ?? window.sessionStorage.getItem(LEGACY_RESEARCH_SESSION_STORAGE_KEY)
        : null)
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

function writeStoredSession(market: ResearchMarket, session: StoredAssistantResearchSession): void {
  if (typeof window === 'undefined') return
  try {
    const payload = JSON.stringify({
      ...session,
      messages: session.messages ? sanitizeMessages(session.messages) : undefined,
      savedAt: Date.now(),
    })
    window.localStorage.setItem(researchStorageKey(market), payload)
    window.sessionStorage.setItem(legacySessionStorageKey(market), payload)
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

function readSavedConversations(market: ResearchMarket): SavedAssistantResearchConversation[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(savedResearchConversationsKey(market))
      ?? (market === 'JP'
        ? window.localStorage.getItem(LEGACY_SAVED_RESEARCH_CONVERSATIONS_KEY)
        : null)
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

function writeSavedConversations(
  market: ResearchMarket,
  conversations: SavedAssistantResearchConversation[],
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      savedResearchConversationsKey(market),
      JSON.stringify(conversations.slice(0, MAX_SAVED_CONVERSATIONS).map((item) => ({
        ...item,
        messages: sanitizeMessages(item.messages),
      }))),
    )
  } catch {
    // 保存失敗は会話機能そのものを止めない。
  }
}

function clearStoredSession(market: ResearchMarket): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(researchStorageKey(market))
    window.sessionStorage.removeItem(legacySessionStorageKey(market))
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
      <div className="ml-auto max-w-[820px] rounded-[6px] border border-[var(--color-brand-200)] bg-white px-4 py-3 text-[13px] font-bold leading-relaxed text-[var(--color-text-primary)] ">
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
  const [storageMarket, setStorageMarket] = useState<ResearchMarket | null>(null)
  const [activeSavedConversationId, setActiveSavedConversationId] = useState<string | null>(null)
  const [savedConversations, setSavedConversations] = useState<SavedAssistantResearchConversation[]>([])
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [researchMode, setResearchMode] = useState<ResearchMode>('chat')
  const [anchorForm, setAnchorForm] = useState<HistoricalAnchorFormState>(DEFAULT_ANCHOR_FORM)
  const initialPromptKeyRef = useRef<string | null>(null)

  const researchMarket = useMemo(
    () => marketFromContext(pathname, searchParams.get('market')),
    [pathname, searchParams],
  )
  const isUsResearch = researchMarket === 'US'
  const promptGroups = isUsResearch ? US_PROMPT_GROUPS : PROMPT_GROUPS
  const referenceItems = isUsResearch ? US_REFERENCE_ITEMS : JP_REFERENCE_ITEMS

  const context = useMemo<AssistantPageContext>(() => ({
    pathname,
    search: searchParams.toString(),
    ticker: searchParams.get('ticker'),
    market: researchMarket,
    universe: searchParams.get('universe'),
  }), [pathname, researchMarket, searchParams])

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
    setStorageReady(false)
    setMessages([])
    setInput('')
    setError(null)
    setActiveSavedConversationId(null)
    setSaveNotice(null)
    initialPromptKeyRef.current = null

    const stored = readStoredSession(researchMarket)
    setMessages(stored?.messages?.length ? sanitizeMessages(stored.messages) : [])
    setInput(typeof stored?.input === 'string' ? stored.input : '')
    setResearchMode(
      researchMarket === 'JP' && stored?.researchMode
        ? sanitizeResearchMode(stored.researchMode)
        : 'chat',
    )
    setAnchorForm(stored?.anchorForm ? sanitizeAnchorForm(stored.anchorForm) : DEFAULT_ANCHOR_FORM)
    setActiveSavedConversationId(
      typeof stored?.activeSavedConversationId === 'string'
        ? stored.activeSavedConversationId
        : null,
    )
    setSavedConversations(readSavedConversations(researchMarket))
    setStorageMarket(researchMarket)
    setStorageReady(true)
  }, [researchMarket])

  useEffect(() => {
    if (!storageReady || storageMarket !== researchMarket) return
    writeStoredSession(researchMarket, {
      messages,
      input,
      researchMode: researchMarket === 'JP' ? researchMode : 'chat',
      anchorForm,
      activeSavedConversationId,
    })
  }, [
    activeSavedConversationId,
    anchorForm,
    input,
    messages,
    researchMarket,
    researchMode,
    storageMarket,
    storageReady,
  ])

  useEffect(() => {
    if (!storageReady) return
    if (researchMarket !== 'JP') return
    if (searchParams.get('mode') !== 'historical-anchor') return
    setResearchMode('historicalAnchor')
    setAnchorForm((prev) => sanitizeAnchorForm({
      ...prev,
      anchorTicker: searchParams.get('anchorTicker') ?? prev.anchorTicker,
      anchorEndDate: searchParams.get('anchorEndDate') ?? prev.anchorEndDate,
      lookbackTradingDays: searchParams.get('lookbackTradingDays') ?? prev.lookbackTradingDays,
    }))
  }, [researchMarket, searchParams, storageReady])

  useEffect(() => {
    if (!saveNotice) return
    const timer = window.setTimeout(() => setSaveNotice(null), 2600)
    return () => window.clearTimeout(timer)
  }, [saveNotice])

  const clearConversation = () => {
    clearStoredSession(researchMarket)
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
    writeSavedConversations(researchMarket, next)
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
    writeStoredSession(researchMarket, {
      messages: restoredMessages,
      input: '',
      activeSavedConversationId: item.id,
    })
  }

  const deleteSavedConversation = (id: string) => {
    const next = savedConversations.filter((conversation) => conversation.id !== id)
    writeSavedConversations(researchMarket, next)
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
      clearStoredSession(researchMarket)
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
      clearStoredSession(researchMarket)
      setMessages([])
      setActiveSavedConversationId(null)
    }
    setInput(prompt)
  }, [researchMarket, searchParams, storageReady])

  const runHistoricalAnchorSearch = () => {
    const prompt = buildHistoricalAnchorPrompt(sanitizeAnchorForm(anchorForm))
    void run(prompt)
  }

  const useAnchorPreset7003 = () => {
    setResearchMode('historicalAnchor')
    setAnchorForm(DEFAULT_ANCHOR_FORM)
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="銘柄探索"
        title="AI銘柄リサーチ"
        badge={researchMarket === 'US' ? '米国株' : researchMarket === 'COMMODITY' ? '商品' : '日本株'}
        subtitle={isUsResearch
          ? '米国株のDB検索とML分析を、自然言語の相談から使えます。条件が曖昧なときはAIが聞き返します。'
          : '自然言語の相談から、StockBoard内のDB検索と分析機能を使えます。条件が曖昧なときはAIが聞き返します。'}
        meta={
          <>
            <span><Database size={13} aria-hidden />{isUsResearch ? '6ステージ・PMS・物理ML・ML類似候補を参照' : '6ステージ・PMS・決算・ML類似候補を参照'}</span>
            <span><ShieldCheck size={13} aria-hidden />読み取り専用（注文・DB更新は行いません）</span>
            <span><Sparkles size={13} aria-hidden />{assistantStatusText(assistantStatus)}</span>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white" aria-label="リサーチ会話">
          <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3 sm:p-4">
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {researchMarket === 'JP' ? (
                  <div className="view-tabs" role="group" aria-label="検索モード">
                    <button
                      type="button"
                      onClick={() => setResearchMode('chat')}
                      className="view-tab"
                      data-active={researchMode === 'chat'}
                      aria-pressed={researchMode === 'chat'}
                      title="自由文で相談し、必要ならAIが条件を聞き返します。"
                    >
                      <MessageSquareText size={14} aria-hidden />
                      通常会話
                    </button>
                    <button
                      type="button"
                      onClick={() => setResearchMode('historicalAnchor')}
                      className="view-tab"
                      data-active={researchMode === 'historicalAnchor'}
                      aria-pressed={researchMode === 'historicalAnchor'}
                      title="特定銘柄の過去局面に、今まさに近い銘柄を探します。"
                    >
                      <History size={14} aria-hidden />
                      過去アンカー類似
                    </button>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--color-text-primary)]">
                    <ShieldCheck size={15} aria-hidden className="text-[var(--color-brand-700)]" />
                    米国株専用リサーチ
                    <span className="font-normal text-[12px] text-[var(--color-text-tertiary)]">日本株の結果は混在させません</span>
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] text-[var(--color-text-tertiary)]">
                    会話はこのブラウザに自動保存
                  </span>
                  {messages.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={saveCurrentConversation}
                        title="今の会話を保存して、あとから開けるようにします"
                        className="btn"
                        data-size="sm"
                      >
                        {activeSavedConversationId ? '保存を更新' : 'この会話を保存'}
                      </button>
                      <button
                        type="button"
                        onClick={clearConversation}
                        title="この画面の会話履歴だけを消して、新しい相談を始めます"
                        className="btn"
                        data-size="sm"
                        data-variant="ghost"
                      >
                        新しい会話
                      </button>
                    </>
                  )}
                </div>
              </div>
              {researchMarket === 'JP' && (
                <p className="m-0 text-[12px] text-[var(--color-text-secondary)]">
                  {researchMode === 'chat'
                    ? '自由文で相談し、必要ならAIが条件を聞き返します。'
                    : '特定銘柄の過去局面に、今まさに近い銘柄を探します。'}
                </p>
              )}
              {saveNotice && (
                <Notice tone="info" role="status">{saveNotice}</Notice>
              )}
              {researchMarket !== 'JP' || researchMode === 'chat' ? (
                <div className="flex flex-col gap-2 md:flex-row md:items-end">
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder={isUsResearch
                      ? '例: 米国株で物理ML上昇候補を、PMSと出来高も含めて10件探して'
                      : '例: 日経225で初動があり、貸借で、PMSと6ステージが強い候補を10件探して'}
                    aria-label="探したい条件"
                    className="min-h-[78px] flex-1 resize-none rounded-[6px] border border-[var(--color-border-default)] bg-white px-3 py-2 text-[14px] leading-relaxed outline-none focus:border-[var(--color-brand-600)]"
                    rows={3}
                  />
                  <button
                    type="submit"
                    disabled={loading || !input.trim()}
                    className="btn shrink-0"
                    data-variant="primary"
                    data-size="lg"
                  >
                    {loading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Send size={16} aria-hidden />}
                    送信
                  </button>
                </div>
              ) : (
                <fieldset className="m-0 min-w-0 border-0 border-t border-[var(--color-border-soft)] p-0 pt-3" aria-labelledby="anchor-search-title">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h2 id="anchor-search-title" className="flex items-center gap-2 text-[13px] font-bold text-[var(--color-text-primary)]">
                        <Target size={15} aria-hidden />
                        過去アンカー類似検索
                      </h2>
                      <p className="m-0 mt-1 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                        アンカー期間全体の物理特徴量を平均し、現在の銘柄形状と比較します。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={useAnchorPreset7003}
                      className="btn"
                      data-size="sm"
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
                      className="btn h-10"
                      data-variant="primary"
                    >
                      {loading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Search size={16} aria-hidden />}
                      この条件で検索
                    </button>
                  </div>
                  <p className="m-0 mt-3 border-l-2 border-[var(--color-brand-300)] pl-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                    <span className="font-bold text-[var(--color-text-primary)]">解釈:</span>{' '}
                    {anchorForm.anchorTicker || DEFAULT_ANCHOR_TICKER} の {anchorForm.anchorEndDate || DEFAULT_ANCHOR_END_DATE} 以前
                    約{anchorForm.lookbackTradingDays || DEFAULT_ANCHOR_LOOKBACK_DAYS}営業日の
                    {anchorForm.patternDirection === 'up' ? '上昇前形状' : '下落前形状'}に、今まさに近い銘柄を形状類似優先で探します。
                  </p>
                </fieldset>
              )}
            </form>
          </div>

          <div className="min-h-[420px] p-3 sm:p-4">
            {messages.length === 0 && !loading && (
              <EmptyState
                icon={<MessageSquareText size={22} aria-hidden />}
                title="会話しながら候補を絞り込みます"
                description="「良さそうな銘柄」のような曖昧な相談でも、AIが条件を聞き返し、StockBoardのDBにある根拠から候補を返します。"
              />
            )}

            {loading && (
              <div className="mb-3 flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]" role="status" aria-live="polite">
                <Loader2 size={15} className="animate-spin" aria-hidden />
                AIが条件を整理し、必要なDB検索を実行しています。
              </div>
            )}

            {error && (
              <Notice tone="error" role="alert" className="mb-3">{error}</Notice>
            )}

            <div className="space-y-4">
              {messages.map((item) => (
                <AssistantMessage key={item.id} item={item} onRun={(next) => void run(next)} />
              ))}
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          {researchMarket === 'JP' && (
            <section className="panel" aria-labelledby="anchor-mode-title">
              <div className="panel-head">
                <div className="flex min-w-0 items-center gap-2">
                  <History size={15} aria-hidden className="shrink-0 text-[var(--color-brand-700)]" />
                  <h2 id="anchor-mode-title">過去アンカー類似モード</h2>
                </div>
              </div>
              <div className="p-3">
                <p className="m-0 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                  「あの銘柄があの時期に崩れる直前の形」に、今まさに近い銘柄を探す専用検索です。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={useAnchorPreset7003} className="btn" data-size="sm" data-variant="primary">
                    7003下落前を型にする
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResearchMode('historicalAnchor')
                      setAnchorForm((prev) => ({ ...prev, patternDirection: 'up' }))
                    }}
                    className="btn"
                    data-size="sm"
                  >
                    上昇前形状で探す
                  </button>
                </div>
                <p className="m-0 mt-3 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
                  ランキングは形状類似を主軸にし、PMS/PFS・物理ML・過去検証は補助根拠として表示します。
                </p>
              </div>
            </section>
          )}

          <section className="panel" aria-labelledby="saved-conversations-title">
            <div className="panel-head">
              <h2 id="saved-conversations-title">保存した会話</h2>
              <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{savedConversations.length}件</span>
            </div>
            {savedConversations.length === 0 ? (
              <p className="m-0 p-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                気に入った結果が出たら「この会話を保存」を押すと、ここから後で開けます。
              </p>
            ) : (
              <ul className="max-h-[320px] divide-y divide-[var(--color-border-soft)] overflow-auto">
                {savedConversations.map((conversation) => {
                  const active = conversation.id === activeSavedConversationId
                  return (
                    <li
                      key={conversation.id}
                      className={`px-3 py-2 ${active ? 'bg-[var(--color-brand-50)] shadow-[inset_3px_0_0_var(--color-brand-700)]' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => loadSavedConversation(conversation.id)}
                        className="block w-full text-left"
                        aria-current={active ? 'true' : undefined}
                      >
                        <span className="line-clamp-2 text-[13px] font-semibold leading-relaxed text-[var(--color-brand-800)] hover:underline">
                          {conversation.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                          更新 {formatSavedAt(conversation.updatedAt)} / {conversation.messages.length}件
                        </span>
                      </button>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="line-clamp-1 text-[11px] text-[var(--color-text-tertiary)]">
                          {conversation.firstUserMessage ?? '会話メモ'}
                        </span>
                        <button
                          type="button"
                          onClick={() => deleteSavedConversation(conversation.id)}
                          className="btn shrink-0"
                          data-size="sm"
                          data-variant="ghost"
                        >
                          削除
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {promptGroups.map((group) => (
            <section key={group.title} className="panel" aria-label={group.title}>
              <div className="panel-head"><h2>{group.title}</h2></div>
              <ul className="divide-y divide-[var(--color-border-soft)]">
                {group.prompts.map((prompt) => (
                  <li key={prompt}>
                    <button
                      type="button"
                      onClick={() => void run(prompt)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left text-[13px] leading-relaxed text-[var(--color-brand-800)] transition-colors hover:bg-[var(--color-surface-subtle)] disabled:opacity-50"
                      disabled={loading}
                    >
                      <Send size={12} aria-hidden className="mt-1.5 shrink-0 text-[var(--color-text-tertiary)]" />
                      {prompt}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="panel" aria-labelledby="reference-items-title">
            <div className="panel-head"><h2 id="reference-items-title">参照できる主な情報</h2></div>
            <div className="p-3">
              <div className="flex flex-wrap gap-1.5">
                {referenceItems.map((item) => (
                  <span key={item} className="status-tag">{item}</span>
                ))}
              </div>
              <p className="m-0 mt-3 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
                返答はStockBoard内のデータ検索結果を前提にします。データが不足している条件は、追加条件の確認または候補なしとして扱います。
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
