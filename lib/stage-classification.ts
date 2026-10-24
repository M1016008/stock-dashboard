export const STAGE_COMPARISON_RELATIVE_EPSILON = 1e-10

/** Canonical six-stage classifier shared by snapshots, charts, and ML. */
export function calculateStageFromThreeMa(
  ma1: number | null,
  ma2: number | null,
  ma3: number | null,
): number | null {
  if (ma1 === null || ma2 === null || ma3 === null) return null

  const greaterThan = (left: number, right: number): boolean => {
    const tolerance = STAGE_COMPARISON_RELATIVE_EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
    return left - right > tolerance
  }

  if (greaterThan(ma1, ma2) && greaterThan(ma2, ma3)) return 1
  if (greaterThan(ma2, ma1) && greaterThan(ma1, ma3)) return 2
  if (greaterThan(ma2, ma3) && greaterThan(ma3, ma1)) return 3
  if (greaterThan(ma3, ma2) && greaterThan(ma2, ma1)) return 4
  if (greaterThan(ma3, ma1) && greaterThan(ma1, ma2)) return 5
  if (greaterThan(ma1, ma3) && greaterThan(ma3, ma2)) return 6
  return null
}
