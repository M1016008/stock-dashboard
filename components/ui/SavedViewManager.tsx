'use client'

import { useEffect, useState } from 'react'
import { BookmarkPlus, Trash2 } from 'lucide-react'

type SavedView<T> = {
  id: string
  name: string
  value: T
  updatedAt: number
}

export function SavedViewManager<T>({
  storageKey,
  value,
  onApply,
}: {
  storageKey: string
  value: T
  onApply: (value: T) => void
}) {
  const [views, setViews] = useState<Array<SavedView<T>>>([])
  const [name, setName] = useState('')
  const [selectedId, setSelectedId] = useState('')

  useEffect(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
      if (Array.isArray(parsed)) setViews(parsed)
    } catch {
      setViews([])
    }
  }, [storageKey])

  const persist = (next: Array<SavedView<T>>) => {
    setViews(next)
    window.localStorage.setItem(storageKey, JSON.stringify(next))
  }

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const existing = views.find((item) => item.name === trimmed)
    const nextView: SavedView<T> = {
      id: existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      value,
      updatedAt: Date.now(),
    }
    persist([nextView, ...views.filter((item) => item.id !== nextView.id)].slice(0, 20))
    setSelectedId(nextView.id)
    setName('')
  }

  const remove = () => {
    if (!selectedId) return
    persist(views.filter((item) => item.id !== selectedId))
    setSelectedId('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={selectedId}
        onChange={(event) => {
          const id = event.target.value
          setSelectedId(id)
          const selected = views.find((item) => item.id === id)
          if (selected) onApply(selected.value)
        }}
        className="h-8 min-w-[150px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold"
        aria-label="保存済みビュー"
      >
        <option value="">保存済みビュー</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>{view.name}</option>
        ))}
      </select>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
        placeholder="ビュー名"
        className="h-8 w-[130px] border border-[var(--color-border-default)] px-2 text-[11px] font-semibold"
      />
      <button
        type="button"
        onClick={save}
        disabled={!name.trim()}
        className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white disabled:cursor-not-allowed disabled:opacity-40"
        title="現在の条件を保存"
        aria-label="現在の条件を保存"
      >
        <BookmarkPlus size={14} />
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={!selectedId}
        className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)] bg-white text-[var(--color-text-tertiary)] disabled:cursor-not-allowed disabled:opacity-40"
        title="選択したビューを削除"
        aria-label="選択したビューを削除"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}
