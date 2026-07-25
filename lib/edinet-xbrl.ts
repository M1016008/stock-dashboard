export type MajorShareholderFact = {
  holderName: string
  shares: number | null
  holdingRatio: number | null
}

export type PolicyHoldingFact = {
  issuerName: string
  shares: number | null
  bookValue: number | null
  purpose: string | null
  quantitativeEffect: string | null
  holdingType: string | null
}

export type LargeHoldingFact = {
  holderName: string | null
  shares: number | null
  holdingRatio: number | null
  previousHoldingRatio: number | null
  purpose: string | null
  reportKind: string | null
}

type Fact = {
  localName: string
  contextRef: string
  value: string
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function attr(attrs: string, name: string): string {
  return attrs.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1] ?? ''
}

function factsFromXbrl(xml: string): Fact[] {
  const facts: Fact[] = []
  const factPattern = /<([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)\b([^>]*\bcontextRef=["'][^"']+["'][^>]*)>([\s\S]*?)<\/\1:\2>/g
  for (const match of xml.matchAll(factPattern)) {
    const contextRef = attr(match[3], 'contextRef')
    if (!contextRef || /<[\w.-]+:[\w.-]+\b/i.test(match[4])) continue
    const value = decodeXml(match[4])
    if (!value) continue
    facts.push({ localName: match[2], contextRef, value })
  }
  return facts
}

function contextDescriptions(xml: string): Map<string, string> {
  const contexts = new Map<string, string>()
  const contextPattern = /<xbrli:context\b([^>]*)>([\s\S]*?)<\/xbrli:context>/gi
  for (const match of xml.matchAll(contextPattern)) {
    const id = attr(match[1], 'id')
    if (id) contexts.set(id, decodeXml(match[2]))
  }
  return contexts
}

function numeric(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value.replace(/,/g, '').replace(/%$/, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function firstFact(group: Fact[], pattern: RegExp): Fact | undefined {
  return group.find((fact) => pattern.test(fact.localName))
}

function groupedFacts(xml: string): Array<{ contextRef: string; context: string; facts: Fact[] }> {
  const contexts = contextDescriptions(xml)
  const groups = new Map<string, Fact[]>()
  for (const fact of factsFromXbrl(xml)) {
    const group = groups.get(fact.contextRef) ?? []
    group.push(fact)
    groups.set(fact.contextRef, group)
  }
  return [...groups.entries()].map(([contextRef, facts]) => ({
    contextRef,
    context: contexts.get(contextRef) ?? '',
    facts,
  }))
}

function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const value = key(row)
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}

export function parseMajorShareholders(xml: string): MajorShareholderFact[] {
  const rows = groupedFacts(xml).flatMap(({ context, facts }) => {
    const holder = firstFact(
      facts,
      /(Name.*Major.*Shareholder|MajorShareholder.*Name|NameMajorShareholders)/i,
    )
    if (!holder && !/MajorShareholdersAxis/i.test(context)) return []
    const holderName = holder?.value ?? ''
    if (!holderName) return []
    return [{
      holderName,
      shares: numeric(firstFact(facts, /(NumberOfSharesHeld|NumberOfSharesOwned)/i)?.value),
      holdingRatio: numeric(firstFact(
        facts,
        /(ShareholdingRatio|PercentageOfTotalNumberOfIssuedSharesHeld|RatioOfShareholding)/i,
      )?.value),
    }]
  })
  return dedupeBy(rows, (row) => row.holderName)
}

export function parsePolicyHoldings(xml: string): PolicyHoldingFact[] {
  const rows = groupedFacts(xml).flatMap(({ context, facts }) => {
    const policyContext = /(SpecifiedInvestment|DeemedHolding|PolicyHolding|CrossShareholding)/i.test(context)
    const purpose = firstFact(facts, /(PurposeOfHolding|ReasonForHolding)/i)
    if (!policyContext && !purpose) return []
    const issuer = firstFact(facts, /(NameOfIssuer|IssuerName)/i)
    if (!issuer?.value) return []
    const lowerContext = context.toLowerCase()
    return [{
      issuerName: issuer.value,
      shares: numeric(firstFact(facts, /(NumberOfShares|NumberOfStocks)/i)?.value),
      bookValue: numeric(firstFact(facts, /(BalanceSheetAmount|BookValue)/i)?.value),
      purpose: purpose?.value ?? null,
      quantitativeEffect: firstFact(facts, /(QuantitativeEffects|QuantitativeEffect)/i)?.value ?? null,
      holdingType: lowerContext.includes('nonspecified')
        ? 'みなし保有'
        : lowerContext.includes('specified') ? '特定投資株式' : null,
    }]
  })
  return dedupeBy(rows, (row) => `${row.holdingType ?? ''}:${row.issuerName}`)
}

export function parseLargeHolding(xml: string, filerName?: string | null): LargeHoldingFact {
  const facts = factsFromXbrl(xml)
  const find = (pattern: RegExp) => facts.find((fact) => pattern.test(fact.localName))?.value
  return {
    holderName: find(/(NameOfLargeShareholdingReporter|NameOfReporter|ReporterName)/i) ?? filerName ?? null,
    shares: numeric(
      find(/(TotalNumberOfStocksEtcHeld|NumberOfStocksEtcHeld)/i)
      ?? find(/TotalNumberOfSharesHeld/i),
    ),
    holdingRatio: numeric(
      find(/(RatioOfStockEtcHolding|HoldingRatioAfterTransaction)/i)
      ?? find(/ShareholdingRatio/i),
    ),
    previousHoldingRatio: numeric(find(/(PreviousRatioOfStockEtcHolding|HoldingRatioBeforeTransaction)/i)),
    purpose: find(/PurposeOfStockHolding/i) ?? find(/PurposeOfHolding/i) ?? null,
    reportKind: find(/(DocumentType|TypeOfReport|ReasonForSubmission)/i) ?? null,
  }
}
