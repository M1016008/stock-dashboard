import type {
  DrillAnswer,
  DrillCandle,
  DrillDifficulty,
  DrillMetricSnapshot,
  DrillOutcome,
  DrillStageSnapshot,
} from './types'

export interface OutcomeInput {
  base: DrillCandle
  future: DrillCandle[]
  thresholdPct: number
}

export function movingAverage(values: Array<number | null>, period: number): Array<number | null> {
  const out: Array<number | null> = []
  let sum = 0
  const queue: number[] = []
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) {
      out.push(null)
      continue
    }
    queue.push(value)
    sum += value
    if (queue.length > period) sum -= queue.shift() ?? 0
    out.push(queue.length === period ? sum / period : null)
  }
  return out
}

export function enrichCandlesWithMa(rows: Array<Omit<DrillCandle, 'ma5' | 'ma25' | 'ma75' | 'ma200'>>): DrillCandle[] {
  const closes = rows.map((row) => row.close)
  const ma5 = movingAverage(closes, 5)
  const ma25 = movingAverage(closes, 25)
  const ma75 = movingAverage(closes, 75)
  const ma200 = movingAverage(closes, 200)
  return rows.map((row, index) => ({
    ...row,
    ma5: ma5[index],
    ma25: ma25[index],
    ma75: ma75[index],
    ma200: ma200[index],
  }))
}

export function slopePct(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null
  return 100 * (current - previous) / previous
}

export function deviationPct(price: number | null | undefined, ma: number | null | undefined): number | null {
  if (price == null || ma == null || !Number.isFinite(price) || !Number.isFinite(ma) || ma === 0) return null
  return 100 * (price - ma) / ma
}

export function computeOutcome({ base, future, thresholdPct }: OutcomeInput): DrillOutcome {
  const baseClose = base.close
  let maxUpPct = -Infinity
  let maxDownPct = Infinity
  let maxUpDate: string | null = null
  let maxDownDate: string | null = null
  let maxUpDay: number | null = null
  let maxDownDay: number | null = null
  let upHitDay: number | null = null
  let downHitDay: number | null = null
  let upHitDate: string | null = null
  let downHitDate: string | null = null
  let upCloseHitDay: number | null = null
  let downCloseHitDay: number | null = null
  let upCloseHitDate: string | null = null
  let downCloseHitDate: string | null = null

  future.forEach((row, index) => {
    const day = index + 1
    const up = 100 * (row.high - baseClose) / baseClose
    const down = 100 * (row.low - baseClose) / baseClose
    const closeReturn = 100 * (row.close - baseClose) / baseClose
    if (up > maxUpPct) {
      maxUpPct = up
      maxUpDate = row.date
      maxUpDay = day
    }
    if (down < maxDownPct) {
      maxDownPct = down
      maxDownDate = row.date
      maxDownDay = day
    }
    if (upHitDay == null && up >= thresholdPct) {
      upHitDay = day
      upHitDate = row.date
    }
    if (downHitDay == null && down <= -thresholdPct) {
      downHitDay = day
      downHitDate = row.date
    }
    if (upCloseHitDay == null && closeReturn >= thresholdPct) {
      upCloseHitDay = day
      upCloseHitDate = row.date
    }
    if (downCloseHitDay == null && closeReturn <= -thresholdPct) {
      downCloseHitDay = day
      downCloseHitDate = row.date
    }
  })

  const upHit = upHitDay != null
  const downHit = downHitDay != null
  const thresholdHitDirection =
    upHit && downHit ? 'both'
    : upHit ? 'up'
    : downHit ? 'down'
    : 'none'
  const highVolatility = upHit && downHit
  const actual: DrillAnswer =
    upHit && (!downHit || (upHitDay ?? Infinity) <= (downHitDay ?? Infinity)) ? 'up'
    : downHit ? 'down'
    : 'pass'
  const closeHit =
    actual === 'up' ? upCloseHitDay != null
    : actual === 'down' ? downCloseHitDay != null
    : false
  const closeHitDay = actual === 'up' ? upCloseHitDay : actual === 'down' ? downCloseHitDay : null
  const closeHitDate = actual === 'up' ? upCloseHitDate : actual === 'down' ? downCloseHitDate : null
  const thresholdHitDay =
    thresholdHitDirection === 'up' ? upHitDay
    : thresholdHitDirection === 'down' ? downHitDay
    : thresholdHitDirection === 'both' ? Math.min(upHitDay ?? Infinity, downHitDay ?? Infinity)
    : null
  const thresholdHitDate =
    thresholdHitDirection === 'up' ? upHitDate
    : thresholdHitDirection === 'down' ? downHitDate
    : thresholdHitDirection === 'both'
      ? ((upHitDay ?? Infinity) <= (downHitDay ?? Infinity) ? upHitDate : downHitDate)
    : null
  const end = future.at(-1)
  const endReturnPct = end ? 100 * (end.close - baseClose) / baseClose : null

  return {
    actual,
    resultLabel: actual === 'up' ? '上昇' : actual === 'down' ? '下落' : '見送り',
    highVolatility,
    maxUpPct: Number.isFinite(maxUpPct) ? maxUpPct : 0,
    maxDownPct: Number.isFinite(maxDownPct) ? maxDownPct : 0,
    maxUpDate,
    maxDownDate,
    maxUpDay,
    maxDownDay,
    thresholdHit: upHit || downHit,
    thresholdHitDirection,
    thresholdHitDay: Number.isFinite(thresholdHitDay) ? thresholdHitDay : null,
    thresholdHitDate,
    closeHit,
    closeHitDay,
    closeHitDate,
    endReturnPct,
  }
}

export function isCandidateForDifficulty(
  outcome: DrillOutcome,
  intended: DrillAnswer,
  thresholdPct: number,
  difficulty: DrillDifficulty,
): boolean {
  if (difficulty === 'practical') return true
  if (difficulty === 'advanced') {
    if (outcome.highVolatility) return true
    if (intended === 'up') return outcome.maxUpPct >= thresholdPct && outcome.maxDownPct <= -thresholdPct * 0.45
    if (intended === 'down') return outcome.maxDownPct <= -thresholdPct && outcome.maxUpPct >= thresholdPct * 0.45
    return !outcome.thresholdHit
  }
  if (difficulty === 'beginner') {
    if (intended === 'up') return outcome.maxUpPct >= thresholdPct * 1.25 && outcome.maxDownPct > -thresholdPct * 0.55
    if (intended === 'down') return outcome.maxDownPct <= -thresholdPct * 1.25 && outcome.maxUpPct < thresholdPct * 0.55
    return !outcome.thresholdHit && Math.max(outcome.maxUpPct, Math.abs(outcome.maxDownPct)) < thresholdPct * 0.75
  }
  if (intended === 'up') return outcome.maxUpPct >= thresholdPct && outcome.maxDownPct > -thresholdPct * 0.9
  if (intended === 'down') return outcome.maxDownPct <= -thresholdPct && outcome.maxUpPct < thresholdPct * 0.9
  return !outcome.thresholdHit
}

export function answerIsCorrect(answer: DrillAnswer, outcome: DrillOutcome): boolean {
  return answer === outcome.actual
}

export function buildHintSummary(stage: DrillStageSnapshot, metrics: DrillMetricSnapshot): string[] {
  const hints: string[] = []
  if (stage.previousDailyA != null && stage.dailyA != null && stage.previousDailyA !== stage.dailyA) {
    hints.push(`日足Aは ${stage.previousDailyA}→${stage.dailyA} に変化`)
  }
  if ((metrics.ma25SlopePct ?? 0) > 0.1) hints.push('25日線は上向き')
  if ((metrics.ma25SlopePct ?? 0) < -0.1) hints.push('25日線は下向き')
  if ((metrics.priceVsMa25Pct ?? 0) > 2) hints.push('株価は25日線の上で推移')
  if ((metrics.priceVsMa25Pct ?? 0) < -2) hints.push('株価は25日線を下回る')
  if ((metrics.volumeRatio20 ?? 0) >= 1.5) hints.push('出来高が20日平均を上回る')
  if ((metrics.physicalMomentumScore ?? 0) >= 0.7) hints.push('PMSは市場平均より強い')
  if ((metrics.physicalMomentumScore ?? 0) <= -0.7) hints.push('PMSは市場平均より弱い')
  if ((metrics.physicalForceScore ?? 0) >= 0.7) hints.push('PFSがプラスで力の増加を示唆')
  if ((metrics.physicalForceScore ?? 0) <= -0.7) hints.push('PFSがマイナスで力の低下を示唆')
  return hints.length > 0 ? hints.slice(0, 6) : ['明確な単独シグナルは少なく、見送り判断も含めて確認する局面']
}

export function buildAnswerExplanation(
  stage: DrillStageSnapshot,
  metrics: DrillMetricSnapshot,
  outcome: DrillOutcome,
): { explanations: string[]; reviewTags: string[] } {
  const explanations = buildHintSummary(stage, metrics)
  if (outcome.thresholdHitDirection === 'both') {
    explanations.push('期間内に上昇条件と下落条件の両方へ到達した高ボラ問題です。先に達成した方向を正解扱いにしています。')
  } else if (outcome.actual === 'pass') {
    explanations.push('指定期間内に上昇・下落どちらのしきい値にも届かず、見送りが正解です。')
  } else {
    explanations.push(`${outcome.thresholdHitDay ?? '-'}営業日目に${outcome.actual === 'up' ? '高値' : '安値'}ベースで条件へ到達しました。`)
  }
  if (!outcome.closeHit && outcome.actual !== 'pass') {
    explanations.push('終値ベースでは条件未達です。ヒゲだけで達成した可能性があり、ダマシ確認が必要です。')
  }

  const tags: string[] = []
  if (outcome.actual === 'up') tags.push('上昇初動')
  if (outcome.actual === 'down') tags.push('下落初動')
  if (outcome.actual === 'pass') tags.push('見送り')
  if (outcome.highVolatility) tags.push('高ボラ')
  if ((metrics.volumeRatio20 ?? 0) >= 1.5) tags.push('出来高急増')
  if ((metrics.physicalMomentumScore ?? 0) >= 0.7) tags.push('PMS強')
  if ((metrics.physicalMomentumScore ?? 0) <= -0.7) tags.push('PMS弱')
  if (stage.previousDailyA != null && stage.dailyA != null && stage.previousDailyA !== stage.dailyA) tags.push('ステージ転換')
  return { explanations, reviewTags: tags }
}
