import type {
  TradeScenarioDirection,
  TradeScenarioOutcome,
  TradeScenarioPriceRow,
} from './types'

interface EvaluateScenarioArgs {
  direction: TradeScenarioDirection
  anchorPrice: number | null
  horizonDays: number
  targetPrice: number | null
  stopLossPrice: number | null
  futureRows: TradeScenarioPriceRow[]
}

function pctChange(value: number, base: number): number {
  return ((value - base) / base) * 100
}

function directionTone(value: number | null): TradeScenarioOutcome['tone'] {
  if (value == null || Math.abs(value) < 0.1) return 'neutral'
  return value > 0 ? 'up' : 'down'
}

export function evaluateTradeScenario({
  direction,
  anchorPrice,
  horizonDays,
  targetPrice,
  stopLossPrice,
  futureRows,
}: EvaluateScenarioArgs): TradeScenarioOutcome {
  const safeHorizon = Math.max(1, Math.floor(horizonDays || 20))
  const rows = futureRows.slice(0, safeHorizon)
  if (anchorPrice == null || !Number.isFinite(anchorPrice) || anchorPrice <= 0 || rows.length === 0) {
    return {
      status: 'no_data',
      label: '検証データ不足',
      tone: 'neutral',
      maxRisePct: null,
      maxDrawdownPct: null,
      endReturnPct: null,
      targetHitDate: null,
      targetHitDay: null,
      stopHitDate: null,
      stopHitDay: null,
      evaluatedDays: rows.length,
      remainingDays: safeHorizon,
      note: '基準日以降の日足データが不足しています。',
    }
  }

  let maxHigh = anchorPrice
  let minLow = anchorPrice
  let targetHitDate: string | null = null
  let targetHitDay: number | null = null
  let stopHitDate: string | null = null
  let stopHitDay: number | null = null
  let terminalStatus: TradeScenarioOutcome['status'] | null = null

  rows.forEach((row, index) => {
    const day = index + 1
    if (row.high > maxHigh) maxHigh = row.high
    if (row.low < minLow) minLow = row.low

    if (terminalStatus) return

    if (direction === 'bullish') {
      const hitStop = stopLossPrice != null && row.low <= stopLossPrice
      const hitTarget = targetPrice != null && row.high >= targetPrice
      if (hitStop) {
        stopHitDate = row.date
        stopHitDay = day
        terminalStatus = 'stop_hit'
      } else if (hitTarget) {
        targetHitDate = row.date
        targetHitDay = day
        terminalStatus = 'target_hit'
      }
    } else if (direction === 'bearish') {
      const hitStop = stopLossPrice != null && row.high >= stopLossPrice
      const hitTarget = targetPrice != null && row.low <= targetPrice
      if (hitStop) {
        stopHitDate = row.date
        stopHitDay = day
        terminalStatus = 'stop_hit'
      } else if (hitTarget) {
        targetHitDate = row.date
        targetHitDay = day
        terminalStatus = 'target_hit'
      }
    }
  })

  const latestClose = rows[rows.length - 1].close
  const maxRisePct = pctChange(maxHigh, anchorPrice)
  const maxDrawdownPct = pctChange(minLow, anchorPrice)
  const endReturnPct = pctChange(latestClose, anchorPrice)
  const expired = rows.length >= safeHorizon

  if (terminalStatus === 'target_hit') {
    return {
      status: 'target_hit',
      label: '目標到達',
      tone: direction === 'bearish' ? 'down' : 'up',
      maxRisePct,
      maxDrawdownPct,
      endReturnPct,
      targetHitDate,
      targetHitDay,
      stopHitDate,
      stopHitDay,
      evaluatedDays: rows.length,
      remainingDays: Math.max(0, safeHorizon - rows.length),
      note: targetHitDay != null ? `${targetHitDay}営業日目に目標価格へ到達しました。` : '目標価格へ到達しました。',
    }
  }

  if (terminalStatus === 'stop_hit') {
    return {
      status: 'stop_hit',
      label: '撤退条件到達',
      tone: direction === 'bearish' ? 'up' : 'down',
      maxRisePct,
      maxDrawdownPct,
      endReturnPct,
      targetHitDate,
      targetHitDay,
      stopHitDate,
      stopHitDay,
      evaluatedDays: rows.length,
      remainingDays: Math.max(0, safeHorizon - rows.length),
      note: stopHitDay != null ? `${stopHitDay}営業日目に撤退条件へ到達しました。` : '撤退条件へ到達しました。',
    }
  }

  if (!expired) {
    return {
      status: 'pending',
      label: '検証中',
      tone: directionTone(endReturnPct),
      maxRisePct,
      maxDrawdownPct,
      endReturnPct,
      targetHitDate,
      targetHitDay,
      stopHitDate,
      stopHitDay,
      evaluatedDays: rows.length,
      remainingDays: Math.max(0, safeHorizon - rows.length),
      note: `まだ${Math.max(0, safeHorizon - rows.length)}営業日分の検証余地があります。`,
    }
  }

  if (direction === 'watch') {
    const maxAbsMove = Math.max(Math.abs(maxRisePct), Math.abs(maxDrawdownPct))
    return {
      status: maxAbsMove < 5 ? 'watch_ok' : 'watch_missed',
      label: maxAbsMove < 5 ? '見送り妥当' : '大きく変動',
      tone: directionTone(endReturnPct),
      maxRisePct,
      maxDrawdownPct,
      endReturnPct,
      targetHitDate,
      targetHitDay,
      stopHitDate,
      stopHitDay,
      evaluatedDays: rows.length,
      remainingDays: 0,
      note: maxAbsMove < 5
        ? '大きな値幅は出ず、見送り判断は概ね妥当でした。'
        : '見送り後に大きな値幅が出ました。見送った理由を振り返る価値があります。',
    }
  }

  const matched = direction === 'bearish' ? endReturnPct < 0 : endReturnPct > 0
  return {
    status: matched ? 'direction_matched' : 'direction_missed',
    label: matched ? '方向は一致' : '方向は不一致',
    tone: directionTone(endReturnPct),
    maxRisePct,
    maxDrawdownPct,
    endReturnPct,
    targetHitDate,
    targetHitDay,
    stopHitDate,
    stopHitDay,
    evaluatedDays: rows.length,
    remainingDays: 0,
    note: matched
      ? '目標価格には届いていませんが、想定方向には動きました。'
      : '想定方向とは逆、または弱い結果でした。根拠の再確認が必要です。',
  }
}
