export const ML_PRIMARY_HORIZONS = [5, 10, 20, 40, 60, 90, 200] as const

export type MlPrimaryHorizon = typeof ML_PRIMARY_HORIZONS[number]

export const ML_PRIMARY_HORIZON_LIST = ML_PRIMARY_HORIZONS.join(',')

export function isMlPrimaryHorizon(value: number): value is MlPrimaryHorizon {
  return ML_PRIMARY_HORIZONS.includes(value as MlPrimaryHorizon)
}
