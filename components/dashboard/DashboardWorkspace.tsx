'use client'

// components/dashboard/DashboardWorkspace.tsx
//
// Dashboard の作業面。セクションの並び順と折りたたみを localStorage に保存する (従来どおり)。
// 見た目の方針:
// - 普段は「目次 + 見出し + 折りたたみ」だけを出し、並べ替え操作は「並べ替え」モードの中に隠す
// - 各セクションは番号付きの見出しと 1 本の罫線で区切り、カードで囲まない

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, RotateCcw } from 'lucide-react'

export type DashboardWorkspaceSection = {
  id: string
  label: string
  /** 見出し横に出す一行説明 (md 以上) */
  description?: string
  content: React.ReactNode
}

type Preferences = {
  order: string[]
  collapsed: string[]
}

const STORAGE_KEY = 'stockboard_dashboard_workspace_v1'

const iconButtonClass =
  'inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-brand-800)] disabled:pointer-events-none disabled:opacity-25 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]'

const textButtonClass =
  'inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-[11px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]'

export function DashboardWorkspace({ sections }: { sections: DashboardWorkspaceSection[] }) {
  const defaultOrder = useMemo(() => sections.map((section) => section.id), [sections])
  const [preferences, setPreferences] = useState<Preferences>({
    order: defaultOrder,
    collapsed: [],
  })
  const [editing, setEditing] = useState(false)

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
    try {
      // 過去日表示などで一部のセクションしか無いときも、他のセクションの保存内容は消さない
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Preferences>
      const current = new Set(defaultOrder)
      const otherOrder = Array.isArray(stored.order) ? stored.order.filter((id) => typeof id === 'string' && !current.has(id)) : []
      const otherCollapsed = Array.isArray(stored.collapsed) ? stored.collapsed.filter((id) => typeof id === 'string' && !current.has(id)) : []
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ order: [...next.order, ...otherOrder], collapsed: [...next.collapsed, ...otherCollapsed] }),
      )
    } catch {
      // 保存できない環境 (プライベートモード等) でも画面上の操作は続ける
    }
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

  const reset = () => update({ order: defaultOrder, collapsed: [] })

  const sectionMap = new Map(sections.map((section) => [section.id, section]))
  const ordered = preferences.order
    .map((id) => sectionMap.get(id))
    .filter((section): section is DashboardWorkspaceSection => section != null)
  const customized =
    preferences.collapsed.length > 0 || preferences.order.some((id, index) => id !== defaultOrder[index])

  return (
    <div className="flex min-w-0 flex-col">
      <nav
        aria-label="Dashboardのセクション"
        className="mb-6 flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-[var(--color-border-default)] pb-2"
      >
        <span className="mr-2 text-[10px] font-semibold text-[var(--color-text-tertiary)]">セクション</span>
        {ordered.map((section, index) => {
          const collapsed = preferences.collapsed.includes(section.id)
          return (
            <a
              key={section.id}
              href={`#dashboard-section-${section.id}`}
              className={`inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-[12px] font-semibold transition-colors hover:bg-[var(--color-surface-subtle)] ${collapsed ? 'text-[var(--color-text-tertiary)]' : 'text-[var(--color-brand-800)]'}`}
            >
              <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-tertiary)]">{String(index + 1).padStart(2, '0')}</span>
              {section.label}
              {collapsed && <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">(閉)</span>}
            </a>
          )
        })}
        <div className="ml-auto flex items-center gap-1">
          {editing && customized && (
            <button type="button" onClick={reset} className={`${textButtonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]`}>
              <RotateCcw size={12} aria-hidden="true" />
              初期配置に戻す
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing((value) => !value)}
            aria-pressed={editing}
            className={`${textButtonClass} border ${editing ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-900)] text-white' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-brand-500)] hover:text-[var(--color-brand-800)]'}`}
          >
            {editing ? '並べ替えを終了' : '並べ替え'}
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-col gap-10">
        {ordered.map((section, index) => {
          const collapsed = preferences.collapsed.includes(section.id)
          const headingId = `dashboard-section-${section.id}-heading`
          const contentId = `dashboard-section-${section.id}-content`
          return (
            <section
              key={section.id}
              id={`dashboard-section-${section.id}`}
              aria-labelledby={headingId}
              className="min-w-0 scroll-mt-4"
            >
              <header
                className={`flex min-w-0 items-center gap-3 border-b-2 pb-1.5 ${collapsed ? 'border-[var(--color-border-default)]' : 'mb-4 border-[var(--color-brand-900)]'}`}
              >
                <span className="font-mono text-[11px] font-bold tabular-nums text-[var(--color-text-tertiary)]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h2
                  id={headingId}
                  className={`shrink-0 text-[16px] font-bold leading-tight ${collapsed ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-brand-900)]'}`}
                >
                  {section.label}
                </h2>
                {section.description && (
                  <p className="hidden min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-tertiary)] md:block">
                    {section.description}
                  </p>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  {editing && (
                    <>
                      <button
                        type="button"
                        onClick={() => move(section.id, -1)}
                        disabled={index === 0}
                        className={iconButtonClass}
                        title="上へ移動"
                        aria-label={`${section.label}を上へ移動`}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(section.id, 1)}
                        disabled={index === ordered.length - 1}
                        className={iconButtonClass}
                        title="下へ移動"
                        aria-label={`${section.label}を下へ移動`}
                      >
                        <ArrowDown size={14} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => toggle(section.id)}
                    aria-expanded={!collapsed}
                    aria-controls={contentId}
                    className={`${textButtonClass} text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-brand-800)]`}
                  >
                    <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                    <span className="max-sm:sr-only">{collapsed ? '表示する' : '折りたたむ'}</span>
                    <span className="sr-only">: {section.label}</span>
                  </button>
                </div>
              </header>
              <div id={contentId} hidden={collapsed} className="min-w-0">
                {!collapsed && section.content}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
