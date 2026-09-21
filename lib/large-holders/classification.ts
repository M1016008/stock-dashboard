export const INVESTOR_CATEGORIES = [
  'INDIVIDUAL', 'DOMESTIC_ASSET_MANAGER', 'FOREIGN_ASSET_MANAGER', 'FUND',
  'FINANCIAL_INSTITUTION', 'OPERATING_COMPANY', 'OTHER_CORPORATION', 'UNCLASSIFIED',
] as const

export type InvestorCategory = typeof INVESTOR_CATEGORIES[number]

export function classifyFromFiling(description: string | null, business: string | null = null, address: string | null = null): {
  category: InvestorCategory
  investorClass: 'INDIVIDUAL' | 'INSTITUTIONAL' | 'OTHER' | 'UNCLASSIFIED'
  confidence: 'AUTO_CONFIDENT' | 'AUTO_UNCERTAIN' | 'UNCLASSIFIED'
  source: string | null
  evidence: string | null
} {
  if (description?.trim() === '個人') return {
    category: 'INDIVIDUAL', investorClass: 'INDIVIDUAL', confidence: 'AUTO_CONFIDENT',
    source: 'IndividualOrCorporation', evidence: description,
  }
  // Only the holder's own EDINET business field can establish the activity.
  if (/法人|株式会社|合同会社|有限会社/.test(description ?? '') && business) {
    const category: InvestorCategory | null = /(?:^|[、・\s])銀行業(?:$|[、・\s])|損害保険業|証券業|金融商品取引業/.test(business)
      ? 'FINANCIAL_INSTITUTION'
      : /(?:投資ファンド|プライベートエクイティファンド|ファンド)の(?:運用|運営)/.test(business)
          ? 'FUND' : null
    const manager = /投資運用業|投資顧問業|投資一任業務|投資助言業|資産運用業|証券投資信託の発行・運用/.test(business)
    const foreign = /外国法人|台湾法人|香港法人/.test(description ?? '')
    const domestic = Boolean(address && /(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県)/.test(address))
    const resolved = category ?? (manager ? foreign ? 'FOREIGN_ASSET_MANAGER'
      : domestic ? 'DOMESTIC_ASSET_MANAGER' : null : null)
    if (resolved) return {
      category: resolved, investorClass: 'INSTITUTIONAL', confidence: 'AUTO_CONFIDENT',
      source: 'IndividualOrCorporation+DescriptionOfBusiness', evidence: business,
    }
    // A business activity in the filing can establish an operating company; its name cannot.
    if (!/投資|運用|資産管理|有価証券|株式保有|金融/.test(business)
      && /物流|配送|倉庫業|建築|施工|製造|駐車場経営/.test(business)) return {
      category: 'OPERATING_COMPANY', investorClass: 'OTHER', confidence: 'AUTO_CONFIDENT',
      source: 'IndividualOrCorporation+DescriptionOfBusiness', evidence: business,
    }
  }
  return { category: 'UNCLASSIFIED', investorClass: 'UNCLASSIFIED',
    confidence: description ? 'AUTO_UNCERTAIN' : 'UNCLASSIFIED',
    source: description ? 'IndividualOrCorporation' : null,
    evidence: description,
  }
}

export function classForCategory(category: InvestorCategory): 'INDIVIDUAL' | 'INSTITUTIONAL' | 'OTHER' | 'UNCLASSIFIED' {
  if (category === 'INDIVIDUAL') return 'INDIVIDUAL'
  if (['DOMESTIC_ASSET_MANAGER', 'FOREIGN_ASSET_MANAGER', 'FUND',
    'FINANCIAL_INSTITUTION'].includes(category)) return 'INSTITUTIONAL'
  if (category === 'UNCLASSIFIED') return 'UNCLASSIFIED'
  return 'OTHER'
}
