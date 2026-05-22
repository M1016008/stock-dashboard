// components/industries/IndustriesFilterMock.tsx
// モック準拠 (industries_mock):
//   - 検索ボックス (placeholder: 業界名検索)
//   - 大分類 chip (アクティブなら × で外せる)
//   - 「+ 絞り込み」(大分類セレクト)
//   - 並べ替え

'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'

interface Props {
  q: string
  majorFilter: string | null
  sort: string
  majorList: string[]
}

const SORT_OPTIONS = [
  { value: 'change_desc', label: '騰落率 ↓' },
  { value: 'change_asc', label: '騰落率 ↑' },
  { value: 'count_desc', label: '銘柄数 ↓' },
  { value: 'name_asc', label: '名前順' },
]

export function IndustriesFilterMock({ q, majorFilter, sort, majorList }: Props) {
  const router = useRouter()
  const search = useSearchParams()
  const [val, setVal] = useState(q)

  function pushParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(search.toString())
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, v)
    }
    params.delete('selected')
    router.push(`/industries?${params.toString()}`)
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <form
        onSubmit={(e) => { e.preventDefault(); pushParams({ q: val }) }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 240 }}
      >
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>🔍</span>
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="業界名検索 (例: AI、半導体、バイオ)"
          style={{
            flex: 1,
            padding: '6px 10px',
            border: '0.5px solid var(--color-border-soft)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--color-text-primary)',
            background: 'var(--color-surface-base)',
            outline: 'none',
          }}
        />
      </form>

      {majorFilter && (
        <span className="sb-chip">
          大分類: {majorFilter}
          <span
            className="sb-x"
            onClick={() => pushParams({ major: null })}
            role="button"
          >
            ×
          </span>
        </span>
      )}

      <select
        value={majorFilter ?? ''}
        onChange={(e) => pushParams({ major: e.target.value || null })}
        style={{
          padding: '5px 10px',
          border: '0.5px dashed var(--color-border-default)',
          borderRadius: 9999,
          fontSize: 11,
          background: 'var(--color-surface-base)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
        }}
      >
        <option value="">+ 大分類で絞り込み</option>
        {majorList.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      <select
        value={sort}
        onChange={(e) => pushParams({ sort: e.target.value })}
        style={{
          padding: '5px 10px',
          border: '0.5px solid var(--color-border-soft)',
          borderRadius: 6,
          fontSize: 11,
          background: 'var(--color-surface-base)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
        }}
      >
        {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>並べ替え: {o.label}</option>)}
      </select>
    </div>
  )
}
