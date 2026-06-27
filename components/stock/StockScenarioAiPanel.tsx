'use client'

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'

type ChatRole = 'user' | 'assistant'

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  source?: 'openai' | 'fallback'
  model?: string | null
}

interface StockScenarioAiPanelProps {
  ticker: string
  name: string
  analysisDate?: string | null
}

type StockChatApiResponse = {
  ok: boolean
  message: string
  source: 'openai' | 'fallback'
  model: string | null
  openai?: {
    configured: boolean
    used: boolean
    reason?: string
  }
  followups?: string[]
}

const QUICK_PROMPTS = [
  'この銘柄のシナリオを結論ファーストで説明して',
  '下落シナリオが強くなる条件を教えて',
  '上昇シナリオが崩れる条件を教えて',
  '短期・中期・長期で見方が違う点を教えて',
]

function messageId(role: ChatRole): string {
  return `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function storageKey(ticker: string, analysisDate: string | null | undefined): string {
  return `stockboard:stock-ai-chat:${ticker}:${analysisDate || 'latest'}`
}

function sourceLabel(message: ChatMessage): string {
  if (message.source === 'openai') return message.model ? `AI / ${message.model}` : 'AI'
  if (message.source === 'fallback') return 'ローカル要約'
  return message.role === 'user' ? 'あなた' : 'AI'
}

export function StockScenarioAiPanel({ ticker, name, analysisDate }: StockScenarioAiPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [followups, setFollowups] = useState<string[]>(QUICK_PROMPTS.slice(1))

  const key = useMemo(() => storageKey(ticker, analysisDate), [ticker, analysisDate])
  const contextLabel = analysisDate ? `${analysisDate}時点` : '最新時点'

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) {
        setMessages([])
        return
      }
      const parsed = JSON.parse(raw) as ChatMessage[]
      setMessages(Array.isArray(parsed) ? parsed.slice(-20) : [])
    } catch {
      setMessages([])
    }
  }, [key])

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(messages.slice(-20)))
    } catch {
      // localStorage quota or private mode; chat can still work in memory.
    }
  }, [key, messages])

  async function sendMessage(text: string) {
    const content = text.trim()
    if (!content || loading) return
    const userMessage: ChatMessage = { id: messageId('user'), role: 'user', content }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/assistant/stock-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker,
          name,
          analysisDate,
          message: content,
          history: messages.slice(-8).map((message) => ({ role: message.role, content: message.content })),
        }),
      })
      const payload = await res.json() as StockChatApiResponse | { message?: string; error?: string }
      if (!res.ok || !('ok' in payload)) {
        const errorPayload = payload as { message?: string; error?: string }
        throw new Error(errorPayload.message ?? errorPayload.error ?? `HTTP ${res.status}`)
      }
      setMessages((prev) => [
        ...prev,
        {
          id: messageId('assistant'),
          role: 'assistant',
          content: payload.message,
          source: payload.source,
          model: payload.model,
        },
      ])
      if (payload.followups?.length) setFollowups(payload.followups)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function resetConversation() {
    setMessages([])
    setError('')
    try {
      window.localStorage.removeItem(key)
    } catch {
      // ignore
    }
  }

  return (
    <section className="card" style={sectionStyle}>
      <div style={headerStyle}>
        <div>
          <div className="section-header" style={titleStyle}>この銘柄についてAIに聞く</div>
          <p style={subTextStyle}>
            {ticker} {name} のシナリオ、物理状態、PMS/PFS/PES、MA状態、物理ML候補を根拠に回答します。
            <strong> {contextLabel}</strong> のシナリオ文脈で会話します。
          </p>
        </div>
        <div style={headerActionStyle}>
          <span style={badgeStyle}>実データ根拠</span>
          <button type="button" onClick={resetConversation} style={resetButtonStyle}>会話をリセット</button>
        </div>
      </div>

      <div style={promptRowStyle}>
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => sendMessage(prompt)}
            disabled={loading}
            style={quickButtonStyle}
          >
            {prompt}
          </button>
        ))}
      </div>

      <div style={messagesStyle}>
        {messages.length === 0 ? (
          <div style={emptyStyle}>
            シナリオについて質問できます。例:「下落シナリオが優勢な理由は？」「どの条件で見送りになる？」
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              style={{
                ...messageStyle,
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                background: message.role === 'user' ? 'var(--accent-dim)' : '#fff',
                borderColor: message.role === 'user' ? 'rgba(37, 99, 235, 0.28)' : 'var(--border-subtle)',
              }}
            >
              <div style={messageMetaStyle}>{sourceLabel(message)}</div>
              <div style={messageContentStyle}>{message.content}</div>
            </article>
          ))
        )}
      </div>

      {error && <div style={errorStyle}>AI会話エラー: {error}</div>}

      <form
        style={formStyle}
        onSubmit={(event) => {
          event.preventDefault()
          sendMessage(input)
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={`${contextLabel}のシナリオについて質問`}
          rows={3}
          style={textareaStyle}
        />
        <button type="submit" disabled={loading || !input.trim()} style={sendButtonStyle}>
          {loading ? '回答中...' : '質問する'}
        </button>
      </form>

      {followups.length > 0 && (
        <div style={followupStyle}>
          <span>続けて聞く:</span>
          {followups.slice(0, 3).map((prompt) => (
            <button key={prompt} type="button" onClick={() => sendMessage(prompt)} disabled={loading} style={followupButtonStyle}>
              {prompt}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

const sectionStyle: CSSProperties = {
  padding: 16,
  display: 'grid',
  gap: 12,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'flex-start',
  flexWrap: 'wrap',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
}

const subTextStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.65,
}

const headerActionStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
}

const badgeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 999,
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 900,
  padding: '5px 9px',
}

const resetButtonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 800,
  padding: '6px 10px',
  cursor: 'pointer',
}

const promptRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const quickButtonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 999,
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 800,
  padding: '7px 10px',
  cursor: 'pointer',
}

const messagesStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: 'var(--bg-subtle)',
  padding: 10,
  minHeight: 170,
  maxHeight: 430,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const emptyStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 13,
  lineHeight: 1.7,
  padding: 12,
}

const messageStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: 10,
  maxWidth: 'min(820px, 96%)',
  display: 'grid',
  gap: 6,
}

const messageMetaStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 900,
}

const messageContentStyle: CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: 13,
  lineHeight: 1.75,
  whiteSpace: 'pre-wrap',
}

const errorStyle: CSSProperties = {
  border: '1px solid rgba(37, 99, 235, 0.22)',
  borderRadius: 8,
  background: 'rgba(37, 99, 235, 0.06)',
  color: 'var(--price-down)',
  fontSize: 12,
  fontWeight: 800,
  padding: 10,
}

const formStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 8,
  alignItems: 'stretch',
}

const textareaStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: 10,
  resize: 'vertical',
  minHeight: 74,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text-primary)',
}

const sendButtonStyle: CSSProperties = {
  border: '1px solid var(--accent-primary)',
  borderRadius: 8,
  background: 'var(--accent-primary)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 900,
  padding: '0 16px',
  cursor: 'pointer',
}

const followupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  color: 'var(--text-muted)',
  fontSize: 12,
  fontWeight: 800,
}

const followupButtonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 999,
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 800,
  padding: '6px 9px',
  cursor: 'pointer',
}
