import { US_MONTHLY_MA_PRICE_BASIS } from '@/lib/us-ma25m-monitor'

export type UsMonthlyMaGenerationRun = {
  id: number
  status: string
  payloadJson: string
  totalTickers: number
  succeeded: number
  failed: number
  finishedAt: number | null
  snapshotMaxComputedAt: number | null
}

export type UsMonthlyMaGenerationAttestation =
  | { ok: true; generation: number; priceBasis: string }
  | { ok: false; reason: 'unavailable' | 'price_basis_mismatch' | 'incomplete'; actualPriceBasis: string | null }

export function attestUsMonthlyMaGeneration(
  run: UsMonthlyMaGenerationRun | undefined,
): UsMonthlyMaGenerationAttestation {
  if (!run?.payloadJson) return { ok: false, reason: 'unavailable', actualPriceBasis: null }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(run.payloadJson) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'incomplete', actualPriceBasis: null }
  }

  const priceBasis = typeof payload.priceBasis === 'string' ? payload.priceBasis : null
  if (priceBasis !== US_MONTHLY_MA_PRICE_BASIS) {
    return { ok: false, reason: 'price_basis_mismatch', actualPriceBasis: priceBasis }
  }

  const complete = run.status === 'success'
    && run.finishedAt != null
    && run.totalTickers > 0
    && run.succeeded === run.totalTickers
    && run.failed === 0
    && (run.snapshotMaxComputedAt == null || run.snapshotMaxComputedAt <= run.finishedAt)
    && payload.stage === 'complete'
    && payload.tickerStart == null
    && payload.tickerEnd == null
    && payload.limit == null
    && payload.tickers == null

  return complete
    ? { ok: true, generation: run.id, priceBasis }
    : { ok: false, reason: 'incomplete', actualPriceBasis: priceBasis }
}
