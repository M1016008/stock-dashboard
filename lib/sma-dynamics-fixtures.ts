// Synthetic, deterministic price histories for SMA dynamics tests and the dev preview.
// No database, API, or market data is read; dates come from the market calendars only.
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'
import { addCalendarDays, sessionsBetween, smaLabCalendar, type SmaLabRawRow } from '@/lib/sma-dynamics-timeframes'

export interface SmaDynamicsFixture {
  id: string
  label: string
  description: string
  market: SmaDynamicsMarket
  /** Synthetic security identity used by the preview's stock-detail simulation. */
  ticker: string
  name: string
  analysisDate: string | null
  rows: SmaLabRawRow[]
}

interface PathSegment {
  sessions: number
  drift: number
}

/**
 * Ascending session dates ending at `endDate` (inclusive when it is a session).
 * Uses the lab calendar, so documented exchange closures (e.g. 2025-01-09 in the US)
 * never get a synthetic row.
 */
export function fixtureSessionDates(market: SmaDynamicsMarket, endDate: string, count: number): string[] {
  const calendar = smaLabCalendar(market)
  const dates: string[] = []
  let cursor = endDate
  while (dates.length < count) {
    if (calendar.isSession(cursor)) dates.push(cursor)
    cursor = addCalendarDays(cursor, -1)
  }
  return dates.reverse()
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function syntheticCloses(args: { start: number; segments: PathSegment[]; noise: number; seed: number; decimals: number }): number[] {
  const random = mulberry32(args.seed)
  const scale = 10 ** args.decimals
  const closes: number[] = []
  let value = args.start
  for (const segment of args.segments) {
    for (let i = 0; i < segment.sessions; i += 1) {
      value *= 1 + segment.drift + args.noise * (2 * random() - 1)
      closes.push(Math.round(value * scale) / scale)
    }
  }
  return closes
}

/**
 * Adds deterministic open/high/low/volume around each valid close using its own
 * random stream, so the closes (and every Phase 1 SMA) are unchanged.
 */
function withSyntheticOhlc<T extends SmaLabRawRow>(rows: T[], args: { seed: number; decimals: number; spread: number; volume: number }): T[] {
  const random = mulberry32(args.seed ^ 0x5bd1e995)
  const scale = 10 ** args.decimals
  const round = (value: number) => Math.round(value * scale) / scale
  let previous: number | null = null
  return rows.map((row) => {
    const close = row.close
    const r1 = random()
    const r2 = random()
    const r3 = random()
    const r4 = random()
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) return row
    const open = round((previous ?? close) * (1 + args.spread * (r1 - 0.5)))
    const high = Math.max(round(Math.max(open, close) * (1 + args.spread * r2 * 0.6)), open, close)
    const low = Math.min(round(Math.min(open, close) * (1 - args.spread * r3 * 0.6)), open, close)
    previous = close
    return { ...row, open, high, low, volume: Math.round(args.volume * (0.55 + 0.9 * r4)) }
  })
}

function buildRows(market: SmaDynamicsMarket, endDate: string, closes: number[], seed = 1, decimals = market === 'US' ? 2 : 1): SmaLabRawRow[] {
  const dates = fixtureSessionDates(market, endDate, closes.length)
  const offset = closes.length - dates.length
  const rows = dates.map((date, index) => ({ date, close: closes[index + offset] }))
  return withSyntheticOhlc(rows, { seed, decimals, spread: 0.012, volume: market === 'US' ? 2_400_000 : 850_000 })
}

export function buildSmaDynamicsFixtures(): SmaDynamicsFixture[] {
  const jpRising = buildRows('JP', '2026-10-16', syntheticCloses({
    start: 1000, segments: [{ sessions: 520, drift: 0.0012 }], noise: 0.004, seed: 11, decimals: 1,
  }), 11)

  const pitRows: SmaLabRawRow[] = [
    ...buildRows('JP', '2026-06-30', syntheticCloses({
      start: 1800, segments: [{ sessions: 420, drift: 0.0006 }], noise: 0.007, seed: 23, decimals: 1,
    }), 23),
    // Rows after the analysis date carry an obvious jump; they must never affect the result.
    ...fixtureSessionDates('JP', '2026-08-31', 80)
      .filter((date) => date > '2026-06-30')
      .map((date, index) => ({ date, open: 6000 + index * 25, high: 6010 + index * 25, low: 5990 + index * 25, close: 6000 + index * 25, volume: 1 })),
  ]

  const invalidBase = buildRows('JP', '2026-10-16', syntheticCloses({
    start: 3200, segments: [{ sessions: 400, drift: 0.0003 }], noise: 0.006, seed: 37, decimals: 1,
  }), 37)
  const invalidRows: SmaLabRawRow[] = invalidBase.map((row, index) => {
    const fromEnd = invalidBase.length - 1 - index
    if (fromEnd === 30) return { ...row, close: 0 }
    if (fromEnd === 45) return { ...row, close: Number.NaN }
    // High below low: the close stays usable, the candle is flagged incomplete.
    if (fromEnd === 60) return { ...row, high: Number(row.low) - 1 }
    return row
  })
  const duplicateTarget = invalidBase[invalidBase.length - 11]
  invalidRows.push({ date: duplicateTarget.date, close: Number(duplicateTarget.close) + 12 })
  invalidRows.push({ date: '2026-13-01', close: 3300 })

  const anchorInvalid = buildRows('JP', '2026-10-16', syntheticCloses({
    start: 900, segments: [{ sessions: 360, drift: 0.0004 }], noise: 0.006, seed: 41, decimals: 1,
  }), 41)
  anchorInvalid[anchorInvalid.length - 1] = { ...anchorInvalid[anchorInvalid.length - 1], close: null }

  // Listed on a Wednesday mid-month; as-of is a Wednesday, so the week and month are still forming.
  // Two sessions have no row: a mid-week Wednesday and a week-closing Friday.
  const listingDates = sessionsBetween(smaLabCalendar('JP'), '2026-04-15', '2026-10-14')
    .filter((date) => date !== '2026-07-08' && date !== '2026-08-21')
  const listingCloses = syntheticCloses({ start: 2100, segments: [{ sessions: listingDates.length, drift: 0.0009 }], noise: 0.012, seed: 53, decimals: 1 })
  const listingRows = withSyntheticOhlc(
    listingDates.map((date, index) => ({ date, close: listingCloses[index] })),
    { seed: 53, decimals: 1, spread: 0.02, volume: 3_200_000 },
  )

  // Mirrors the production 7003 symptom without copying production prices: one expected
  // TSE session is absent, so strict calendar-window SMAs stay empty until it rolls out.
  const productionGapRows = buildRows('JP', '2026-10-28', syntheticCloses({
    start: 3600, segments: [{ sessions: 180, drift: 0.0002 }], noise: 0.008, seed: 67, decimals: 1,
  }), 67).filter((row) => row.date !== '2026-07-17')

  // 2000-01-04 .. 2026-10-16: enough monthly bars for 1M SMA300, not for 3M SMA300.
  const longDates = sessionsBetween(smaLabCalendar('JP'), '2000-01-04', '2026-10-16')
  const longCloses = syntheticCloses({
    start: 1200,
    segments: [
      { sessions: 2000, drift: 0.0004 },
      { sessions: 1500, drift: -0.0003 },
      { sessions: longDates.length - 3500, drift: 0.0005 },
    ],
    noise: 0.009,
    seed: 61,
    decimals: 1,
  })
  const longRows = withSyntheticOhlc(
    longDates.map((date, index) => ({ date, close: longCloses[index] })),
    { seed: 61, decimals: 1, spread: 0.014, volume: 1_500_000 },
  )

  return [
    {
      id: 'jp-rising',
      label: 'JP 上昇基調',
      description: '緩やかな上昇。基準日 2026-10-16 (金) なので週足は確定、月足・四半期足は未確定。文化の日・勤労感謝の日を含む将来営業日。',
      market: 'JP',
      ticker: 'FXJ1',
      name: '合成 上昇基調',
      analysisDate: null,
      rows: jpRising,
    },
    {
      id: 'us-falling',
      label: 'US 下降基調',
      description: '緩やかな下降。基準日 2026-11-25 (感謝祭前日・水) なので週足は未確定。',
      market: 'US',
      ticker: 'FXU1',
      name: 'Synthetic Downtrend',
      analysisDate: null,
      rows: buildRows('US', '2026-11-25', syntheticCloses({
        start: 240, segments: [{ sessions: 520, drift: -0.0010 }], noise: 0.004, seed: 13, decimals: 2,
      }), 13),
    },
    {
      id: 'jp-sideways',
      label: 'JP 横ばい',
      description: '横ばい。基準日 2026-04-28 (ゴールデンウィーク前)。',
      market: 'JP',
      ticker: 'FXJ2',
      name: '合成 横ばい',
      analysisDate: null,
      rows: buildRows('JP', '2026-04-28', syntheticCloses({
        start: 2500, segments: [{ sessions: 520, drift: 0 }], noise: 0.006, seed: 17, decimals: 1,
      }), 17),
    },
    {
      id: 'us-crossing',
      label: 'US 下降から反転',
      description: '下降の後、基準日の100営業日前から上昇へ転じ、6ヶ月表示内でSMA25がSMA75を上抜ける。基準日 2026-12-23 (年末年始の休場を含む)。',
      market: 'US',
      ticker: 'FXU2',
      name: 'Synthetic Reversal',
      analysisDate: null,
      rows: buildRows('US', '2026-12-23', syntheticCloses({
        start: 180, segments: [{ sessions: 380, drift: -0.0025 }, { sessions: 100, drift: 0.0045 }], noise: 0.003, seed: 19, decimals: 2,
      }), 19),
    },
    {
      id: 'jp-short-history',
      label: 'JP 履歴不足',
      description: '180営業日のみ。SMA200 は 20 本、SMA300 は 120 本不足。',
      market: 'JP',
      ticker: 'FXJ3',
      name: '合成 履歴不足',
      analysisDate: null,
      rows: buildRows('JP', '2026-10-16', syntheticCloses({
        start: 1500, segments: [{ sessions: 180, drift: 0.0008 }], noise: 0.009, seed: 29, decimals: 1,
      }), 29),
    },
    {
      id: 'jp-pit-boundary',
      label: 'JP 過去日分析',
      description: '分析基準日 2026-06-30。以降の行 (急騰) は計算に入らない。',
      market: 'JP',
      ticker: 'FXJ4',
      name: '合成 過去日分析',
      analysisDate: '2026-06-30',
      rows: pitRows,
    },
    {
      id: 'jp-invalid-data',
      label: 'JP 不正データ',
      description: '重複日・終値0・NaN・不正な日付・高値<安値を含む。該当する窓のSMAは算出しない。',
      market: 'JP',
      ticker: 'FXJ5',
      name: '合成 不正データ',
      analysisDate: null,
      rows: invalidRows,
    },
    {
      id: 'jp-anchor-invalid',
      label: 'JP 基準日の終値なし',
      description: '基準日の終値が欠損しているため計算不可。',
      market: 'JP',
      ticker: 'FXJ6',
      name: '合成 基準日終値なし',
      analysisDate: null,
      rows: anchorInvalid,
    },
    {
      id: 'empty',
      label: '履歴なし',
      description: '価格履歴が空。',
      market: 'JP',
      ticker: 'FXJ0',
      name: '合成 履歴なし',
      analysisDate: null,
      rows: [],
    },
    {
      id: 'jp-listing-gap',
      label: 'JP 新規上場・欠損あり',
      description: '2026-04-15 (水) 上場。2026-07-08 (水) と 2026-08-21 (金・週末営業日) の行がない。基準日 2026-10-14 (水) で週足・月足は未確定。',
      market: 'JP',
      ticker: 'FXJ7',
      name: '合成 新規上場',
      analysisDate: null,
      rows: listingRows,
    },
    {
      id: 'jp-7003-gap',
      label: 'JP 7003型・営業日欠損',
      description: '本番7003で検出した日付構造の合成再現。期待営業日 2026-07-17 の行がなく、SMA75は厳格に計算不可となる。',
      market: 'JP',
      ticker: 'FXJ9',
      name: '合成 7003型欠損',
      analysisDate: null,
      rows: productionGapRows,
    },
    {
      id: 'jp-long-history',
      label: 'JP 長期履歴 (2000年〜)',
      description: '2000-01-04 からの日足。1M×SMA300 は計算可能、3M×SMA300 は履歴不足。',
      market: 'JP',
      ticker: 'FXJ8',
      name: '合成 長期履歴',
      analysisDate: null,
      rows: longRows,
    },
  ]
}

export const SMA_DYNAMICS_FIXTURES: readonly SmaDynamicsFixture[] = buildSmaDynamicsFixtures()

export function findSmaDynamicsFixture(id: string): SmaDynamicsFixture | null {
  return SMA_DYNAMICS_FIXTURES.find((fixture) => fixture.id === id) ?? null
}
