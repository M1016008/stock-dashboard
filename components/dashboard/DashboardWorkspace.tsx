'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react'

export type DashboardWorkspaceSection = {
  id: string
  label: string
  content: React.ReactNode
}

type Preferences = {
  order: string[]
  collapsed: string[]
}

const STORAGE_KEY = 'stockboard_dashboard_workspace_v1'

export function DashboardWorkspace({ sections }: { sections: DashboardWorkspaceSection[] }) {
  const defaultOrder = useMemo(() => sections.map((section) => section.id), [sections])
  const [preferences, setPreferences] = useState<Preferences>({
    order: defaultOrder,
    collapsed: [],
  })

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Preferences>
      const valid = new Set(defaultOrder)
      const storedOrder = Array.isArray(stored.order) ? stored.order.filter((id) => valid.has(id)) : []
      const missing = defaultOrder.filter((id) => !storedOrder.includes(id))
      setPreferences({
        order: [...storedOrder, ...missing],
        collapsed: Array.isArray(stored.collapsed) ? stored.collapsed.filter((id) => valid.has(id)) : [],
      })
    } catch {
      setPreferences({ order: defaultOrder, collapsed: [] })
    }
  }, [defaultOrder])

  const update = (next: Preferences) => {
    setPreferences(next)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  const move = (id: string, delta: -1 | 1) => {
    const order = [...preferences.order]
    const index = order.indexOf(id)
    const nextIndex = index + delta
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return
    const [item] = order.splice(index, 1)
    order.splice(nextIndex, 0, item)
    update({ ...preferences, order })
  }

  const toggle = (id: string) => {
    const collapsed = preferences.collapsed.includes(id)
      ? preferences.collapsed.filter((item) => item !== id)
      : [...preferences.collapsed, id]
    update({ ...preferences, collapsed })
  }

  const sectionMap = new Map(sections.map((section) => [section.id, section]))

  return (
    <div className="flex flex-col gap-4">
      {preferences.order.map((id, index) => {
        const section = sectionMap.get(id)
        if (!section) return null
        const collapsed = preferences.collapsed.includes(id)
        return (
          <section key={id} className="min-w-0">
            <div className="mb-2 flex h-8 items-center border-b border-[var(--color-border-default)]">
              <h2 className="text-[12px] font-black text-[var(--color-brand-900)]">{section.label}</h2>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => move(id, -1)}
                  disabled={index === 0}
                  className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-white disabled:opacity-25"
                  title="上へ移動"
                  aria-label={`${section.label}を上へ移動`}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => move(id, 1)}
                  disabled={index === preferences.order.length - 1}
                  className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-white disabled:opacity-25"
                  title="下へ移動"
                  aria-label={`${section.label}を下へ移動`}
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:bg-white"
                  title={collapsed ? '表示する' : '折りたたむ'}
                  aria-label={`${section.label}を${collapsed ? '表示する' : '折りたたむ'}`}
                >
                  {collapsed ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
              </div>
            </div>
            {!collapsed && section.content}
          </section>
        )
      })}
    </div>
  )
}
