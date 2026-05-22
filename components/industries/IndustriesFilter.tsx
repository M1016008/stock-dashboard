// components/industries/IndustriesFilter.tsx
// Phase 4 F2: 検索ボックス + 大分類 chip フィルタ + 並べ替え

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
  { value: 'change_desc', label: '騰落率 降順' },
  { value: 'change_asc', label: '騰落率 昇順' },
  { value: 'count_desc', label: '銘柄数 降順' },
  { value: 'name_asc', label: '名前順' },
]

export function IndustriesFilter({ q, majorFilter, sort, majorList }: Props) {
  const router = useRouter()
  const search = useSearchParams()
  const [val, setVal] = useState(q)

  function pushParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(search.toString())
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, v)
    }
    params.delete('selected')  // フィルタ変更で選択解除
    router.push(`/industries?${params.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <form
        onSubmit={(e) => { e.preventDefault(); pushParams({ q: val }) }}
        className="flex items-center gap-2"
      >
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="業界名で検索 (例: AI)"
          className="w-[220px] rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] px-3 py-1.5 text-[12px] outline-none focus:border-[var(--color-brand-500)]"
        />
        <button type="submit" className="rounded-[6px] bg-[var(--color-brand-600)] px-3 py-1.5 text-[12px] text-white">検索</button>
      </form>
      {majorFilter && (
        <button
          onClick={() => pushParams({ major: null })}
          className="rounded-full bg-[var(--color-brand-50)] px-2.5 py-0.5 text-[11px] text-[var(--color-brand-700)] hover:bg-[var(--color-brand-100)]"
        >
          {majorFilter} ×
        </button>
      )}
      <select
        value={majorFilter ?? ''}
        onChange={(e) => pushParams({ major: e.target.value || null })}
        className="rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] px-2 py-1.5 text-[12px]"
      >
        <option value="">大分類で絞り込み (全て)</option>
        {majorList.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
      <select
        value={sort}
        onChange={(e) => pushParams({ sort: e.target.value })}
        className="rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] px-2 py-1.5 text-[12px]"
      >
        {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}
