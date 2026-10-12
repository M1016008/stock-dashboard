'use client'

const inFlight = new Map<string, Promise<unknown | null>>()

/** Share only an in-flight read. Completed reads are deliberately not cached. */
export function loadUsMlStatus<T>(url: string): Promise<T | null> {
  const existing = inFlight.get(url)
  if (existing) return existing as Promise<T | null>

  const request = fetch(url, { cache: 'no-store' })
    .then((response) => response.ok ? response.json() as Promise<T> : null)
    .catch(() => null)
    .finally(() => {
      if (inFlight.get(url) === request) inFlight.delete(url)
    })
  inFlight.set(url, request)
  return request
}
