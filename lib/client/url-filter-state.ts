'use client'

export type UrlFilterValue = string | number | boolean | null | undefined

/**
 * Keep list filters in the current history entry so browser Back restores them.
 * Each caller owns only its keys, allowing nested filter components to coexist.
 */
export function replaceCurrentUrlFilters(updates: Record<string, UrlFilterValue>) {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '' || value === false) {
      url.searchParams.delete(key)
    } else {
      url.searchParams.set(key, value === true ? '1' : String(value))
    }
  }

  const next = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (next !== current) {
    window.history.replaceState(window.history.state, '', next)
  }
}
