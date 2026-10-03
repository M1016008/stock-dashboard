import type { HolderFact, SecurityComponent } from './filing'

export type MarketPriceEvidence = {
  issuerCodeMatches: boolean
  listedAtReference: boolean
  uniquePriceInstrument: boolean
  priceDate: string | null
  close: number | null
  classAmbiguous: boolean
}

export type MarketPriceAssessment = {
  status: 'FULL_DIRECT' | 'PARTIAL_DIRECT' | 'AMBIGUOUS' | 'NOT_APPLICABLE'
  reason: string
  eligibleUnits: number | null
  coveragePct: number | null
  basisUnits: Record<SecurityComponent['holdingBasis'], number>
}

export function assessMarketPriceHolding(holder: HolderFact, evidence: MarketPriceEvidence): MarketPriceAssessment {
  const basisUnits: MarketPriceAssessment['basisUnits'] = {
    OWNERSHIP_LIKE: 0, VOTING_AUTHORITY: 0, INVESTMENT_AUTHORITY: 0, DERIVATIVE: 0,
  }
  const direct = holder.securityBreakdown.filter((part) => part.kind === 'DIRECT_SECURITY' && part.quantity > 0)
  for (const part of direct) basisUnits[part.holdingBasis] += part.quantity
  const base = { basisUnits, eligibleUnits: null, coveragePct: null }
  if (!direct.length) return { ...base, status: 'NOT_APPLICABLE', reason: 'no_positive_direct_security' }
  if (holder.securityBreakdown.some((part) => part.quantity < 0)
    || direct.some((part) => !Number.isSafeInteger(part.quantity) || part.unit !== 'xbrli:shares')) {
    return { ...base, status: 'AMBIGUOUS', reason: 'invalid_or_mismatched_direct_unit' }
  }
  if (holder.deductions.some((deduction) => deduction.quantity !== 0)) {
    return { ...base, status: 'AMBIGUOUS', reason: 'unallocated_legal_deduction' }
  }
  if (evidence.classAmbiguous) return { ...base, status: 'AMBIGUOUS', reason: 'security_class_unresolved' }
  if (!evidence.issuerCodeMatches || !evidence.uniquePriceInstrument || !evidence.listedAtReference
    || !evidence.priceDate || evidence.close == null || evidence.close <= 0) {
    return { ...base, status: 'AMBIGUOUS', reason: 'listed_instrument_or_pit_price_unproven' }
  }
  const positiveBasis = Object.values(basisUnits).filter((quantity) => quantity > 0)
  if (positiveBasis.length !== 1) {
    return { ...base, status: 'AMBIGUOUS', reason: 'overlapping_holding_bases_unallocated' }
  }
  const units = positiveBasis[0]
  if (holder.shares == null || units > holder.shares || units <= 0) {
    return { ...base, status: 'AMBIGUOUS', reason: 'direct_count_exceeds_reported_total' }
  }
  const potential = holder.securityBreakdown.some((part) => part.kind !== 'DIRECT_SECURITY' && part.quantity !== 0)
  return {
    status: potential || units < holder.shares ? 'PARTIAL_DIRECT' : 'FULL_DIRECT',
    reason: potential ? 'direct_component_only_potential_excluded'
      : units < holder.shares ? 'direct_component_only_other_quantity_excluded' : 'direct_component_only',
    eligibleUnits: units, coveragePct: units / holder.shares * 100, basisUnits,
  }
}
