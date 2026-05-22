// components/ai/PatternSearchMock.tsx
// モック準拠 検索行: 検索ボックス + 「または 上位パターンから選択」

'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useState } from 'react'

interface Props {
  currentCode: string
  topPatterns: { pattern_code: string; count: number }[]
}

export function PatternSearchMock({ currentCode, topPatterns }: Props) {
  const router = useRouter()
  const [value, setValue] = useState(currentCode)
  const [open, setOpen] = useState(false)

  function go(code: string) {
    if (/^\d{6}$/.test(code)) {
      router.push(`/ai/transitions?code=${code}`)
      setOpen(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <form
        onSubmit={(e) => { e.preventDefault(); go(value) }}
        className="sb-search"
        style={{ minWidth: 240 }}
      >
        <span style={{ fontSize: 12 }}>🔍</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="パターンコード検索 (例: 111116)"
          maxLength={6}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.05em',
            color: 'var(--color-text-primary)',
            minWidth: 140,
          }}
        />
      </form>
      <span className="sb-t" style={{ fontSize: 11 }}>または</span>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            fontSize: 11,
            color: 'var(--color-brand-700)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          上位パターンから選択 ▼
        </button>
        {open && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              zIndex: 20,
              width: 280,
              padding: 8,
              background: 'var(--color-surface-base)',
              border: '0.5px solid var(--color-border-default)',
              borderRadius: 6,
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {topPatterns.map(t => (
                <Link
                  key={t.pattern_code}
                  href={`/ai/transitions?code=${t.pattern_code}`}
                  onClick={() => setOpen(false)}
                  style={{
                    padding: '4px 8px',
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: '0.05em',
                    color: 'var(--color-text-primary)',
                    textDecoration: 'none',
                    borderRadius: 4,
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.background = 'var(--color-surface-subtle)')}
                  onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ fontWeight: 500 }}>{t.pattern_code}</span>
                  <span className="sb-t" style={{ marginLeft: 6, fontSize: 10 }}>
                    n={t.count.toLocaleString()}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
