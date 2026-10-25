import {
  CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
  CURRENT_SERVING_SMA_PERIODS,
  assertCurrentServingProjectionPayload,
  type CurrentServingProjectionPayload,
  type CurrentServingProjectionRow,
  type CurrentServingSmaPeriod,
} from '@/lib/research/six-stage-current-serving-projection'
import { buildSixStageEventLabFixture } from '@/lib/research/six-stage-event-lab-fixture'

const AS_OF = '2026-10-23'
const GENERATIONS = { JP: 'fixture-jp-serving-20261023-v1', US: 'fixture-us-serving-20261023-v1' } as const

function rounded(value: number): number {
  return Number(value.toFixed(8))
}

function nullable(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function smaFeature(input: {
  period: CurrentServingSmaPeriod
  close: number
  closeGap: number | null
  angle: number | null
  curvature: number | null
}) {
  const value = input.closeGap === null || input.closeGap <= -0.99
    ? null
    : rounded(input.close / (1 + input.closeGap))
  const slope = input.angle === null ? null : rounded(Math.tan(input.angle * Math.PI / 180))
  const position = input.closeGap === null ? null : Math.abs(input.closeGap) < 0.001 ? 'TOUCH' : input.closeGap > 0 ? 'ABOVE' : 'BELOW'
  return {
    value,
    closeGap: input.closeGap,
    slope,
    normalizedAngle: input.angle,
    curvature: input.curvature,
    position,
    available: {
      value: value !== null,
      closeGap: input.closeGap !== null,
      slope: slope !== null,
      normalizedAngle: input.angle !== null,
      curvature: input.curvature !== null,
      position: position !== null,
    },
  } as const
}

function rowFor(candidate: ReturnType<typeof buildSixStageEventLabFixture>['currentCandidates'][number]): CurrentServingProjectionRow {
  const vector = candidate.vector
  const states = vector.sequenceKey.split('>')
  const current = states.at(-1)!
  const close = 80 + [...candidate.vector.ticker].reduce((sum, value) => sum + value.charCodeAt(0), 0) % 170
  const sma = Object.fromEntries(CURRENT_SERVING_SMA_PERIODS.map((period) => [period, smaFeature({
    period,
    close,
    closeGap: nullable(vector.sma[`sma${period}CloseGap`]),
    angle: nullable(vector.sma[`sma${period}Angle`]),
    curvature: nullable(vector.sma[`sma${period}Curvature`]),
  })])) as CurrentServingProjectionRow['sma']
  const raw = {
    velocity: nullable(vector.physical.velocity),
    acceleration: nullable(vector.physical.acceleration),
    momentum: nullable(vector.physical.momentum),
    force: nullable(vector.physical.force),
    energy: nullable(vector.physical.energy),
  }
  return {
    market: candidate.market,
    ticker: vector.ticker,
    companyName: candidate.companyName,
    asOfTradingDate: AS_OF,
    sourceGeneration: GENERATIONS[candidate.market],
    definitionVersion: CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
    stage: {
      current,
      sequence2: states.length >= 2 ? states.slice(-2).join('>') : null,
      sequence3: states.length >= 3 ? states.slice(-3).join('>') : null,
      cAge: vector.cAge,
    },
    close,
    sma,
    smaShape: {
      order: CURRENT_SERVING_SMA_PERIODS.filter((period) => sma[period].value !== null)
        .sort((left, right) => (sma[right].value ?? -Infinity) - (sma[left].value ?? -Infinity)),
      pairDistance: {
        sma25To75: nullable(vector.sma.sma25To75Distance),
        sma75To150: nullable(vector.sma.sma75To150Distance),
        sma150To200: nullable(vector.sma.sma150To200Distance),
        sma200To300: nullable(vector.sma.sma200To300Distance),
      },
      convergence: {
        sma25To75: nullable(vector.sma.sma25To75Convergence),
        sma75To150: nullable(vector.sma.sma75To150Convergence),
        sma150To200: nullable(vector.sma.sma150To200Convergence),
        sma200To300: nullable(vector.sma.sma200To300Convergence),
      },
    },
    physical: {
      raw,
      official: { pms: null, pfs: null, pes: null },
      available: {
        velocity: raw.velocity !== null,
        acceleration: raw.acceleration !== null,
        momentum: raw.momentum !== null,
        force: raw.force !== null,
        energy: raw.energy !== null,
        pms: false,
        pfs: false,
        pes: false,
      },
    },
  }
}

export function buildFixtureCurrentServingProjection(): CurrentServingProjectionPayload {
  const rows = buildSixStageEventLabFixture().currentCandidates.map(rowFor)
  const payload: CurrentServingProjectionPayload = {
    kind: 'stockboard-six-stage-current-serving-projection',
    status: 'COMPLETE',
    generationId: 'fixture-current-serving-20261023-v1',
    generatedAt: '2026-10-24T00:00:00.000Z',
    definitionVersion: CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
    source: 'SYNTHETIC_SERVING_UPDATE_CHAIN_FIXTURE',
    marketWatermarks: {
      JP: {
        asOfTradingDate: AS_OF,
        sourceGeneration: GENERATIONS.JP,
        priceBasis: 'FIXTURE_JP_PREFIX_ONLY',
        featureSet: 'ma_physics_v4',
        rows: rows.filter((row) => row.market === 'JP').length,
        coverage: {
          snapshotRows: rows.filter((row) => row.market === 'JP').length,
          eligibleRows: rows.filter((row) => row.market === 'JP').length,
          universeRows: rows.filter((row) => row.market === 'JP').length,
          universeIdentityRows: rows.filter((row) => row.market === 'JP').length,
          closeRows: rows.filter((row) => row.market === 'JP').length,
          mlRows: rows.filter((row) => row.market === 'JP').length,
          smaRows: rows.filter((row) => row.market === 'JP').length,
          physicalRows: rows.filter((row) => row.market === 'JP').length,
        },
      },
      US: {
        asOfTradingDate: AS_OF,
        sourceGeneration: GENERATIONS.US,
        priceBasis: 'FIXTURE_US_ADJUSTED_PREFIX_ONLY',
        featureSet: 'ma_physics_v4',
        rows: rows.filter((row) => row.market === 'US').length,
        coverage: {
          snapshotRows: rows.filter((row) => row.market === 'US').length,
          eligibleRows: rows.filter((row) => row.market === 'US').length,
          universeRows: rows.filter((row) => row.market === 'US').length,
          universeIdentityRows: rows.filter((row) => row.market === 'US').length,
          closeRows: rows.filter((row) => row.market === 'US').length,
          mlRows: rows.filter((row) => row.market === 'US').length,
          smaRows: rows.filter((row) => row.market === 'US').length,
          physicalRows: rows.filter((row) => row.market === 'US').length,
        },
      },
    },
    rows,
  }
  assertCurrentServingProjectionPayload(payload)
  return payload
}
