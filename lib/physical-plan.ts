import type { PhysicsStatus } from '@/lib/ml/physics-analysis'

export type PhysicalPlanDirection = 'up' | 'down' | 'mixed' | 'wait'
export type PhysicalPlanStatisticsQuality = 'supportive' | 'contrary' | 'weak' | 'unavailable'

export type PhysicalPlanStructureMetrics = {
  sma5Velocity5: number | null
  sma25Velocity5: number | null
  sma75Velocity10: number | null
  sma200Velocity10: number | null
  sma5Acceleration5: number | null
  priceToSma25: number | null
}

export type PhysicalPlanDecisionInput = {
  horizonDays: number
  status: PhysicsStatus
  metrics: PhysicalPlanStructureMetrics
  pms: number | null
  pfs: number | null
  calibration: {
    targetDirection: 'up' | 'down' | 'wait'
    hitRate: number | null
    baseRate: number | null
    lift: number | null
    confidenceScore: number | null
  } | null
  candidates: Array<{
    direction: 'up' | 'down' | 'wait'
    rank: number
  }>
}

export type PhysicalPlanDecision = {
  direction: PhysicalPlanDirection
  structureDirection: PhysicalPlanDirection
  momentumDirection: PhysicalPlanDirection
  candidateDirection: PhysicalPlanDirection
  calibrationDirection: PhysicalPlanDirection
  statisticsQuality: PhysicalPlanStatisticsQuality
  caution: boolean
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function opposite(a: PhysicalPlanDirection, b: PhysicalPlanDirection): boolean {
  return (a === 'up' && b === 'down') || (a === 'down' && b === 'up')
}

function statusDirection(status: PhysicsStatus): PhysicalPlanDirection {
  if (['上昇加速', '上昇継続', '押し目形成', '反発準備'].includes(status)) return 'up'
  if (['失速警戒', '下落加速'].includes(status)) return 'down'
  return 'wait'
}

export function physicalPlanStructureDirection(
  horizonDays: number,
  metrics: PhysicalPlanStructureMetrics,
): PhysicalPlanDirection {
  if (horizonDays <= 5) {
    const velocity = metrics.sma5Velocity5
    const acceleration = metrics.sma5Acceleration5
    if (!finite(velocity)) return 'wait'
    if (velocity > 0.3 && finite(acceleration) && acceleration <= -0.35) return 'mixed'
    if (velocity >= 0.3) return 'up'
    if (velocity <= -0.3) return 'down'
    return 'wait'
  }

  if (horizonDays <= 20) {
    const velocity = metrics.sma25Velocity5
    if (!finite(velocity)) return 'wait'
    if (velocity >= 0.3 && (!finite(metrics.priceToSma25) || metrics.priceToSma25 >= -1.5)) return 'up'
    if (velocity <= -0.3 || (finite(metrics.priceToSma25) && metrics.priceToSma25 <= -2)) return 'down'
    return 'wait'
  }

  if (horizonDays <= 60) {
    const velocity = metrics.sma75Velocity10
    if (!finite(velocity)) return 'wait'
    if (velocity >= 0.25) return 'up'
    if (velocity <= -0.25) return 'down'
    return 'wait'
  }

  const velocity = metrics.sma200Velocity10
  if (!finite(velocity)) return 'wait'
  if (velocity >= 0.15) return 'up'
  if (velocity <= -0.15) return 'down'
  return 'wait'
}

export function physicalPlanMomentumDirection(
  pms: number | null,
  pfs: number | null,
): PhysicalPlanDirection {
  const pmsDirection = finite(pms) && pms >= 0.5
    ? 'up'
    : finite(pms) && pms <= -0.5
      ? 'down'
      : 'wait'
  const pfsDirection = finite(pfs) && pfs >= 0.35
    ? 'up'
    : finite(pfs) && pfs <= -0.35
      ? 'down'
      : 'wait'
  if (opposite(pmsDirection, pfsDirection)) return 'mixed'
  return pfsDirection !== 'wait' ? pfsDirection : pmsDirection
}

function candidateDirection(
  candidates: PhysicalPlanDecisionInput['candidates'],
): PhysicalPlanDirection {
  const best = [...candidates].sort((a, b) => a.rank - b.rank)[0]
  return best?.direction ?? 'wait'
}

function calibrationAssessment(
  calibration: PhysicalPlanDecisionInput['calibration'],
  direction: PhysicalPlanDirection,
): {
  direction: PhysicalPlanDirection
  quality: PhysicalPlanStatisticsQuality
} {
  if (!calibration) return { direction: 'wait', quality: 'unavailable' }
  const { targetDirection, hitRate, baseRate, lift, confidenceScore } = calibration
  const usable =
    targetDirection !== 'wait' &&
    finite(hitRate) &&
    finite(baseRate) &&
    hitRate > baseRate &&
    finite(lift) &&
    lift >= 1.05 &&
    finite(confidenceScore) &&
    confidenceScore >= 42
  if (!usable) {
    return {
      direction: targetDirection,
      quality: 'weak',
    }
  }
  return {
    direction: targetDirection,
    quality: direction === targetDirection ? 'supportive' : 'contrary',
  }
}

export function resolvePhysicalPlanDecision(
  input: PhysicalPlanDecisionInput,
): PhysicalPlanDecision {
  const structure = physicalPlanStructureDirection(input.horizonDays, input.metrics)
  const momentum = physicalPlanMomentumDirection(input.pms, input.pfs)
  const candidate = candidateDirection(input.candidates)
  let direction: PhysicalPlanDirection = structure

  if (structure === 'mixed') {
    direction = 'mixed'
  } else if (structure === 'up' || structure === 'down') {
    if (
      momentum === 'mixed' ||
      candidate === 'mixed' ||
      opposite(structure, momentum) ||
      opposite(structure, candidate)
    ) {
      direction = 'mixed'
    }
  } else {
    const fallbackDirections = [momentum, candidate]
      .filter((value): value is 'up' | 'down' => value === 'up' || value === 'down')
    if (fallbackDirections.includes('up') && fallbackDirections.includes('down')) {
      direction = 'mixed'
    } else {
      direction = fallbackDirections[0] ?? statusDirection(input.status)
    }
  }

  const calibration = calibrationAssessment(input.calibration, direction)
  const shortStatusConflict =
    input.horizonDays <= 5 &&
    opposite(direction, statusDirection(input.status))
  const caution =
    direction === 'mixed' ||
    calibration.quality === 'contrary' ||
    calibration.quality === 'weak' ||
    shortStatusConflict

  return {
    direction,
    structureDirection: structure,
    momentumDirection: momentum,
    candidateDirection: candidate,
    calibrationDirection: calibration.direction,
    statisticsQuality: calibration.quality,
    caution,
  }
}

export function physicalPlanDirectionLabel(direction: PhysicalPlanDirection): string {
  if (direction === 'up') return '上向き'
  if (direction === 'down') return '下向き'
  if (direction === 'mixed') return '競合'
  return '判定待ち'
}

export function physicalPlanStatisticsLabel(quality: PhysicalPlanStatisticsQuality): string {
  if (quality === 'supportive') return '統計も同方向'
  if (quality === 'contrary') return '統計は別方向'
  if (quality === 'weak') return '統計の裏付けは弱い'
  return '統計未検証'
}
