// 24か月足 上昇終値ラインの表示カスタマイズ (表示専用)。
// ライン検出・角度・フィルタには一切関与しない。

export const TWO_YEAR_LINE_DISPLAY_STORAGE_KEY = 'stockboard:two-year-line-display:v1'
export const TWO_YEAR_LINE_DISPLAY_VERSION = 1

export const TWO_YEAR_LINE_SLOTS = ['recent', 'previous'] as const
export type TwoYearLineSlot = (typeof TWO_YEAR_LINE_SLOTS)[number]

export const TWO_YEAR_LINE_STYLES = ['solid', 'dashed', 'dotted'] as const
export type TwoYearLineStyle = (typeof TWO_YEAR_LINE_STYLES)[number]

export const TWO_YEAR_CONFIRMED_DEFAULT_COLOR = '#0f766e'
export const TWO_YEAR_PROVISIONAL_DEFAULT_COLOR = '#b7791f'

export const TWO_YEAR_LINE_COLOR_PRESETS = [
  '#0f766e',
  '#b7791f',
  '#2563eb',
  '#7c3aed',
  '#be185d',
  '#475569',
] as const

export const TWO_YEAR_LINE_DASH_ARRAYS: Readonly<Record<TwoYearLineStyle, string | null>> = {
  solid: null,
  dashed: '8 6',
  dotted: '1 6',
}

export interface TwoYearLineSlotOverride {
  style?: TwoYearLineStyle
  color?: string
}

export type TwoYearLineDisplaySettings = Partial<Record<TwoYearLineSlot, TwoYearLineSlotOverride>>

export interface TwoYearLineOrderable {
  id: string
  status: 'confirmed' | 'provisional'
  endpointStartYear: number
}

export interface ResolvedTwoYearLineDisplay {
  slot: TwoYearLineSlot | null
  style: TwoYearLineStyle
  color: string
  width: 2 | 3
  dashArray: string | null
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

export function normalizeHexColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : null
}

export function isTwoYearLineStyle(value: unknown): value is TwoYearLineStyle {
  return typeof value === 'string' && (TWO_YEAR_LINE_STYLES as readonly string[]).includes(value)
}

/** endpointStartYear 降順 (同値は id 昇順) で recent / previous を割り当てる。 */
export function assignTwoYearLineSlots<T extends TwoYearLineOrderable>(
  lines: readonly T[],
): Map<string, TwoYearLineSlot> {
  const ordered = lines.slice().sort((a, b) =>
    b.endpointStartYear - a.endpointStartYear || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const slots = new Map<string, TwoYearLineSlot>()
  ordered.slice(0, TWO_YEAR_LINE_SLOTS.length).forEach((line, index) => {
    slots.set(line.id, TWO_YEAR_LINE_SLOTS[index])
  })
  return slots
}

export function defaultTwoYearLineDisplay(status: TwoYearLineOrderable['status']): Omit<ResolvedTwoYearLineDisplay, 'slot'> {
  return status === 'confirmed'
    ? { style: 'solid', color: TWO_YEAR_CONFIRMED_DEFAULT_COLOR, width: 3, dashArray: null }
    : { style: 'dashed', color: TWO_YEAR_PROVISIONAL_DEFAULT_COLOR, width: 2, dashArray: TWO_YEAR_LINE_DASH_ARRAYS.dashed }
}

export function resolveTwoYearLineDisplay(
  status: TwoYearLineOrderable['status'],
  slot: TwoYearLineSlot | null,
  settings: TwoYearLineDisplaySettings,
): ResolvedTwoYearLineDisplay {
  const base = defaultTwoYearLineDisplay(status)
  const override = slot ? settings[slot] : undefined
  const style = override?.style ?? base.style
  return {
    slot,
    style,
    color: override?.color ?? base.color,
    width: base.width,
    dashArray: TWO_YEAR_LINE_DASH_ARRAYS[style],
  }
}

export function resolveTwoYearLineDisplays<T extends TwoYearLineOrderable>(
  lines: readonly T[],
  settings: TwoYearLineDisplaySettings,
): Map<string, ResolvedTwoYearLineDisplay> {
  const slots = assignTwoYearLineSlots(lines)
  return new Map(lines.map((line) => [
    line.id,
    resolveTwoYearLineDisplay(line.status, slots.get(line.id) ?? null, settings),
  ]))
}

function sanitizeOverride(value: unknown): TwoYearLineSlotOverride | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const override: TwoYearLineSlotOverride = {}
  if (isTwoYearLineStyle(record.style)) override.style = record.style
  const color = normalizeHexColor(record.color)
  if (color) override.color = color
  return override.style || override.color ? override : undefined
}

export function sanitizeTwoYearLineDisplaySettings(value: unknown): TwoYearLineDisplaySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const settings: TwoYearLineDisplaySettings = {}
  for (const slot of TWO_YEAR_LINE_SLOTS) {
    const override = sanitizeOverride(record[slot])
    if (override) settings[slot] = override
  }
  return settings
}

export function parseTwoYearLineDisplayPayload(raw: string | null | undefined): TwoYearLineDisplaySettings {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    if (record.version !== TWO_YEAR_LINE_DISPLAY_VERSION) return {}
    return sanitizeTwoYearLineDisplaySettings(record.slots)
  } catch {
    return {}
  }
}

/** 空設定は null (= ストレージから削除)。 */
export function serializeTwoYearLineDisplayPayload(settings: TwoYearLineDisplaySettings): string | null {
  const slots = sanitizeTwoYearLineDisplaySettings(settings)
  if (Object.keys(slots).length === 0) return null
  return JSON.stringify({ version: TWO_YEAR_LINE_DISPLAY_VERSION, slots })
}

export function updateTwoYearLineSlot(
  settings: TwoYearLineDisplaySettings,
  slot: TwoYearLineSlot,
  patch: TwoYearLineSlotOverride,
): TwoYearLineDisplaySettings {
  return sanitizeTwoYearLineDisplaySettings({ ...settings, [slot]: { ...settings[slot], ...patch } })
}

export function readTwoYearLineDisplaySettings(storage: Pick<Storage, 'getItem'> | null | undefined): TwoYearLineDisplaySettings {
  try {
    return parseTwoYearLineDisplayPayload(storage?.getItem(TWO_YEAR_LINE_DISPLAY_STORAGE_KEY))
  } catch {
    return {}
  }
}

export function writeTwoYearLineDisplaySettings(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined,
  settings: TwoYearLineDisplaySettings,
): void {
  if (!storage) return
  try {
    const payload = serializeTwoYearLineDisplayPayload(settings)
    if (payload === null) storage.removeItem(TWO_YEAR_LINE_DISPLAY_STORAGE_KEY)
    else storage.setItem(TWO_YEAR_LINE_DISPLAY_STORAGE_KEY, payload)
  } catch {
    // ストレージ不可 (プライベートモード等) はセッション内のみ有効
  }
}
