import { SaxesParser, type SaxesTagNS } from 'saxes'

export type XbrlPeriod =
  | { kind: 'instant'; instant: string }
  | { kind: 'duration'; startDate: string; endDate: string }
  | { kind: 'forever' }
  | { kind: 'unknown' }

export type XbrlConsolidation = 'consolidated' | 'non_consolidated' | 'unknown'

export type XbrlDimension = {
  dimension: string
  member: string
  typed: boolean
}

export type XbrlResolvedDimension = {
  axisQName: string
  axisName: string
  memberQName: string
  memberName: string
  memberValue: string
  typed: boolean
}

export type XbrlContext = {
  id: string
  entityIdentifier: string | null
  entityScheme: string | null
  period: XbrlPeriod
  dimensions: XbrlDimension[]
  consolidation: XbrlConsolidation
}

export type XbrlUnit = {
  id: string
  measures: string[]
  numeratorMeasures: string[]
  denominatorMeasures: string[]
  label: string
}

export type XbrlDecimals = number | 'INF' | null

export type XbrlFact = {
  qname: string
  prefix: string
  localName: string
  namespaceUri: string
  contextRef: string
  context: XbrlContext | null
  unitRef: string | null
  unit: XbrlUnit | null
  decimals: XbrlDecimals
  scale: number | null
  sign: string | null
  isNil: boolean
  value: string
  textValue: string
  numericValue: number | null
}

export type XbrlFactGroup = {
  contextRef: string
  context: XbrlContext | null
  facts: XbrlFact[]
}

export type XbrlFactQuery = {
  consolidation?: XbrlConsolidation
  primaryContextOnly?: boolean
}

type MutableContext = {
  id: string
  entityIdentifier: string | null
  entityScheme: string | null
  instant: string | null
  startDate: string | null
  endDate: string | null
  forever: boolean
  dimensions: XbrlDimension[]
}

type MutableUnit = Omit<XbrlUnit, 'label'>

type PendingFact = Omit<XbrlFact, 'context' | 'unit' | 'value' | 'textValue' | 'numericValue'> & {
  tagName: string
  text: string
}

type Capture = {
  tagName: string
  kind: 'identifier' | 'instant' | 'startDate' | 'endDate' | 'dimension' | 'measure'
  text: string
  dimension?: string
  typed?: boolean
  measureTarget?: 'measure' | 'numerator' | 'denominator'
}

function attribute(tag: SaxesTagNS, localName: string): string | null {
  const wanted = localName.toLowerCase()
  for (const value of Object.values(tag.attributes)) {
    if (value.local.toLowerCase() === wanted) return value.value
  }
  return null
}

function localPart(qname: string): string {
  const separator = qname.lastIndexOf(':')
  return separator >= 0 ? qname.slice(separator + 1) : qname
}

function consolidationFromDimensions(dimensions: XbrlDimension[]): XbrlConsolidation {
  const names = dimensions
    .flatMap((dimension) => [dimension.dimension, dimension.member])
    .map((name) => localPart(name).toLowerCase())
  if (names.some((name) => name.includes('nonconsolidated'))) return 'non_consolidated'
  if (names.some((name) => name.includes('consolidatedmember'))) return 'consolidated'
  return 'unknown'
}

function consolidatedStatementsFlag(facts: PendingFact[]): boolean | null {
  const fact = facts.find((candidate) => (
    candidate.localName === 'WhetherConsolidatedFinancialStatementsArePreparedDEI'
  ))
  if (!fact) return null
  const value = normalizeXbrlText(fact.text).toLowerCase()
  if (['true', '1', 'yes'].includes(value)) return true
  if (['false', '0', 'no'].includes(value)) return false
  return null
}

function periodFromContext(context: MutableContext): XbrlPeriod {
  if (context.instant) return { kind: 'instant', instant: context.instant }
  if (context.startDate && context.endDate) {
    return { kind: 'duration', startDate: context.startDate, endDate: context.endDate }
  }
  if (context.forever) return { kind: 'forever' }
  return { kind: 'unknown' }
}

function unitLabel(unit: MutableUnit): string {
  if (unit.numeratorMeasures.length > 0 || unit.denominatorMeasures.length > 0) {
    const numerator = unit.numeratorMeasures.join('*') || '1'
    const denominator = unit.denominatorMeasures.join('*') || '1'
    return `${numerator}/${denominator}`
  }
  return unit.measures.join('*')
}

function parseDecimals(value: string | null): XbrlDecimals {
  if (!value) return null
  if (value.toUpperCase() === 'INF') return 'INF'
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

function parseInteger(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

export function normalizeXbrlText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function numericValue(
  value: string,
  options: { isNil: boolean; scale: number | null; sign: string | null },
): number | null {
  if (options.isNil) return null
  let normalized = value
    .replace(/[\s,\u00a0\u3000]/g, '')
    .replace(/[−–—]/g, '-')
  let parenthesizedNegative = false
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    parenthesizedNegative = true
    normalized = normalized.slice(1, -1)
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null
  let parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return null
  if (parenthesizedNegative && parsed > 0) parsed *= -1
  if (options.sign === '-' && parsed > 0) parsed *= -1
  if (options.scale != null) parsed *= 10 ** options.scale
  return Number.isFinite(parsed) ? parsed : null
}

function contextEndDate(context: XbrlContext | null): string {
  if (!context) return ''
  if (context.period.kind === 'instant') return context.period.instant
  if (context.period.kind === 'duration') return context.period.endDate
  return ''
}

function isPrimaryContext(context: XbrlContext | null): boolean {
  if (!context) return false
  return context.dimensions.every((dimension) => (
    localPart(dimension.dimension) === 'ConsolidatedOrNonConsolidatedAxis'
  ))
}

function matchesQuery(context: XbrlContext | null, query: XbrlFactQuery): boolean {
  if (!context) return !query.consolidation && !query.primaryContextOnly
  if (query.consolidation && context.consolidation !== query.consolidation) return false
  if (query.primaryContextOnly && !isPrimaryContext(context)) return false
  return true
}

function dimensionMatches(dimension: XbrlResolvedDimension, pattern: RegExp | string): boolean {
  if (typeof pattern === 'string') {
    return dimension.axisName === pattern || dimension.axisQName === pattern
  }
  pattern.lastIndex = 0
  if (pattern.test(dimension.axisName)) return true
  pattern.lastIndex = 0
  return pattern.test(dimension.axisQName)
}

export class XbrlFactReader {
  readonly contexts: ReadonlyMap<string, XbrlContext>
  readonly units: ReadonlyMap<string, XbrlUnit>
  readonly facts: readonly XbrlFact[]

  constructor(xml: string) {
    const parsed = parseXbrl(xml)
    this.contexts = parsed.contexts
    this.units = parsed.units
    this.facts = parsed.facts
  }

  findFacts(pattern: RegExp | string): XbrlFact[] {
    if (typeof pattern === 'string') {
      return this.facts.filter((fact) => fact.localName === pattern)
    }
    return this.facts.filter((fact) => {
      pattern.lastIndex = 0
      return pattern.test(fact.localName)
    })
  }

  groupedFacts(query: XbrlFactQuery = {}): XbrlFactGroup[] {
    const groups = new Map<string, XbrlFact[]>()
    for (const fact of this.facts) {
      const group = groups.get(fact.contextRef) ?? []
      group.push(fact)
      groups.set(fact.contextRef, group)
    }
    return [...groups.entries()].flatMap(([contextRef, facts]) => {
      const context = this.contexts.get(contextRef) ?? null
      if (!matchesQuery(context, query)) return []
      return [{ contextRef, context, facts }]
    })
  }

  latestFact(pattern: RegExp | string, query: XbrlFactQuery = {}): XbrlFact | null {
    return this.findFacts(pattern)
      .filter((fact) => matchesQuery(fact.context, query))
      .sort((left, right) => contextEndDate(right.context).localeCompare(contextEndDate(left.context)))[0]
      ?? null
  }

  isPrimaryContext(context: XbrlContext | null): boolean {
    return isPrimaryContext(context)
  }

  resolvedDimensions(context: XbrlContext | null): XbrlResolvedDimension[] {
    return (context?.dimensions ?? []).map((dimension) => ({
      axisQName: dimension.dimension,
      axisName: localPart(dimension.dimension),
      memberQName: dimension.member,
      memberName: dimension.typed ? dimension.member : localPart(dimension.member),
      memberValue: dimension.member,
      typed: dimension.typed,
    }))
  }

  findDimension(
    context: XbrlContext | null,
    pattern: RegExp | string,
  ): XbrlResolvedDimension | null {
    return this.resolvedDimensions(context)
      .find((dimension) => dimensionMatches(dimension, pattern)) ?? null
  }

  static contextEndDate(context: XbrlContext | null): string {
    return contextEndDate(context)
  }
}

function parseXbrl(xml: string): {
  contexts: Map<string, XbrlContext>
  units: Map<string, XbrlUnit>
  facts: XbrlFact[]
} {
  const contexts = new Map<string, XbrlContext>()
  const units = new Map<string, XbrlUnit>()
  const pendingFacts: PendingFact[] = []
  const completedFacts: PendingFact[] = []
  let currentContext: MutableContext | null = null
  let currentUnit: MutableUnit | null = null
  let unitMeasureTarget: 'measure' | 'numerator' | 'denominator' = 'measure'
  let capture: Capture | null = null

  const appendText = (text: string) => {
    if (capture) capture.text += text
    const fact = pendingFacts[pendingFacts.length - 1]
    if (fact) fact.text += text
  }

  const parser = new SaxesParser({ xmlns: true })

  parser.on('opentag', (tag) => {
    const localName = tag.local
    if (localName === 'context') {
      const id = attribute(tag, 'id')
      if (id) {
        currentContext = {
          id,
          entityIdentifier: null,
          entityScheme: null,
          instant: null,
          startDate: null,
          endDate: null,
          forever: false,
          dimensions: [],
        }
      }
    } else if (currentContext) {
      if (localName === 'identifier') {
        currentContext.entityScheme = attribute(tag, 'scheme')
        capture = { tagName: tag.name, kind: 'identifier', text: '' }
      } else if (localName === 'instant' || localName === 'startDate' || localName === 'endDate') {
        capture = { tagName: tag.name, kind: localName, text: '' }
      } else if (localName === 'forever') {
        currentContext.forever = true
      } else if (localName === 'explicitMember' || localName === 'typedMember') {
        capture = {
          tagName: tag.name,
          kind: 'dimension',
          text: '',
          dimension: attribute(tag, 'dimension') ?? '',
          typed: localName === 'typedMember',
        }
      }
    }

    if (localName === 'unit') {
      const id = attribute(tag, 'id')
      if (id) {
        currentUnit = { id, measures: [], numeratorMeasures: [], denominatorMeasures: [] }
        unitMeasureTarget = 'measure'
      }
    } else if (currentUnit) {
      if (localName === 'unitNumerator') unitMeasureTarget = 'numerator'
      if (localName === 'unitDenominator') unitMeasureTarget = 'denominator'
      if (localName === 'measure') {
        capture = {
          tagName: tag.name,
          kind: 'measure',
          text: '',
          measureTarget: unitMeasureTarget,
        }
      }
    }

    const contextRef = attribute(tag, 'contextRef')
    if (contextRef) {
      const isNil = /^(?:true|1)$/i.test(attribute(tag, 'nil') ?? '')
      pendingFacts.push({
        tagName: tag.name,
        qname: tag.name,
        prefix: tag.prefix,
        localName,
        namespaceUri: tag.uri,
        contextRef,
        unitRef: attribute(tag, 'unitRef'),
        decimals: parseDecimals(attribute(tag, 'decimals')),
        scale: parseInteger(attribute(tag, 'scale')),
        sign: attribute(tag, 'sign'),
        isNil,
        text: '',
      })
    }
  })

  parser.on('text', appendText)
  parser.on('cdata', appendText)

  parser.on('closetag', (tag) => {
    if (capture?.tagName === tag.name) {
      const value = capture.text.trim()
      if (currentContext) {
        if (capture.kind === 'identifier') currentContext.entityIdentifier = value || null
        if (capture.kind === 'instant') currentContext.instant = value || null
        if (capture.kind === 'startDate') currentContext.startDate = value || null
        if (capture.kind === 'endDate') currentContext.endDate = value || null
        if (capture.kind === 'dimension' && capture.dimension && value) {
          currentContext.dimensions.push({
            dimension: capture.dimension,
            member: value,
            typed: capture.typed ?? false,
          })
        }
      }
      if (currentUnit && capture.kind === 'measure' && value) {
        if (capture.measureTarget === 'numerator') currentUnit.numeratorMeasures.push(value)
        else if (capture.measureTarget === 'denominator') currentUnit.denominatorMeasures.push(value)
        else currentUnit.measures.push(value)
      }
      capture = null
    }

    const fact = pendingFacts[pendingFacts.length - 1]
    if (fact?.tagName === tag.name) completedFacts.push(pendingFacts.pop()!)

    if (tag.local === 'unitNumerator' || tag.local === 'unitDenominator') {
      unitMeasureTarget = 'measure'
    }
    if (tag.local === 'unit' && currentUnit) {
      units.set(currentUnit.id, { ...currentUnit, label: unitLabel(currentUnit) })
      currentUnit = null
    }
    if (tag.local === 'context' && currentContext) {
      contexts.set(currentContext.id, {
        id: currentContext.id,
        entityIdentifier: currentContext.entityIdentifier,
        entityScheme: currentContext.entityScheme,
        period: periodFromContext(currentContext),
        dimensions: currentContext.dimensions,
        consolidation: consolidationFromDimensions(currentContext.dimensions),
      })
      currentContext = null
    }
  })

  parser.on('error', (error) => {
    throw error
  })
  parser.write(xml).close()

  const consolidated = consolidatedStatementsFlag(completedFacts)
  const hasExplicitNonConsolidated = [...contexts.values()]
    .some((context) => context.consolidation === 'non_consolidated')
  const primaryConsolidation: XbrlConsolidation = consolidated === true
    ? 'consolidated'
    : consolidated === false
      ? 'non_consolidated'
      : hasExplicitNonConsolidated ? 'consolidated' : 'unknown'
  for (const [id, context] of contexts) {
    if (context.consolidation === 'unknown') {
      contexts.set(id, { ...context, consolidation: primaryConsolidation })
    }
  }

  const facts = completedFacts.map((fact): XbrlFact => {
    const value = fact.text.trim()
    return {
      qname: fact.qname,
      prefix: fact.prefix,
      localName: fact.localName,
      namespaceUri: fact.namespaceUri,
      contextRef: fact.contextRef,
      context: contexts.get(fact.contextRef) ?? null,
      unitRef: fact.unitRef,
      unit: fact.unitRef ? units.get(fact.unitRef) ?? null : null,
      decimals: fact.decimals,
      scale: fact.scale,
      sign: fact.sign,
      isNil: fact.isNil,
      value,
      textValue: normalizeXbrlText(value),
      numericValue: numericValue(value, fact),
    }
  })

  return { contexts, units, facts }
}
