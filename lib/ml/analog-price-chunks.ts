const DAY_MS = 86_400_000
const POINT_BYTES = 12

export type AnalogPricePoint = {
  date: string
  close: number
}

export function deduplicateAnalogPriceRows<T extends { ticker: string; date: string }>(rows: T[]): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) byKey.set(`${row.ticker}\u0000${row.date}`, row)
  return [...byKey.values()].sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date),
  )
}

export function analogDateToEpochDay(date: string): number {
  const value = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(value)) throw new Error(`Invalid analog price date: ${date}`)
  return Math.floor(value / DAY_MS)
}

export function encodeAnalogPriceChunk(rows: AnalogPricePoint[]): Uint8Array {
  const buffer = new ArrayBuffer(rows.length * POINT_BYTES)
  const view = new DataView(buffer)
  for (let index = 0; index < rows.length; index += 1) {
    const close = Number(rows[index].close)
    if (!Number.isFinite(close) || close <= 0) {
      throw new Error(`Invalid analog close for ${rows[index].date}`)
    }
    const offset = index * POINT_BYTES
    view.setUint32(offset, analogDateToEpochDay(rows[index].date), true)
    view.setFloat64(offset + 4, close, true)
  }
  return new Uint8Array(buffer)
}

export function decodeAnalogPriceChunk(
  value: ArrayBuffer | Uint8Array,
  minEpochDay: number,
  maxEpochDay: number,
): AnalogPricePoint[] {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength % POINT_BYTES !== 0) throw new Error('Invalid analog price chunk length.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rows: AnalogPricePoint[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += POINT_BYTES) {
    const epochDay = view.getUint32(offset, true)
    if (epochDay < minEpochDay || epochDay > maxEpochDay) continue
    rows.push({
      date: new Date(epochDay * DAY_MS).toISOString().slice(0, 10),
      close: view.getFloat64(offset + 4, true),
    })
  }
  return rows
}
