// Backward-compatible exports for the original 25M-only API surface.
import {
  MONTHLY_MA_MONITOR_CONFIG,
  buildMonthlyMaMonitorSeries,
  type BuildMonthlyMaSeriesOptions,
  type MonthlyMaMonitorPoint,
  type MonthlyMaTargetObservation,
} from './monthly-ma-monitor'

export {
  MONTHLY_MA_MONITOR_CONFIG as MA25M_MONITOR_CONFIG,
  parseBoundedMonitorNumber,
} from './monthly-ma-monitor'

export type {
  BuildMonthlyMaSeriesOptions as BuildMa25mSeriesOptions,
  MonthlyMaApproachDirection as Ma25mApproachDirection,
  MonthlyMaCrossDirection as Ma25mCrossDirection,
  MonthlyMaEventState as Ma25mEventState,
  MonthlyMaMonitorConfig as Ma25mMonitorConfig,
  MonthlyMaPositionSide as Ma25mPositionSide,
  MonthlyMaPrimaryStatus as Ma25mPrimaryStatus,
} from './monthly-ma-monitor'

export interface Ma25mObservation extends Omit<MonthlyMaTargetObservation, 'targetValue' | 'targetLow' | 'targetHigh'> {
  ma25m: number
}

export type Ma25mMonitorPoint = Omit<MonthlyMaMonitorPoint, 'targetValue'> & { ma25m: number }

export function buildMa25mMonitorSeries(
  source: Ma25mObservation[],
  options: BuildMonthlyMaSeriesOptions = {},
): Ma25mMonitorPoint[] {
  return buildMonthlyMaMonitorSeries(
    source.map(({ ma25m, ...row }) => ({ ...row, targetValue: ma25m })),
    { ...options, config: options.config ?? MONTHLY_MA_MONITOR_CONFIG },
  ).map(({ targetValue, ...point }) => ({ ...point, ma25m: targetValue }))
}
