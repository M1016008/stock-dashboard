import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'
import {
  parseCompanyOverview,
  parseEmployeeInformation,
  parseMajorShareholders,
  parseOfficerInformation,
  parsePolicyHoldings,
  parseSegmentInformation,
} from '@/lib/edinet-xbrl'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'

const API_BASE = 'https://api.edinet-fsa.go.jp/api/v2'
const TOYOTA_SECURITY_CODE = '72030'
const TOYOTA_EDINET_CODE = 'E02144'
const REPORT_DATE = '2026-06-10'

type EdinetDocument = {
  docID: string
  edinetCode?: string | null
  secCode?: string | null
  docTypeCode?: string | null
  submitDateTime?: string | null
  periodEnd?: string | null
  withdrawalStatus?: string | null
  xbrlFlag?: string | null
}

async function fetchToyotaAnnualReport(apiKey: string): Promise<EdinetDocument> {
  const params = new URLSearchParams({
    date: REPORT_DATE,
    type: '2',
    'Subscription-Key': apiKey,
  })
  const response = await fetch(`${API_BASE}/documents.json?${params}`)
  assert.equal(response.status, 200, `EDINET documents HTTP ${response.status}`)
  const payload = await response.json() as { results?: EdinetDocument[] }
  const document = payload.results?.find((row) => (
    row.secCode === TOYOTA_SECURITY_CODE
    && row.edinetCode === TOYOTA_EDINET_CODE
    && row.docTypeCode === '120'
    && row.withdrawalStatus !== '1'
    && row.xbrlFlag === '1'
  ))
  assert.ok(document, '7203 Toyota annual report was not found')
  return document
}

async function downloadXbrl(documentId: string, apiKey: string): Promise<string> {
  const params = new URLSearchParams({ type: '1', 'Subscription-Key': apiKey })
  const response = await fetch(`${API_BASE}/documents/${encodeURIComponent(documentId)}?${params}`)
  assert.equal(response.status, 200, `EDINET document HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const files = unzipSync(bytes, {
    filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name),
  })
  const xbrl = Object.entries(files).sort((a, b) => b[1].byteLength - a[1].byteLength)[0]
  assert.ok(xbrl, 'PublicDoc XBRL was not found')
  return new TextDecoder('utf-8').decode(xbrl[1])
}

async function main() {
  const apiKey = process.env.EDINET_API_KEY?.trim()
  assert.ok(apiKey, 'EDINET_API_KEY is not configured')

  const document = await fetchToyotaAnnualReport(apiKey)
  const xml = await downloadXbrl(document.docID, apiKey)
  const reader = new XbrlFactReader(xml)
  const major = parseMajorShareholders(reader)
  const policy = parsePolicyHoldings(reader)
  const company = parseCompanyOverview(reader)
  const employees = parseEmployeeInformation(reader)
  const officerInformation = parseOfficerInformation(reader)
  const segmentInformation = parseSegmentInformation(reader)

  assert.ok(reader.contexts.size > 0, 'XBRL contexts were not parsed')
  assert.ok(reader.units.size > 0, 'XBRL units were not parsed')
  assert.ok(reader.facts.length > 0, 'XBRL facts were not parsed')
  assert.equal(major.length, 10, 'Toyota major shareholder count changed')
  assert.ok(policy.length > 0, 'Toyota policy holdings were not parsed')
  assert.ok(policy.every((row) => row.issuerName && row.holdingType), 'Policy holding identity is incomplete')
  assert.ok(policy.some((row) => row.shares != null && row.bookValue != null), 'Policy holding numeric facts are missing')
  assert.ok(company.businessDescription?.text, 'Toyota business description was not parsed')
  assert.ok(company.companyHistory?.text, 'Toyota company history was not parsed')
  assert.ok(company.businessPolicy?.text, 'Toyota business policy was not parsed')
  assert.equal(employees.consolidated?.employeeCount, 390_927, 'Toyota consolidated employee count changed')
  assert.equal(employees.nonConsolidated?.employeeCount, 73_133, 'Toyota employee count changed')
  assert.equal(employees.nonConsolidated?.averageAgeYears, 40.5, 'Toyota average age changed')
  assert.equal(
    employees.nonConsolidated?.averageLengthOfServiceYears,
    15.1,
    'Toyota average length of service changed',
  )
  assert.equal(
    employees.nonConsolidated?.averageAnnualSalary,
    10_060_464,
    'Toyota average annual salary changed',
  )
  assert.equal(officerInformation.officers.length, 10, 'Toyota officer count changed')
  assert.ok(
    officerInformation.officers.every((officer) => officer.name && officer.role),
    'Toyota officer identity is incomplete',
  )
  assert.equal(segmentInformation.accountingFramework, 'IFRS')
  assert.equal(segmentInformation.periodEnd, '2026-03-31')
  assert.equal(segmentInformation.segments.length, 4, 'Toyota segment row count changed')
  const automotiveSegment = segmentInformation.segments
    .find((segment) => segment.name === '自動車')
  const financialSegment = segmentInformation.segments
    .find((segment) => segment.name === '金融')
  const otherSegment = segmentInformation.segments
    .find((segment) => segment.kind === 'other')
  const adjustmentSegment = segmentInformation.segments
    .find((segment) => segment.kind === 'adjustment')
  assert.equal(automotiveSegment?.revenue?.value, 45_417_703_000_000)
  assert.equal(automotiveSegment?.externalRevenue?.value, 45_201_924_000_000)
  assert.equal(automotiveSegment?.intersegmentRevenue?.value, 215_779_000_000)
  assert.equal(automotiveSegment?.profitLoss?.value, 2_777_049_000_000)
  assert.equal(automotiveSegment?.assets?.value, 33_182_372_000_000)
  assert.equal(automotiveSegment?.depreciation?.value, 1_417_242_000_000)
  assert.equal(automotiveSegment?.capitalExpenditure?.value, 2_453_641_000_000)
  assert.ok(financialSegment, 'Toyota financial segment was not parsed')
  assert.ok(otherSegment, 'Toyota other segment was not parsed')
  assert.ok(adjustmentSegment, 'Toyota adjustment segment was not parsed')
  assert.ok(
    [automotiveSegment, financialSegment, otherSegment, adjustmentSegment]
      .every((segment) => segment?.consolidation === 'consolidated'),
    'Toyota segment consolidation scope is incorrect',
  )
  assert.equal(segmentInformation.geographicAreas.length, 3)
  assert.equal(
    segmentInformation.geographicAreas.find((area) => area.name === '日本')?.revenue.value,
    10_985_614_000_000,
  )
  assert.equal(segmentInformation.geographicRevenueTotal?.value, 50_684_952_000_000)
  assert.equal(segmentInformation.majorCustomers.length, 0)

  const consolidation = [...reader.contexts.values()].reduce<Record<string, number>>((counts, context) => {
    counts[context.consolidation] = (counts[context.consolidation] ?? 0) + 1
    return counts
  }, {})
  const holdingTypes = policy.reduce<Record<string, number>>((counts, row) => {
    const type = row.holdingType ?? 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
    return counts
  }, {})
  assert.equal(policy.length, 37, 'Toyota policy holding count changed')
  assert.deepEqual(holdingTypes, { 'みなし保有': 5, '特定投資株式': 32 })

  const officerFieldCoverage = {
    name: officerInformation.officers.filter((officer) => officer.name).length,
    role: officerInformation.officers.filter((officer) => officer.role).length,
    biography: officerInformation.officers.filter((officer) => officer.biography).length,
    term: officerInformation.officers.filter((officer) => officer.term).length,
    sharesHeld: officerInformation.officers.filter((officer) => officer.sharesHeld != null).length,
    outside: officerInformation.officers.filter((officer) => officer.outside != null).length,
    independent: officerInformation.officers.filter((officer) => officer.independent != null).length,
    outsideDirectors: officerInformation.officers.filter((officer) => officer.outside === true).length,
    independentOfficers: officerInformation.officers
      .filter((officer) => officer.independent === true).length,
  }
  assert.deepEqual(officerFieldCoverage, {
    name: 10,
    role: 10,
    biography: 10,
    term: 10,
    sharesHeld: 10,
    outside: 10,
    independent: 10,
    outsideDirectors: 5,
    independentOfficers: 5,
  })
  const compactName = (name: string) => name.normalize('NFKC').replace(/\s+/g, '')
  const outsideDirectorNames = officerInformation.officers
    .filter((officer) => officer.outside === true)
    .map((officer) => compactName(officer.name))
    .sort()
  assert.deepEqual(outsideDirectorNames, [
    'GeorgeOlcott',
    '大島眞彦',
    '岡本薫明',
    '藤沢久美',
    '長田弘己',
  ].sort())
  const inferredZeroShareNames = officerInformation.officers
    .filter((officer) => officer.sharesSource === 'table_dash')
    .map((officer) => compactName(officer.name))
  assert.deepEqual(inferredZeroShareNames, ['ChristopherP.Reynolds'])

  const summarizeNarrative = (fact: { text: string } | null) => fact ? ({
    characters: fact.text.length,
    sample: fact.text.slice(0, 120),
  }) : null

  console.log(JSON.stringify({
    ticker: '7203',
    edinetCode: document.edinetCode,
    documentId: document.docID,
    submittedAt: document.submitDateTime,
    periodEnd: document.periodEnd,
    contexts: reader.contexts.size,
    units: reader.units.size,
    facts: reader.facts.length,
    consolidation,
    majorShareholders: major.length,
    policyHoldings: policy.length,
    holdingTypes,
    company: {
      businessDescription: summarizeNarrative(company.businessDescription),
      companyHistory: summarizeNarrative(company.companyHistory),
      businessPolicy: summarizeNarrative(company.businessPolicy),
      basicDescriptionTextBlocks: company.basicDescriptionTextBlocks.length,
    },
    employees,
    officers: {
      count: officerInformation.officers.length,
      fieldCoverage: officerFieldCoverage,
      outsideDirectorNames,
      inferredZeroShareNames,
      missingSharesHeld: officerInformation.officers
        .filter((officer) => officer.sharesHeld == null)
        .map((officer) => officer.name),
      samples: officerInformation.officers.slice(0, 2).map((officer) => ({
        name: officer.name,
        role: officer.role,
        biography: officer.biography?.slice(0, 120) ?? null,
        term: officer.term,
        sharesHeld: officer.sharesHeld,
        sharesSource: officer.sharesSource,
        outside: officer.outside,
        outsideSource: officer.outsideSource,
        independent: officer.independent,
        independentSource: officer.independentSource,
      })),
      outsideOfficerNarrative: summarizeNarrative(officerInformation.outsideOfficerNarrative),
    },
    segmentInformation: {
      periodEnd: segmentInformation.periodEnd,
      accountingFramework: segmentInformation.accountingFramework,
      segmentCount: segmentInformation.segments.length,
      segments: segmentInformation.segments.map((segment) => ({
        name: segment.name,
        kind: segment.kind,
        member: segment.member,
        revenue: segment.revenue?.value ?? null,
        externalRevenue: segment.externalRevenue?.value ?? null,
        intersegmentRevenue: segment.intersegmentRevenue?.value ?? null,
        profitLoss: segment.profitLoss?.value ?? null,
        assets: segment.assets?.value ?? null,
        depreciation: segment.depreciation?.value ?? null,
        capitalExpenditure: segment.capitalExpenditure?.value ?? null,
        unit: segment.revenue?.unit
          ?? segment.externalRevenue?.unit
          ?? segment.assets?.unit
          ?? null,
      })),
      geographicAreas: segmentInformation.geographicAreas.map((area) => ({
        name: area.name,
        kind: area.kind,
        revenue: area.revenue.value,
        unit: area.revenue.unit,
        source: area.source,
      })),
      geographicRevenueTotal: segmentInformation.geographicRevenueTotal?.value ?? null,
      majorCustomers: segmentInformation.majorCustomers,
      segmentNarrative: summarizeNarrative(segmentInformation.segmentNarrative),
      geographicNarrative: summarizeNarrative(segmentInformation.geographicNarrative),
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
