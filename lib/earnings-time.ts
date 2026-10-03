export type EarningsTimeKind = 'confirmed' | 'scheduled' | 'predicted' | 'unknown'
export type EarningsPredictionConfidence = 'high' | 'medium' | 'low'
export type EarningsTimeBucket =
  | 'pre_open'
  | 'morning'
  | 'lunch'
  | 'afternoon'
  | 'after_close'
  | 'unknown'

export interface EarningsTimePrediction {
  time: string
  confidence: EarningsPredictionConfidence
  sampleCount: number
  modeCount: number
}

const TIME_BUCKET_LABELS: Record<EarningsTimeBucket, string> = {
  pre_open: '寄付前',
  morning: '前場中',
  lunch: '昼休み',
  afternoon: '後場中',
  after_close: '大引け後',
  unknown: '時刻未定',
}

const CONFIDENCE_LABELS: Record<EarningsPredictionConfidence, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

export function normalizeEarningsTime(value: string | null | undefined): string | null {
  if (!value) return null
  const compact = value.trim().replace(/[時:]/g, '').replace(/分/g, '')
  if (!/^\d{3,6}$/.test(compact)) return null

  const padded = compact.padStart(compact.length <= 4 ? 4 : 6, '0')
  const hours = Number(padded.slice(0, 2))
  const minutes = Number(padded.slice(2, 4))
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return null
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function classifyEarningsTime(
  value: string | null | undefined,
  announceDate?: string | null,
): EarningsTimeBucket {
  const time = normalizeEarningsTime(value)
  if (!time) return 'unknown'
  const [hours, minutes] = time.split(':').map(Number)
  const minuteOfDay = hours * 60 + minutes
  const closeMinute = announceDate && announceDate < '2024-11-05' ? 15 * 60 : 15 * 60 + 30

  if (minuteOfDay < 9 * 60) return 'pre_open'
  if (minuteOfDay < 11 * 60 + 30) return 'morning'
  if (minuteOfDay < 12 * 60 + 30) return 'lunch'
  if (minuteOfDay < closeMinute) return 'afternoon'
  return 'after_close'
}

export function predictEarningsTime(
  actualTimes: Array<string | null | undefined>,
): EarningsTimePrediction | null {
  const samples = actualTimes
    .map(normalizeEarningsTime)
    .filter((time): time is string => time != null)
    .slice(0, 8)
    .map(toMinuteOfDay)

  if (samples.length < 3) return null

  const slots = new Map<number, number>()
  for (const minute of samples) {
    const slot = Math.round(minute / 30) * 30
    slots.set(slot, (slots.get(slot) ?? 0) + 1)
  }
  const [modeSlot, modeCount] = [...slots.entries()]
    .sort((a, b) => b[1] - a[1] || Math.abs(a[0] - median(samples)) - Math.abs(b[0] - median(samples)))[0]
  const modeSamples = samples.filter((minute) => Math.round(minute / 30) * 30 === modeSlot)
  const predictedMinute = roundToFiveMinutes(median(modeSamples))
  const share = modeCount / samples.length
  const confidence: EarningsPredictionConfidence =
    samples.length >= 6 && share >= 0.75
      ? 'high'
      : samples.length >= 4 && share >= 0.5
        ? 'medium'
        : 'low'

  return {
    time: fromMinuteOfDay(predictedMinute),
    confidence,
    sampleCount: samples.length,
    modeCount,
  }
}

export function earningsTimeBucketLabel(bucket: EarningsTimeBucket | null | undefined): string {
  return TIME_BUCKET_LABELS[bucket ?? 'unknown']
}

export function earningsPredictionConfidenceLabel(
  confidence: EarningsPredictionConfidence | null | undefined,
): string {
  return confidence ? CONFIDENCE_LABELS[confidence] : '---'
}

function toMinuteOfDay(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function fromMinuteOfDay(value: number): string {
  const normalized = Math.max(0, Math.min(23 * 60 + 59, value))
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

function roundToFiveMinutes(value: number): number {
  return Math.round(value / 5) * 5
}
