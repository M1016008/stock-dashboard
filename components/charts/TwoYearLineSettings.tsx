'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import {
  TWO_YEAR_LINE_COLOR_PRESETS,
  TWO_YEAR_LINE_DASH_ARRAYS,
  TWO_YEAR_LINE_DISPLAY_STORAGE_KEY,
  TWO_YEAR_LINE_SLOTS,
  TWO_YEAR_LINE_STYLES,
  readTwoYearLineDisplaySettings,
  updateTwoYearLineSlot,
  writeTwoYearLineDisplaySettings,
  type ResolvedTwoYearLineDisplay,
  type TwoYearLineDisplaySettings,
  type TwoYearLineSlot,
  type TwoYearLineSlotOverride,
  type TwoYearLineStyle,
} from '@/lib/two-year-line-display'

const SLOT_LABELS: Record<TwoYearLineSlot, string> = { recent: '直近のライン', previous: '1本前のライン' }
const STYLE_LABELS: Record<TwoYearLineStyle, string> = { solid: '実線', dashed: '破線', dotted: '点線' }
const COLOR_LABELS: Record<(typeof TWO_YEAR_LINE_COLOR_PRESETS)[number], string> = {
  '#0f766e': 'ティール',
  '#b7791f': 'アンバー',
  '#2563eb': 'ブルー',
  '#7c3aed': 'パープル',
  '#be185d': 'マゼンタ',
  '#475569': 'スレート',
}

/** JP/US 共通の表示設定。SSR では空設定で描画し、マウント後に localStorage を読む。 */
export function useTwoYearLineDisplaySettings() {
  const [settings, setSettings] = useState<TwoYearLineDisplaySettings>({})

  useEffect(() => {
    setSettings(readTwoYearLineDisplaySettings(window.localStorage))
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === TWO_YEAR_LINE_DISPLAY_STORAGE_KEY) {
        setSettings(readTwoYearLineDisplaySettings(window.localStorage))
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const commit = useCallback((next: TwoYearLineDisplaySettings) => {
    setSettings(next)
    writeTwoYearLineDisplaySettings(window.localStorage, next)
  }, [])

  const updateSlot = useCallback((slot: TwoYearLineSlot, patch: TwoYearLineSlotOverride) => {
    setSettings((current) => {
      const next = updateTwoYearLineSlot(current, slot, patch)
      writeTwoYearLineDisplaySettings(window.localStorage, next)
      return next
    })
  }, [])

  const reset = useCallback(() => commit({}), [commit])

  return { settings, updateSlot, reset }
}

export function TwoYearLineSettings({
  settings,
  displays,
  onChange,
  onReset,
}: {
  settings: TwoYearLineDisplaySettings
  /** 現在表示中のラインの slot → 実効表示。未表示 slot は undefined。 */
  displays: Readonly<Partial<Record<TwoYearLineSlot, ResolvedTwoYearLineDisplay>>>
  onChange: (slot: TwoYearLineSlot, patch: TwoYearLineSlotOverride) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null)
      return
    }
    const placeMenu = () => {
      const trigger = buttonRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const viewportWidth = document.documentElement.clientWidth
      const viewportHeight = document.documentElement.clientHeight
      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const padding = 12
      const gap = 4
      const left = Math.min(
        Math.max(triggerRect.right - menuRect.width, padding),
        Math.max(padding, viewportWidth - menuRect.width - padding),
      )
      const below = viewportHeight - triggerRect.bottom - padding - gap
      const above = triggerRect.top - padding - gap
      const opensAbove = below < Math.min(menuRect.height, 240) && above > below
      const maxHeight = Math.max(160, opensAbove ? above : below)
      const top = opensAbove
        ? Math.max(padding, triggerRect.top - Math.min(menuRect.height, maxHeight) - gap)
        : triggerRect.bottom + gap
      setMenuPosition({ left, top, maxHeight })
    }
    placeMenu()
    const observer = new ResizeObserver(placeMenu)
    if (menuRef.current) observer.observe(menuRef.current)
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} style={rootStyle} data-two-year-line-settings>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="上昇終値ラインの表示設定"
        title="上昇終値ラインの表示設定"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
        style={triggerStyle(open)}
        data-two-year-line-settings-trigger
      >
        <Settings size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="group"
          aria-label="上昇終値ラインの表示設定"
          style={menuStyle(menuPosition)}
          data-two-year-line-settings-menu
        >
          {TWO_YEAR_LINE_SLOTS.map((slot) => {
            const effective = displays[slot]
            const style = settings[slot]?.style ?? effective?.style ?? null
            const color = settings[slot]?.color ?? effective?.color ?? '#0f766e'
            return (
              <fieldset key={slot} style={fieldsetStyle} data-two-year-line-slot={slot}>
                <legend style={legendStyle}>
                  {SLOT_LABELS[slot]}
                  {!effective && <span style={mutedStyle}>（なし）</span>}
                </legend>
                <div role="group" aria-label={`${SLOT_LABELS[slot]}の線種`} style={rowStyle}>
                  {TWO_YEAR_LINE_STYLES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={style === option}
                      onClick={() => onChange(slot, { style: option })}
                      style={choiceStyle(style === option)}
                      className="min-h-11 sm:min-h-7"
                      data-two-year-line-style-option={option}
                    >
                      <svg width="22" height="6" viewBox="0 0 22 6" aria-hidden="true">
                        <line
                          x1="1" y1="3" x2="21" y2="3"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                          strokeDasharray={TWO_YEAR_LINE_DASH_ARRAYS[option] ?? undefined}
                        />
                      </svg>
                      {STYLE_LABELS[option]}
                    </button>
                  ))}
                </div>
                <div role="group" aria-label={`${SLOT_LABELS[slot]}の色`} style={rowStyle}>
                  {TWO_YEAR_LINE_COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => onChange(slot, { color: preset })}
                      aria-label={`${COLOR_LABELS[preset]} ${preset}`}
                      aria-pressed={color.toLowerCase() === preset}
                      title={preset}
                      style={swatchStyle(preset, color.toLowerCase() === preset)}
                      className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
                      data-two-year-line-color-preset={preset}
                    />
                  ))}
                  <input
                    type="color"
                    value={color}
                    onInput={(event) => onChange(slot, { color: event.currentTarget.value })}
                    aria-label={`${SLOT_LABELS[slot]}のカスタム色`}
                    style={colorInputStyle}
                    className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
                    data-two-year-line-color-input={slot}
                  />
                </div>
              </fieldset>
            )
          })}
          <button
            type="button"
            onClick={onReset}
            style={resetStyle}
            className="min-h-11 sm:min-h-7"
            data-two-year-line-settings-reset
          >
            初期設定に戻す
          </button>
        </div>
      )}
    </div>
  )
}

const rootStyle: React.CSSProperties = { position: 'relative', display: 'inline-flex' }

const triggerStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 6px',
  borderRadius: '6px',
  border: '1px solid var(--border)',
  background: active ? 'var(--bg-tertiary, rgba(100,116,139,0.15))' : 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
})

const menuStyle = (position: { left: number; top: number; maxHeight: number } | null): React.CSSProperties => ({
  position: 'fixed',
  top: position?.top ?? 12,
  left: position?.left ?? 12,
  zIndex: 30,
  width: 'min(264px, calc(100vw - 24px))',
  maxHeight: position?.maxHeight,
  overflowY: 'auto',
  visibility: position ? 'visible' : 'hidden',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px',
  borderRadius: '8px',
  border: '1px solid var(--border)',
  background: 'var(--bg-secondary, #fff)',
  boxShadow: '0 6px 20px rgba(15, 23, 42, 0.18)',
  fontSize: '12px',
  color: 'var(--text-primary)',
})

const fieldsetStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  border: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  minWidth: 0,
}

const legendStyle: React.CSSProperties = { padding: 0, marginBottom: '4px', fontWeight: 700, fontSize: '12px' }
const mutedStyle: React.CSSProperties = { fontWeight: 400, color: 'var(--text-muted)', marginLeft: '4px' }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }

const choiceStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '0 8px',
  borderRadius: '6px',
  border: `1px solid ${active ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
  background: active ? 'rgba(37, 99, 235, 0.1)' : 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
})

const swatchStyle = (color: string, active: boolean): React.CSSProperties => ({
  width: '22px',
  height: '22px',
  borderRadius: '50%',
  border: '1px solid var(--border)',
  background: color,
  boxShadow: active ? '0 0 0 2px var(--bg-secondary, #fff), 0 0 0 4px var(--accent, #2563eb)' : 'none',
  cursor: 'pointer',
  padding: 0,
})

const colorInputStyle: React.CSSProperties = {
  width: '28px',
  height: '24px',
  padding: 0,
  border: '1px solid var(--border)',
  borderRadius: '4px',
  background: 'transparent',
  cursor: 'pointer',
}

const resetStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  padding: '0 10px',
  borderRadius: '6px',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}
