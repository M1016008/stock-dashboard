export const HORIZONS = [5, 20, 30, 40, 60, 90, 180] as const
export const TARGET_PCTS = [10, 20, 40] as const

export type HorizonDays = typeof HORIZONS[number]
export type Timescale = 'daily' | 'weekly'
export type SignalStrength = 'strong' | 'setup' | 'watch' | 'risk'
export type SignalDirection = 'bullish' | 'bearish' | 'neutral'

export type SignalRecord = {
  ticker: string
  date: string
  timescale: Timescale | 'composite'
  maPeriod: number
  signalCode: string
  signalStrength: SignalStrength
  direction: SignalDirection
  label: string
  scoreComponent: number
  valueJson?: string
}

export type MaSignalInput = {
  ticker: string
  date: string
  timescale: Timescale
  maPeriod: number
  prevClose: number | null
  prevMa: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  ma: number | null
}

export type CompositeSignalInput = {
  ticker: string
  date: string
  close: number | null
  high: number | null
  low: number | null
  volume: number | null
  avgVolume20: number | null
  rangePct: number | null
  avgRange20Pct: number | null
  atr20Pct: number | null
  ma5PosPct: number | null
  ma25PosPct: number | null
  ma75PosPct: number | null
  maSpreadPct: number | null
  high60: number | null
  prevHigh60: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  prevDailyAStage: number | null
  prevDailyBStage: number | null
  dailySignalCodes: string[]
  weeklySignalCodes: string[]
}

export const SIGNAL_LABELS: Record<string, string> = {
  ma_touch: 'MA接触',
  ma_cross_up: 'MA上抜け',
  ma_upper_touch: 'MA上タッチ',
  ma_cross_down: 'MA下割れ',
  ma_lower_touch: 'MA下タッチ',
  pullback_candidate: '押し目候補',
  pre_breakout: 'ブレイク直前',
  volatility_squeeze: 'ボラ収縮',
  stage_improvement_setup: 'ステージ好転予兆',
  higher_timeframe_alignment: '上位足一致',
  high_breakout_continuation: '高値更新後の継続力',
}

function hasNumber(...values: Array<number | null | undefined>): boolean {
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value)
}

export function patternCode(input: {
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
}): string | null {
  const values = [
    input.dailyAStage,
    input.dailyBStage,
    input.weeklyAStage,
    input.weeklyBStage,
    input.monthlyAStage,
    input.monthlyBStage,
  ]
  if (!values.every((stage) => typeof stage === 'number' && Number.isInteger(stage) && stage >= 1 && stage <= 6)) return null
  return values.join('')
}

export function evaluateMaSignals(input: MaSignalInput): SignalRecord[] {
  const { ticker, date, timescale, maPeriod, prevClose, prevMa, open, high, low, close, ma } = input
  if (!isFiniteNumber(high) || !isFiniteNumber(low) || !isFiniteNumber(close) || !isFiniteNumber(ma)) return []

  const records: SignalRecord[] = []
  const codeSuffix = `${timescale}_${maPeriod}`
  const valueJson = jsonValue({ open, high, low, close, ma, prevClose, prevMa })
  const touched = low <= ma && high >= ma

  if (touched) {
    records.push({
      ticker,
      date,
      timescale,
      maPeriod,
      signalCode: `ma_touch_${codeSuffix}`,
      signalStrength: 'watch',
      direction: 'neutral',
      label: `${timescale === 'daily' ? '日足' : '週足'}${maPeriod}MA接触`,
      scoreComponent: 0.3,
      valueJson,
    })
  }

  if (isFiniteNumber(prevClose) && isFiniteNumber(prevMa)) {
    const crossedUp = prevClose <= prevMa && close > ma
    const upperTouched = prevClose < prevMa && high >= ma
    const crossedDown = prevClose >= prevMa && close < ma
    const lowerTouched = prevClose > prevMa && low <= ma

    if (crossedUp) {
      records.push({
        ticker,
        date,
        timescale,
        maPeriod,
        signalCode: `ma_cross_up_${codeSuffix}`,
        signalStrength: 'strong',
        direction: 'bullish',
        label: `${timescale === 'daily' ? '日足' : '週足'}${maPeriod}MA上抜け`,
        scoreComponent: 1,
        valueJson,
      })
    } else if (upperTouched) {
      records.push({
        ticker,
        date,
        timescale,
        maPeriod,
        signalCode: `ma_upper_touch_${codeSuffix}`,
        signalStrength: 'setup',
        direction: 'bullish',
        label: `${timescale === 'daily' ? '日足' : '週足'}${maPeriod}MA上タッチ`,
        scoreComponent: 0.65,
        valueJson,
      })
    }

    if (crossedDown) {
      records.push({
        ticker,
        date,
        timescale,
        maPeriod,
        signalCode: `ma_cross_down_${codeSuffix}`,
        signalStrength: 'strong',
        direction: 'bearish',
        label: `${timescale === 'daily' ? '日足' : '週足'}${maPeriod}MA下割れ`,
        scoreComponent: -1,
        valueJson,
      })
    } else if (lowerTouched) {
      records.push({
        ticker,
        date,
        timescale,
        maPeriod,
        signalCode: `ma_lower_touch_${codeSuffix}`,
        signalStrength: 'setup',
        direction: 'bearish',
        label: `${timescale === 'daily' ? '日足' : '週足'}${maPeriod}MA下タッチ`,
        scoreComponent: -0.65,
        valueJson,
      })
    }
  }

  return records
}

export function deriveCompositeSignals(input: CompositeSignalInput): SignalRecord[] {
  const records: SignalRecord[] = []
  const bullishStages = [1, 2]
  const improvingStages = [1, 2, 5]
  const volumeRatio = isFiniteNumber(input.volume) && isFiniteNumber(input.avgVolume20) && input.avgVolume20 > 0
    ? input.volume / input.avgVolume20
    : null
  const distToHigh60Pct = isFiniteNumber(input.close) && isFiniteNumber(input.high60) && input.high60 > 0
    ? ((input.close - input.high60) / input.high60) * 100
    : null
  const payload = {
    close: input.close,
    volumeRatio,
    rangePct: input.rangePct,
    avgRange20Pct: input.avgRange20Pct,
    atr20Pct: input.atr20Pct,
    ma5PosPct: input.ma5PosPct,
    ma25PosPct: input.ma25PosPct,
    ma75PosPct: input.ma75PosPct,
    maSpreadPct: input.maSpreadPct,
    distToHigh60Pct,
    stages: {
      dailyA: input.dailyAStage,
      dailyB: input.dailyBStage,
      weeklyA: input.weeklyAStage,
      weeklyB: input.weeklyBStage,
      monthlyA: input.monthlyAStage,
      monthlyB: input.monthlyBStage,
    },
  }

  const stageAligned =
    bullishStages.includes(input.weeklyAStage ?? 0) &&
    bullishStages.includes(input.monthlyAStage ?? 0)
  const dailyTouch = input.dailySignalCodes.some((code) =>
    code.includes('ma_touch_daily_5') ||
    code.includes('ma_touch_daily_25') ||
    code.includes('ma_upper_touch_daily_5') ||
    code.includes('ma_upper_touch_daily_25')
  )

  if (
    stageAligned &&
    dailyTouch &&
    ((input.ma25PosPct != null && input.ma25PosPct >= -4 && input.ma25PosPct <= 6) ||
      (input.ma5PosPct != null && input.ma5PosPct >= -3 && input.ma5PosPct <= 4))
  ) {
    records.push(compositeRecord(input, 'pullback_candidate', 'setup', 'bullish', 0.78, payload))
  }

  if (
    distToHigh60Pct != null &&
    distToHigh60Pct >= -3 &&
    distToHigh60Pct <= 1 &&
    (volumeRatio == null || volumeRatio >= 0.8) &&
    bullishStages.includes(input.weeklyAStage ?? 0)
  ) {
    records.push(compositeRecord(input, 'pre_breakout', 'setup', 'bullish', 0.74, payload))
  }

  if (
    ((input.rangePct != null && input.avgRange20Pct != null && input.rangePct <= input.avgRange20Pct * 0.72) ||
      (input.atr20Pct != null && input.atr20Pct <= 4)) &&
    input.maSpreadPct != null &&
    Math.abs(input.maSpreadPct) <= 7
  ) {
    records.push(compositeRecord(input, 'volatility_squeeze', 'watch', 'neutral', 0.62, payload))
  }

  const stageImproved =
    input.prevDailyAStage != null &&
    input.dailyAStage != null &&
    input.dailyAStage < input.prevDailyAStage
  const stageNearTurn =
    improvingStages.includes(input.dailyAStage ?? 0) &&
    (input.ma5PosPct ?? -999) > -2 &&
    (input.ma25PosPct ?? -999) > -6
  if (stageImproved || stageNearTurn) {
    records.push(compositeRecord(input, 'stage_improvement_setup', 'setup', 'bullish', 0.68, payload))
  }

  if (
    bullishStages.includes(input.dailyAStage ?? 0) &&
    bullishStages.includes(input.weeklyAStage ?? 0) &&
    bullishStages.includes(input.monthlyAStage ?? 0) &&
    bullishStages.includes(input.weeklyBStage ?? 0)
  ) {
    records.push(compositeRecord(input, 'higher_timeframe_alignment', 'strong', 'bullish', 0.86, payload))
  }

  if (
    isFiniteNumber(input.high) &&
    isFiniteNumber(input.prevHigh60) &&
    isFiniteNumber(input.close) &&
    input.prevHigh60 > 0 &&
    input.high >= input.prevHigh60 &&
    input.close >= input.prevHigh60 * 0.98 &&
    (volumeRatio == null || volumeRatio >= 1.1)
  ) {
    records.push(compositeRecord(input, 'high_breakout_continuation', 'strong', 'bullish', 0.82, payload))
  }

  return records
}

function compositeRecord(
  input: CompositeSignalInput,
  signalCode: string,
  signalStrength: SignalStrength,
  direction: SignalDirection,
  scoreComponent: number,
  payload: unknown,
): SignalRecord {
  return {
    ticker: input.ticker,
    date: input.date,
    timescale: 'composite',
    maPeriod: 0,
    signalCode,
    signalStrength,
    direction,
    label: SIGNAL_LABELS[signalCode] ?? signalCode,
    scoreComponent,
    valueJson: jsonValue(payload),
  }
}
