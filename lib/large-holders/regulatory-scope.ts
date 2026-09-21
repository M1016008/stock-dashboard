import { evidenceHash } from './instrument-certification'

export type VotingStatus = 'VOTING' | 'NON_VOTING' | 'CONDITIONAL' | 'UNKNOWN'
export type ReportingScopeStatus = 'ELIGIBLE' | 'EXCLUDED' | 'UNKNOWN'
export type RegulatoryScopeEntry = {
  securityType: 'COMMON_STOCK' | 'PREFERRED_OR_CLASS_STOCK' | 'REIT_INVESTMENT_UNIT'
  securityCode: string | null
  votingStatus: VotingStatus
  reportingScopeStatus: ReportingScopeStatus
  convertibleToVoting: boolean | null
  effectiveFrom: string
  effectiveTo: string | null
  sourceAuthority: 'FSA' | 'JPX'
  sourceReference: string
  sourceEvidence: string
  sourceHash: string
}

const FSA_SCOPE = 'https://www.fsa.go.jp/common/shinsei/tairyohoyu/summary/index.html'
const FSA_EXCEPTION = 'https://www.fsa.go.jp/news/21/sonota/20100331-12/03.pdf'
const JPX_ITO_EN = 'https://www.jpx.co.jp/equities/products/preferred-stocks/issues/tvdivq0000007usm-att/25935g.pdf'
const JPX_SOFTBANK = 'https://www2.jpx.co.jp/disc/94340/140120230925557770.pdf'

function entry(value: Omit<RegulatoryScopeEntry, 'sourceEvidence' | 'sourceHash'>): RegulatoryScopeEntry {
  const sourceEvidence = JSON.stringify(value)
  return { ...value, sourceEvidence, sourceHash: evidenceHash(value) }
}

// The issuer-specific rows describe only these official securities, not every preferred share.
export const REGULATORY_SCOPE_REGISTRY: readonly RegulatoryScopeEntry[] = [
  entry({ securityType: 'COMMON_STOCK', securityCode: null, votingStatus: 'VOTING',
    reportingScopeStatus: 'ELIGIBLE', convertibleToVoting: false,
    effectiveFrom: '2010-03-31', effectiveTo: null, sourceAuthority: 'FSA',
    sourceReference: FSA_SCOPE }),
  entry({ securityType: 'REIT_INVESTMENT_UNIT', securityCode: null, votingStatus: 'UNKNOWN',
    reportingScopeStatus: 'ELIGIBLE', convertibleToVoting: false,
    effectiveFrom: '2010-03-31', effectiveTo: null, sourceAuthority: 'FSA',
    sourceReference: FSA_SCOPE }),
  entry({ securityType: 'PREFERRED_OR_CLASS_STOCK', securityCode: '25935',
    votingStatus: 'CONDITIONAL', reportingScopeStatus: 'UNKNOWN', convertibleToVoting: null,
    effectiveFrom: '2007-09-03', effectiveTo: null, sourceAuthority: 'JPX',
    sourceReference: JPX_ITO_EN }),
  entry({ securityType: 'PREFERRED_OR_CLASS_STOCK', securityCode: '94345',
    votingStatus: 'NON_VOTING', reportingScopeStatus: 'EXCLUDED', convertibleToVoting: false,
    effectiveFrom: '2023-11-02', effectiveTo: null, sourceAuthority: 'JPX',
    sourceReference: JPX_SOFTBANK }),
]

export function activeRegulatoryScope(securityType: RegulatoryScopeEntry['securityType'],
  securityCode: string, date: string): RegulatoryScopeEntry {
  const active = REGULATORY_SCOPE_REGISTRY.find((row) => row.securityType === securityType
    && row.securityCode === securityCode && row.effectiveFrom <= date
    && (!row.effectiveTo || row.effectiveTo >= date))
    ?? REGULATORY_SCOPE_REGISTRY.find((row) => row.securityType === securityType
      && row.securityCode === null && row.effectiveFrom <= date
      && (!row.effectiveTo || row.effectiveTo >= date))
  return active ?? entry({ securityType, securityCode, votingStatus: 'UNKNOWN',
    reportingScopeStatus: 'UNKNOWN', convertibleToVoting: null,
    effectiveFrom: date, effectiveTo: null, sourceAuthority: 'FSA',
    sourceReference: FSA_EXCEPTION })
}

export function excludedByRegulation(scope: RegulatoryScopeEntry): boolean {
  return evidenceHash(JSON.parse(scope.sourceEvidence)) === scope.sourceHash
    && scope.reportingScopeStatus === 'EXCLUDED' && scope.votingStatus === 'NON_VOTING'
    && scope.convertibleToVoting === false && scope.securityCode != null
    && scope.sourceAuthority === 'JPX'
}

export function verifiedClassScope(scope: RegulatoryScopeEntry, code: string,
  date: string): boolean {
  try {
    const { sourceEvidence, sourceHash, ...facts } = scope
    return scope.securityCode === code && scope.securityType === 'PREFERRED_OR_CLASS_STOCK'
      && scope.effectiveFrom <= date && (!scope.effectiveTo || scope.effectiveTo >= date)
      && scope.sourceAuthority === 'JPX' && /^https:\/\/www2?\.jpx\.co\.jp\//.test(scope.sourceReference)
      && evidenceHash(facts) === sourceHash
      && JSON.stringify(facts) === sourceEvidence
  } catch { return false }
}
