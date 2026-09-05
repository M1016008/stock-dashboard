export const TOKYO_TIME_ZONE = 'Asia/Tokyo'

function datePartsInTimeZone(value: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value).map((part) => [part.type, part.value]),
  )
}

export function isoDateInTimeZone(value: Date = new Date(), timeZone = TOKYO_TIME_ZONE): string {
  const parts = datePartsInTimeZone(value, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function todayInTokyo(value: Date = new Date()): string {
  return isoDateInTimeZone(value, TOKYO_TIME_ZONE)
}

export function endOfTokyoDateEpoch(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid ISO date: ${date}`)
  return Math.floor(Date.parse(`${date}T23:59:59.999+09:00`) / 1000)
}

export function epochDateInTokyo(epochSeconds: number | string | null | undefined): string | null {
  const epoch = Number(epochSeconds)
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  return todayInTokyo(new Date(epoch * 1000))
}
