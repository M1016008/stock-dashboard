export const STAGE_CODE_AXES = [
  { key: 'dailyA', label: '日A', longLabel: '日足A' },
  { key: 'dailyB', label: '日B', longLabel: '日足B' },
  { key: 'weeklyA', label: '週A', longLabel: '週足A' },
  { key: 'weeklyB', label: '週B', longLabel: '週足B' },
  { key: 'monthlyA', label: '月A', longLabel: '月足A' },
  { key: 'monthlyB', label: '月B', longLabel: '月足B' },
] as const

export const STAGE_TRANSITION_AVERAGE_SESSIONS = 20
export const STAGE_TRANSITION_MAX_CUSTOM_DAYS = 366
export const STAGE_TRANSITION_ANY_CODE = 'any'

export type StageCodeAxis = typeof STAGE_CODE_AXES[number]
export type StageTransitionPeriod = 'today' | 'week' | 'month' | 'custom'
export type StageTransitionSort =
  | 'date'
  | 'ticker'
  | 'industry'
  | 'price'
  | 'avgVolume'
  | 'avgTurnover'
export type StageTransitionSortDirection = 'asc' | 'desc'

export interface StageTransitionFilters {
  industry33: string | null
  marketSegment: string | null
  minPrice: number | null
  maxPrice: number | null
  minAvgVolume: number | null
  maxAvgVolume: number | null
  minAvgTurnover: number | null
  maxAvgTurnover: number | null
}

export interface StageTransitionSearchInput extends StageTransitionFilters {
  fromCode: string
  toCode: string
  universeFilter: UniverseFilterValue
  period: StageTransitionPeriod
  customFrom: string | null
  customTo: string | null
  sort: StageTransitionSort
  direction: StageTransitionSortDirection
  page: number
  pageSize: number
}

export interface StageTransitionRow {
  ticker: string
  name: string
  transitionDate: string
  fromCode: string
  toCode: string
  changedAxes: Array<{ key: StageCodeAxis['key']; label: string; from: number; to: number }>
  sector33: string | null
  marketSegment: string | null
  price: number | null
  averageVolume20: number | null
  averageTurnover20: number | null
}

export function isStageCode(value: string): boolean {
  return /^[1-6]{6}$/.test(value)
}

export function isStageCodeFilter(value: string): boolean {
  return value === STAGE_TRANSITION_ANY_CODE || isStageCode(value)
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function parseStageTransitionPeriod(value: string | null): StageTransitionPeriod {
  return value === 'week' || value === 'month' || value === 'custom' ? value : 'today'
}

export function parseStageTransitionSort(value: string | null): StageTransitionSort {
  return value === 'ticker'
    || value === 'industry'
    || value === 'price'
    || value === 'avgVolume'
    || value === 'avgTurnover'
    ? value
    : 'date'
}

export function parseStageTransitionSortDirection(value: string | null): StageTransitionSortDirection {
  return value === 'asc' ? 'asc' : 'desc'
}

export function parseOptionalNonNegativeNumber(value: string | null): number | null {
  if (value == null || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return Number.NaN
  return parsed
}

export function changedStageCodeAxes(fromCode: string, toCode: string): StageTransitionRow['changedAxes'] {
  if (!isStageCode(fromCode) || !isStageCode(toCode)) return []
  return STAGE_CODE_AXES.flatMap((axis, index) => {
    const from = Number(fromCode[index])
    const to = Number(toCode[index])
    return from === to ? [] : [{ key: axis.key, label: axis.label, from, to }]
  })
}

export function startOfWeek(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  const mondayOffset = (parsed.getUTCDay() + 6) % 7
  parsed.setUTCDate(parsed.getUTCDate() - mondayOffset)
  return parsed.toISOString().slice(0, 10)
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`
}

export function inclusiveCalendarDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  return Math.floor((toMs - fromMs) / 86_400_000) + 1
}
import type { UniverseFilterValue } from '@/lib/market-universe'
