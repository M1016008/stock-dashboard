// components/ai/PatternSearch.tsx
// Phase 4 D2: 検索ボックス + 「上位パターンから選択」リンク (上位 12 件)

'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useState } from 'react'

interface Props {
  currentCode: string
  topPatterns: { pattern_code: string; count: number }[]
}

export function PatternSearch({ currentCode, topPatterns }: Props) {
  const router = useRouter()
  const [value, setValue] = useState(currentCode)
  const [open, setOpen] = useState(false)

  function go(code: string) {
    if (/^\d{6}$/.test(code)) {
      router.push(`/ai/transitions?code=${code}`)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); go(value) }}
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="パターンコード検索 (例: 111116)"
          className="w-[220px] rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] px-3 py-1.5 font-mono text-[13px] tabular-nums tracking-[0.05em] outline-none focus:border-[var(--color-brand-500)]"
          maxLength={6}
        />
        <button
          type="submit"
          className="rounded-[6px] bg-[var(--color-brand-600)] px-3 py-1.5 text-[12px] text-white"
        >
          表示
        </button>
      </form>
      <div className="relative">
        <button
          onClick={() => setOpen(o => !o)}
          className="text-[12px] text-[var(--color-pattern-700)] hover:underline"
        >
          上位パターンから選択 ▼
        </button>
        {open && (
          <div className="absolute left-0 top-full z-20 mt-1 w-[260px] rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] p-2 shadow-md">
            <div className="grid grid-cols-2 gap-1">
              {topPatterns.map(t => (
                <Link
                  key={t.pattern_code}
                  href={`/ai/transitions?code=${t.pattern_code}`}
                  onClick={() => setOpen(false)}
                  className="rounded-[4px] px-2 py-1 text-left text-[11px] tabular-nums tracking-[0.05em] hover:bg-[var(--color-surface-muted)]"
                >
                  <span className="font-medium">{t.pattern_code}</span>
                  <span className="ml-1 text-[var(--color-text-tertiary)]">n={t.count.toLocaleString()}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
