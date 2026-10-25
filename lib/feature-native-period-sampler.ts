import * as F from '@/lib/features'
import { calendarMonthBucket, calendarWeekBucket } from '@/lib/timeframes'

export type FeatureSamplingTimescale = 'daily' | 'weekly' | 'monthly'

type PeriodKey = string | number
type PeriodSample<T> = { period: PeriodKey; value: T }

export type NativePeriodFeatureSample = {
  divergenceA: number
  divergenceB: number
  divergenceADelta: number
  divergenceBDelta: number
  divergencePercentile: number
  stageAAge: number | null
  stageBAge: number | null
  trends: Array<{ slope: number; acceleration: number } | null>
}

function periodKey(date: string, timescale: FeatureSamplingTimescale): PeriodKey {
  if (timescale === 'weekly') return calendarWeekBucket(date)
  if (timescale === 'monthly') return calendarMonthBucket(date)
  return date
}

function upsertPeriodSample<T>(series: PeriodSample<T>[], period: PeriodKey, value: T): void {
  const latest = series[series.length - 1]
  if (latest?.period === period) {
    latest.value = value
  } else {
    series.push({ period, value })
  }
}

function stageAge(series: PeriodSample<number | null>[]): number | null {
  const current = series.at(-1)?.value ?? null
  if (current == null) return null
  let age = 0
  for (let index = series.length - 2; index >= 0 && series[index].value === current; index -= 1) {
    age += 1
  }
  return age
}

/** Rolling state whose weekly/monthly observations advance once per native period. */
export class NativePeriodFeatureSampler {
  private readonly maSeries: Array<Array<PeriodSample<number>>> = [[], [], [], [], []]
  private readonly divergenceA: Array<PeriodSample<number>> = []
  private readonly divergenceB: Array<PeriodSample<number>> = []
  private readonly stageA: Array<PeriodSample<number | null>> = []
  private readonly stageB: Array<PeriodSample<number | null>> = []
  private sampleIndex = -1
  private dailyStageARun: { stage: number | null; startIndex: number } = { stage: null, startIndex: 0 }
  private dailyStageBRun: { stage: number | null; startIndex: number } = { stage: null, startIndex: 0 }

  constructor(
    private readonly timescale: FeatureSamplingTimescale,
    private readonly quadraticWindow: number,
    private readonly divergenceLookback: number,
  ) {}

  sample(input: Readonly<{
    date: string
    mas: readonly (number | null)[]
    stageA: number | null
    stageB: number | null
  }>): NativePeriodFeatureSample | null {
    this.sampleIndex += 1
    const period = periodKey(input.date, this.timescale)
    for (let index = 0; index < this.maSeries.length; index += 1) {
      const value = input.mas[index]
      if (value != null) upsertPeriodSample(this.maSeries[index], period, value)
    }
    if (input.mas.some((value) => value == null)) return null

    const [m1, m2, m3, m4, m5] = input.mas as readonly number[]
    const divergenceA = F.divergenceRate(m1, m2, m3)
    const divergenceB = F.divergenceRate(m3, m4, m5)
    upsertPeriodSample(this.divergenceA, period, divergenceA)
    upsertPeriodSample(this.divergenceB, period, divergenceB)
    upsertPeriodSample(this.stageA, period, input.stageA)
    upsertPeriodSample(this.stageB, period, input.stageB)

    if (this.timescale === 'daily') {
      if (input.stageA !== this.dailyStageARun.stage) {
        this.dailyStageARun = { stage: input.stageA, startIndex: this.sampleIndex }
      }
      if (input.stageB !== this.dailyStageBRun.stage) {
        this.dailyStageBRun = { stage: input.stageB, startIndex: this.sampleIndex }
      }
    }

    const divergenceAIndex = this.divergenceA.length - 1
    const divergenceBIndex = this.divergenceB.length - 1
    const previousA = this.divergenceA[divergenceAIndex - 5]?.value
    const previousB = this.divergenceB[divergenceBIndex - 5]?.value
    const historyStart = Math.max(0, divergenceAIndex - this.divergenceLookback)
    const divergenceHistory = this.divergenceA
      .slice(historyStart, divergenceAIndex)
      .map((sample) => sample.value)

    return {
      divergenceA,
      divergenceB,
      divergenceADelta: previousA == null ? 0 : divergenceA - previousA,
      divergenceBDelta: previousB == null ? 0 : divergenceB - previousB,
      divergencePercentile: divergenceHistory.length > 0
        ? F.historicalPercentile(divergenceA, divergenceHistory)
        : 0.5,
      stageAAge: this.timescale === 'daily'
        ? input.stageA == null ? null : this.sampleIndex - this.dailyStageARun.startIndex
        : stageAge(this.stageA),
      stageBAge: this.timescale === 'daily'
        ? input.stageB == null ? null : this.sampleIndex - this.dailyStageBRun.startIndex
        : stageAge(this.stageB),
      trends: this.maSeries.map((series) => (
        F.quadraticTrend(series.map((sample) => sample.value), this.quadraticWindow)
      )),
    }
  }
}
