import type { EventSimilarityVector } from '@/lib/research/six-stage-event-analysis'
import type { DailyExcursionPoint } from '@/lib/research/six-stage-event-path-research'

export const FIXTURE_SEQUENCE_KEYS = [
  '211111>111111',
  '111111>211111',
  '312211>211111',
  '111111>211111>111111',
  '312211>211111>111111',
  '111122>211122>111111',
] as const

export type FixtureMarket = 'JP' | 'US'
export type FixtureHorizon = 5 | 10 | 15 | 20

export type FixtureEvent = {
  market: FixtureMarket
  vector: EventSimilarityVector
  closeReturns: Record<FixtureHorizon, number>
  dailyExcursions: DailyExcursionPoint[]
}

export type FixtureCurrentCandidate = {
  market: FixtureMarket
  companyName: string
  vector: EventSimilarityVector
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits))
}

function dateFor(index: number, marketOffset: number): string {
  const date = new Date(Date.UTC(2011 + ((index + marketOffset) % 12), (index * 7 + marketOffset) % 12, 1 + ((index * 11) % 24)))
  return date.toISOString().slice(0, 10)
}

function createVector(input: {
  market: FixtureMarket
  index: number
  sequenceKey: string
  ticker: string
  current?: boolean
}): EventSimilarityVector {
  const { index } = input
  const wave = Math.sin(index * 0.37 + (input.market === 'US' ? 0.6 : 0))
  const slow = Math.cos(index * 0.13)
  const trend = ((index % 17) - 8) / 8
  const currentShift = input.current ? 0.06 : 0
  return {
    eventId: `${input.current ? 'current' : 'event'}-${input.market}-${index}`,
    ticker: input.ticker,
    signalDate: input.current ? '2026-10-23' : dateFor(index, input.market === 'US' ? 3 : 0),
    sequenceKey: input.sequenceKey,
    cAge: 1 + (index % 8),
    sma: {
      sma5CloseGap: round(wave * 0.018 + currentShift),
      sma25CloseGap: round(wave * 0.045 + slow * 0.012 + currentShift),
      sma75CloseGap: round(slow * 0.06 + trend * 0.01),
      sma150CloseGap: round(slow * 0.075 - wave * 0.01),
      sma200CloseGap: round(trend * 0.08 + slow * 0.02),
      sma300CloseGap: index % 19 === 0 ? null : round(trend * 0.11),
      sma5Angle: round(wave * 32 + trend * 6),
      sma25Angle: round(wave * 25 + slow * 8),
      sma75Angle: round(slow * 21 + trend * 4),
      sma150Angle: round(slow * 15),
      sma200Angle: round(trend * 18),
      sma300Angle: index % 19 === 0 ? null : round(trend * 13),
      sma5Curvature: round(Math.cos(index * 0.41) * 0.9),
      sma25Curvature: round(Math.sin(index * 0.21) * 0.65),
      sma75Curvature: round(Math.cos(index * 0.17) * 0.42),
      sma150Curvature: round(Math.sin(index * 0.12) * 0.3),
      sma200Curvature: round(Math.cos(index * 0.09) * 0.24),
      sma300Curvature: index % 19 === 0 ? null : round(Math.sin(index * 0.07) * 0.18),
      sma25To75Distance: round((wave - slow) * 0.035),
      sma75To150Distance: round((slow - trend) * 0.028),
      sma150To200Distance: round((slow + wave) * 0.021),
      sma200To300Distance: index % 19 === 0 ? null : round((trend - slow) * 0.018),
      sma25To75Convergence: round(Math.sin(index * 0.18) * 0.013),
      sma75To150Convergence: round(Math.cos(index * 0.14) * 0.011),
      sma150To200Convergence: round(Math.sin(index * 0.1) * 0.009),
      sma200To300Convergence: index % 19 === 0 ? null : round(Math.cos(index * 0.08) * 0.007),
    },
    physical: {
      velocity: round(wave * 1.4 + trend * 0.3),
      acceleration: round(Math.cos(index * 0.29) * 0.8),
      momentum: round(wave * 0.9 + slow * 0.5),
      force: round((wave + trend) * 0.7),
      // Synthetic z-composites use the same centered scale as the production
      // PMS/PFS/PES definition. They are fixture values, not market scores.
      pms: round(wave * 1.1 + slow * 0.35 + trend * 0.2),
      pfs: index % 23 === 0 ? null : round(slow * 0.9 + wave * 0.25),
      pes: round(trend * 0.85 + wave * 0.3),
    },
  }
}

function createExcursions(index: number, quality: number): DailyExcursionPoint[] {
  let closeReturn = 0
  return Array.from({ length: 20 }, (_, offset) => {
    const day = offset + 1
    const shock = Math.sin(index * 0.53 + day * 0.71) * 0.011 + Math.cos(index * 0.17 + day * 0.31) * 0.006
    closeReturn += quality * 0.0022 + shock
    const range = 0.009 + Math.abs(Math.sin(index + day)) * 0.012
    const upReturn = Math.max(closeReturn + range, closeReturn - range)
    const downReturn = Math.min(closeReturn + range, closeReturn - range)
    return { day, upReturn: round(upReturn), downReturn: round(downReturn) }
  })
}

function closeAt(excursions: readonly DailyExcursionPoint[], horizon: FixtureHorizon): number {
  const point = excursions[horizon - 1]
  return round((point.upReturn + point.downReturn) / 2)
}

export function buildSixStageEventLabFixture(): {
  events: FixtureEvent[]
  currentCandidates: FixtureCurrentCandidate[]
} {
  const events: FixtureEvent[] = []
  for (const market of ['JP', 'US'] as const) {
    for (let index = 0; index < 240; index += 1) {
      const sequenceKey = FIXTURE_SEQUENCE_KEYS[index % FIXTURE_SEQUENCE_KEYS.length]
      const ticker = market === 'JP' ? String(1300 + (index % 160)) : `US${String(index % 190).padStart(3, '0')}`
      const vector = createVector({ market, index, sequenceKey, ticker })
      const gap = vector.sma.sma25CloseGap ?? 0
      const angle = vector.sma.sma25Angle ?? 0
      const momentum = vector.physical.momentum ?? 0
      const quality = Math.max(-2, Math.min(2, gap * 9 + angle / 45 + momentum / 3))
      const dailyExcursions = createExcursions(index, quality)
      events.push({
        market,
        vector,
        dailyExcursions,
        closeReturns: {
          5: closeAt(dailyExcursions, 5),
          10: closeAt(dailyExcursions, 10),
          15: closeAt(dailyExcursions, 15),
          20: closeAt(dailyExcursions, 20),
        },
      })
    }
  }

  const currentCandidates: FixtureCurrentCandidate[] = []
  for (const market of ['JP', 'US'] as const) {
    for (let index = 0; index < 18; index += 1) {
      const sequenceKey = FIXTURE_SEQUENCE_KEYS[(index * 2 + (market === 'US' ? 1 : 0)) % FIXTURE_SEQUENCE_KEYS.length]
      const ticker = market === 'JP' ? String(7000 + index) : `NOW${String(index + 1).padStart(2, '0')}`
      currentCandidates.push({
        market,
        companyName: market === 'JP' ? `合成日本株 ${index + 1}` : `Synthetic US ${index + 1}`,
        vector: createVector({ market, index: 300 + index, sequenceKey, ticker, current: true }),
      })
    }
  }
  return { events, currentCandidates }
}
