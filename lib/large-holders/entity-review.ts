import { randomUUID } from 'node:crypto'
import { classForCategory, type InvestorCategory } from './classification'
import { sha256 } from './evidence-provenance'
import { summarizeInvestor, type InvestorSummary, type RankingSnapshot } from './ranking-core'

export type ReviewEvidence = { documentId: string; sourceSha256: string; note: string }
export type ReviewDecision = {
  id: string
  at: string
  kind: 'CLASSIFY' | 'MERGE' | 'UNDO'
  entityId?: string
  category?: InvestorCategory
  sourceEntityId?: string
  targetEntityId?: string
  undoId?: string
  note?: string
  evidence?: ReviewEvidence
}

export function reviewDigest(decisions: ReviewDecision[]): string {
  return sha256(JSON.stringify(decisions))
}

function verifyEvidence(snapshot: RankingSnapshot, decision: ReviewDecision): void {
  const evidence = decision.evidence
  if (!evidence || evidence.note.trim().length < 8 || evidence.note.length > 2000) throw new Error('review_evidence_required')
  const filing = snapshot.filings.find((item) => item.documentId === evidence.documentId)
  if (!filing?.sourceVerified || !filing.sourceSha256 || filing.sourceSha256 !== evidence.sourceSha256)
    throw new Error('review_official_source_unverified')
  const related = [decision.entityId, decision.sourceEntityId, decision.targetEntityId].filter(Boolean)
  if (!related.some((id) => filing.investorEntityIds.includes(id!)))
    throw new Error('review_evidence_unrelated_to_entity')
}

function activeDecisions(decisions: ReviewDecision[]): ReviewDecision[] {
  const ids = new Set<string>()
  const kinds = new Map<string, ReviewDecision['kind']>()
  const undone = new Set<string>()
  for (const decision of decisions) {
    if (ids.has(decision.id)) throw new Error('review_duplicate_decision_id')
    ids.add(decision.id)
    kinds.set(decision.id, decision.kind)
    if (decision.kind === 'UNDO') {
      if (!decision.undoId || kinds.get(decision.undoId) === 'UNDO'
        || !ids.has(decision.undoId) || undone.has(decision.undoId)
        || (decision.note?.trim().length ?? 0) < 8)
        throw new Error('review_invalid_undo')
      undone.add(decision.undoId)
    }
  }
  return decisions.filter((item) => item.kind !== 'UNDO' && !undone.has(item.id))
}

export function applyReviewDecisions(original: RankingSnapshot, decisions: ReviewDecision[]): RankingSnapshot {
  const snapshot = structuredClone(original)
  const investors = new Map(snapshot.investors.map((item) => [item.investorEntityId, item]))
  for (const decision of activeDecisions(decisions)) {
    verifyEvidence(original, decision)
    if (decision.kind === 'CLASSIFY') {
      const investor = investors.get(decision.entityId ?? '')
      if (!investor || investor.investorClass !== 'UNCLASSIFIED' || !decision.category
        || decision.category === 'UNCLASSIFIED') throw new Error('review_classification_not_allowed')
      investor.investorClass = classForCategory(decision.category)
      investor.investorType = decision.category
      for (const activity of snapshot.activities) if (activity.investorEntityId === investor.investorEntityId)
        activity.investorClass = investor.investorClass
      continue
    }
    const source = investors.get(decision.sourceEntityId ?? '')
    const target = investors.get(decision.targetEntityId ?? '')
    if (!source || !target || source.investorEntityId === target.investorEntityId)
      throw new Error('review_merge_entity_missing')
    if (source.investorClass !== target.investorClass && source.investorClass !== 'UNCLASSIFIED'
      && target.investorClass !== 'UNCLASSIFIED') throw new Error('review_merge_class_conflict')
    const sourceTickers = new Set(source.positions.map((row) => row.ticker))
    if (target.positions.some((row) => sourceTickers.has(row.ticker)))
      throw new Error('review_merge_position_overlap')
    const sourceActivityTickers = new Set(snapshot.activities.filter((row) => row.investorEntityId === source.investorEntityId)
      .map((row) => row.ticker))
    if (snapshot.activities.some((row) => row.investorEntityId === target.investorEntityId
      && sourceActivityTickers.has(row.ticker))) throw new Error('review_merge_activity_overlap')
    const investorClass = target.investorClass === 'UNCLASSIFIED' ? source.investorClass : target.investorClass
    const investorType = target.investorClass === 'UNCLASSIFIED' ? source.investorType : target.investorType
    const merged: InvestorSummary = summarizeInvestor({ investorEntityId: target.investorEntityId,
      displayName: target.displayName, investorClass, investorType,
      aliases: [...new Set([...target.aliases, source.displayName, ...source.aliases])],
      positions: [...target.positions, ...source.positions.map((row) => ({ ...row,
        investorEntityId: target.investorEntityId }))].toSorted((a, b) => a.ticker.localeCompare(b.ticker)),
    })
    investors.set(target.investorEntityId, merged)
    investors.delete(source.investorEntityId)
    for (const activity of snapshot.activities) {
      if (activity.investorEntityId === source.investorEntityId) activity.investorEntityId = target.investorEntityId
      if (activity.investorEntityId === target.investorEntityId) activity.investorClass = investorClass
    }
    for (const filing of snapshot.filings) filing.investorEntityIds = [...new Set(filing.investorEntityIds
      .map((id) => id === source.investorEntityId ? target.investorEntityId : id))]
  }
  snapshot.investors = [...investors.values()].toSorted((a, b) => a.investorEntityId.localeCompare(b.investorEntityId))
  return snapshot
}

export function previewReviewDecision(snapshot: RankingSnapshot, decisions: ReviewDecision[],
  input: Omit<ReviewDecision, 'id' | 'at'>) {
  const next: ReviewDecision = { ...input, id: randomUUID(), at: new Date().toISOString() }
  const updated = applyReviewDecisions(snapshot, [...decisions, next])
  const source = snapshot.investors.find((row) => row.investorEntityId === input.sourceEntityId)
  const targetBefore = snapshot.investors.find((row) => row.investorEntityId === input.targetEntityId)
  const targetAfter = updated.investors.find((row) => row.investorEntityId === input.targetEntityId)
  const activityCount = (value: RankingSnapshot, ids: string[]) => value.activities
    .filter((row) => ids.includes(row.investorEntityId)).length
  const sum = (left: number | null | undefined, right: number | null | undefined) =>
    left == null && right == null ? null : (left ?? 0) + (right ?? 0)
  return { decision: next, before: {
    investorCount: snapshot.investors.length, positionCount: snapshot.currentPositionCount,
    publicReady: snapshot.publicCurrentValuationReadyCount,
    sourcePositions: source?.positions.length ?? null,
    targetPositions: targetBefore?.positions.length ?? null,
    combinedValue: (source?.estimatedCurrentValue ?? 0) + (targetBefore?.estimatedCurrentValue ?? 0),
    ownershipValue: sum(source?.ownershipEstimatedValue, targetBefore?.ownershipEstimatedValue),
    investmentAuthorityValue: sum(source?.investmentAuthorityEstimatedValue,
      targetBefore?.investmentAuthorityEstimatedValue),
    activities: activityCount(snapshot, [input.sourceEntityId ?? '', input.targetEntityId ?? '']),
  }, after: { investorCount: updated.investors.length,
    positionCount: updated.investors.reduce((n, row) => n + row.positions.length, 0),
    publicReady: updated.publicCurrentValuationReadyCount,
    targetPositions: targetAfter?.positions.length ?? null,
    combinedValue: targetAfter?.estimatedCurrentValue ?? null,
    ownershipValue: targetAfter?.ownershipEstimatedValue ?? null,
    investmentAuthorityValue: targetAfter?.investmentAuthorityEstimatedValue ?? null,
    activities: activityCount(updated, [input.targetEntityId ?? '']) },
  }
}

export function reviewQueue(snapshot: RankingSnapshot, confidenceByPosition = new Map<string, string>()) {
  const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  const byName = new Map<string, string[]>()
  for (const investor of snapshot.investors) {
    for (const name of new Set([investor.displayName, ...investor.aliases].map(normalized)))
      byName.set(name, [...(byName.get(name) ?? []), investor.investorEntityId])
  }
  return snapshot.investors.map((investor) => {
    const sameName = (byName.get(normalized(investor.displayName)) ?? [])
      .filter((id) => id !== investor.investorEntityId)
    const aliasMatches = [...new Set(investor.aliases.flatMap((alias) => byName.get(normalized(alias)) ?? []))]
      .filter((id) => id !== investor.investorEntityId && !sameName.includes(id))
    const reasons = [
      ...(investor.investorClass === 'UNCLASSIFIED' ? ['UNCLASSIFIED'] : []),
      ...(investor.positions.some((position) => confidenceByPosition.get(position.positionKey) === 'AUTO_UNCERTAIN')
        ? ['AUTO_UNCERTAIN'] : []),
      ...(investor.aliases.length > 1 ? ['POSSIBLE_ALIAS_OR_NAME_CHANGE'] : []),
      ...(sameName.length ? ['SAME_NAME_DISTINCT_CANDIDATE'] : []),
      ...(aliasMatches.length ? ['POSSIBLE_ALIAS'] : []),
    ]
    return { investorEntityId: investor.investorEntityId, displayName: investor.displayName,
      investorClass: investor.investorClass, investorType: investor.investorType,
      aliases: investor.aliases, positions: investor.positions.map((row) => ({ ticker: row.ticker,
        documentId: row.documentId, pct: row.reportedHoldingPct,
        estimatedCurrentValue: row.estimatedCurrentValue })),
      possibleMatches: [...sameName, ...aliasMatches], reasons }
  }).filter((row) => row.reasons.length)
}
