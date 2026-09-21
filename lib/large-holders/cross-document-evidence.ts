import { createHash } from 'node:crypto'
import { SaxesParser } from 'saxes'
import type { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { evidenceHash, type QuantityUnit } from './instrument-certification'

export const EDINET_CODE_LIST_URL =
  'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip'

export type EdinetCodeBridge = {
  edinetCode: string
  securityCode: string
  submitterName: string
  listingStatus: string
  snapshotDate: string
  sourceUrl: string
  archiveSha256: string
  sourceEvidence: string
  sourceHash: string
}

export type StatutorySecurityClass = {
  name: string
  kind: 'COMMON_STOCK' | 'PREFERRED_OR_CLASS_STOCK' | 'REIT_INVESTMENT_UNIT' | 'OTHER'
  dimension: string
  issuedUnits: number
  quantityUnit: QuantityUnit
  listedExchange: string | null
  listingDescription: string | null
  lotSize: number | null
}

export type IssuerCapitalStructure = {
  issuerEdinetCode: string
  sourceDocumentId: string
  sourceSubmittedAt: string
  reportingDate: string
  sourceUrl: string
  sourceEvidence: string
  sourceHash: string
  classes: StatutorySecurityClass[]
  tableComplete: boolean
}

export function verifyEdinetBridge(bridge: EdinetCodeBridge, issuerCode: string,
  securityCode: string, knowledgeCutoff: string): boolean {
  try {
    const evidence = JSON.parse(bridge.sourceEvidence) as { edinetCode: string;
      securityCode: string; submitterName: string; listingStatus: string;
      snapshotDate: string; archiveSha256: string }
    return bridge.sourceUrl === EDINET_CODE_LIST_URL
      // The list gives a date, not a publication time; same-day use could leak.
      && bridge.snapshotDate < knowledgeCutoff.slice(0, 10)
      && bridge.edinetCode === issuerCode && bridge.securityCode === securityCode
      && bridge.listingStatus === '上場'
      && evidence.edinetCode === bridge.edinetCode && evidence.securityCode === bridge.securityCode
      && evidence.submitterName === bridge.submitterName
      && evidence.listingStatus === bridge.listingStatus
      && evidence.snapshotDate === bridge.snapshotDate
      && evidence.archiveSha256 === bridge.archiveSha256
      && /^[a-f0-9]{64}$/.test(bridge.archiveSha256)
      && evidenceHash(evidence) === bridge.sourceHash
  } catch { return false }
}

export function verifyCapitalStructureSource(structure: IssuerCapitalStructure, issuerCode: string): boolean {
  try {
    const evidence = JSON.parse(structure.sourceEvidence) as { issuerEdinetCode: string;
      sourceDocumentId: string; sourceSubmittedAt: string; reportingDate: string;
      xbrlSha256: string; tableSha256: string; classes: StatutorySecurityClass[]; tableComplete: boolean }
    return structure.issuerEdinetCode === issuerCode
      && structure.sourceUrl.startsWith('https://disclosure2.edinet-fsa.go.jp/')
      && evidence.issuerEdinetCode === issuerCode
      && evidence.sourceDocumentId === structure.sourceDocumentId
      && evidence.sourceSubmittedAt === structure.sourceSubmittedAt
      && evidence.reportingDate === structure.reportingDate
      && /^[a-f0-9]{64}$/.test(evidence.xbrlSha256)
      && /^[a-f0-9]{64}$/.test(evidence.tableSha256)
      && evidence.tableComplete === structure.tableComplete
      && JSON.stringify(evidence.classes) === JSON.stringify(structure.classes)
      && structure.classes.length > 0
      && structure.classes.every((entry) => Number.isSafeInteger(entry.issuedUnits)
        && entry.issuedUnits > 0)
      && evidenceHash(evidence) === structure.sourceHash
  } catch { return false }
}

export function verifyCapitalStructure(structure: IssuerCapitalStructure, issuerCode: string,
  knowledgeCutoff: string): boolean {
  return verifyCapitalStructureSource(structure, issuerCode)
    && structure.sourceSubmittedAt <= knowledgeCutoff
    && structure.reportingDate <= knowledgeCutoff.slice(0, 10)
    && structure.tableComplete
    && structure.classes.every((entry) => entry.listingDescription != null)
}

// The issued-securities table is XHTML inside the statutory XBRL text block.
// Reject malformed or non-tabular disclosures instead of guessing from prose.
function tableRows(xhtml: string): string[][] | null {
  const parser = new SaxesParser({ xmlns: false })
  const rows: string[][] = []
  let row: string[] | null = null
  let cell: string | null = null
  parser.on('opentag', (tag) => {
    if (tag.name.toLowerCase() === 'tr') row = []
    if (row && /^(td|th)$/i.test(tag.name)) cell = ''
  })
  parser.on('text', (value) => { if (cell != null) cell += value })
  parser.on('closetag', (tag) => {
    if (/^(td|th)$/i.test(tag.name) && row && cell != null) {
      row.push(cell.normalize('NFKC').replace(/\s+/g, ' ').trim())
      cell = null
    }
    if (tag.name.toLowerCase() === 'tr' && row) { rows.push(row); row = null }
  })
  try { parser.write(`<root>${xhtml}</root>`).close(); return rows.length ? rows : null }
  catch { return null }
}

function classKind(name: string): StatutorySecurityClass['kind'] {
  if (/普通株式/.test(name)) return 'COMMON_STOCK'
  if (/優先株|種類株/.test(name)) return 'PREFERRED_OR_CLASS_STOCK'
  if (/投資口|投資証券/.test(name)) return 'REIT_INVESTMENT_UNIT'
  return 'OTHER'
}

export function extractStockCapitalStructure(reader: XbrlFactReader, source: {
  issuerEdinetCode: string; sourceDocumentId: string; sourceSubmittedAt: string; xbrlXml: string
}): IssuerCapitalStructure | null {
  const block = reader.facts.find((fact) => fact.localName === 'IssuedSharesTotalNumberOfSharesEtcTextBlock'
    && fact.contextRef === 'FilingDateInstant' && !fact.isNil)
  if (!block) return null
  const rows = tableRows(block.value)
  if (!rows) return null
  const classFacts = reader.facts.filter((fact) =>
    fact.localName === 'ClassIssuedSharesTotalNumberOfSharesEtc'
    && fact.contextRef.startsWith('FilingDateInstant_') && !fact.isNil)
  const classes: StatutorySecurityClass[] = []
  for (const fact of classFacts) {
    const dimension = fact.context?.dimensions.find((d) => d.dimension.endsWith('ClassesOfSharesAxis'))?.member
    const units = reader.facts.find((candidate) =>
      candidate.localName === 'NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc'
      && candidate.contextRef === fact.contextRef && candidate.unit?.label === 'xbrli:shares')
    if (!dimension || !units || !Number.isSafeInteger(units.numericValue) || units.numericValue! <= 0) return null
    const name = fact.textValue.normalize('NFKC').trim()
    const matchingRows = rows.filter((row) => row[0]?.replace(/\s+/g, '') === name.replace(/\s+/g, ''))
    if (matchingRows.length !== 1 || matchingRows[0].length < 4) return null
    const listingDescription = matchingRows[0].at(-2) || null
    const description = matchingRows[0].at(-1) ?? ''
    const lot = description.match(/単元株式数\s*([\d,]+)\s*株/)
    classes.push({ name, kind: classKind(name), dimension, issuedUnits: units.numericValue!,
      quantityUnit: 'SHARE', listedExchange: listingDescription && /証券取引所/.test(listingDescription)
        ? listingDescription : null, listingDescription,
      lotSize: lot ? Number(lot[1].replaceAll(',', '')) : null })
  }
  const dataRows = rows.filter((row) => row.length >= 4 && row[0] && row[0] !== '種類'
    && row[0] !== '計' && /\d/.test(row[1] ?? ''))
  const tableComplete = classes.length > 0 && classes.length === dataRows.length
    && new Set(classes.map((entry) => entry.dimension)).size === classes.length
  const evidence = { issuerEdinetCode: source.issuerEdinetCode,
    sourceDocumentId: source.sourceDocumentId, sourceSubmittedAt: source.sourceSubmittedAt,
    reportingDate: source.sourceSubmittedAt.slice(0, 10),
    xbrlSha256: createHash('sha256').update(source.xbrlXml).digest('hex'),
    tableSha256: createHash('sha256').update(block.value).digest('hex'), classes, tableComplete }
  return { issuerEdinetCode: source.issuerEdinetCode, sourceDocumentId: source.sourceDocumentId,
    sourceSubmittedAt: source.sourceSubmittedAt, reportingDate: evidence.reportingDate,
    sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${source.sourceDocumentId}`,
    sourceEvidence: JSON.stringify(evidence), sourceHash: evidenceHash(evidence), classes, tableComplete }
}

export function extractReitCapitalStructure(reader: XbrlFactReader, source: {
  issuerEdinetCode: string; sourceDocumentId: string; sourceSubmittedAt: string; xbrlXml: string
}): IssuerCapitalStructure | null {
  const block = reader.facts.find((fact) =>
    fact.localName === 'PaidInCapitalOfInvestmentCorporationTextBlock'
    && fact.contextRef === 'FilingDateInstant' && !fact.isNil)
  const securityCode = reader.facts.find((fact) => fact.localName === 'SecurityCodeDEI')?.textValue
  if (!block || !/^[0-9A-Z]{5}$/.test(securityCode ?? '')) return null
  const matches = [...block.textValue.normalize('NFKC').matchAll(/発行済投資口の総口数\s*([\d,]+)\s*口/g)]
  if (matches.length !== 1) return null
  const issuedUnits = Number(matches[0][1].replaceAll(',', ''))
  if (!Number.isSafeInteger(issuedUnits) || issuedUnits <= 0) return null
  const classes: StatutorySecurityClass[] = [{ name: '投資口', kind: 'REIT_INVESTMENT_UNIT',
    dimension: `EDINET:${securityCode}`, issuedUnits, quantityUnit: 'UNIT',
    listedExchange: null, listingDescription: null, lotSize: 1 }]
  // The issuer's capital block does not itself prove exchange listing or a
  // unique listed instrument. Keep this evidence available but not certifiable.
  const tableComplete = false
  const evidence = { issuerEdinetCode: source.issuerEdinetCode,
    sourceDocumentId: source.sourceDocumentId, sourceSubmittedAt: source.sourceSubmittedAt,
    reportingDate: source.sourceSubmittedAt.slice(0, 10),
    xbrlSha256: createHash('sha256').update(source.xbrlXml).digest('hex'),
    tableSha256: createHash('sha256').update(block.value).digest('hex'), classes, tableComplete }
  return { issuerEdinetCode: source.issuerEdinetCode, sourceDocumentId: source.sourceDocumentId,
    sourceSubmittedAt: source.sourceSubmittedAt, reportingDate: evidence.reportingDate,
    sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${source.sourceDocumentId}`,
    sourceEvidence: JSON.stringify(evidence), sourceHash: evidenceHash(evidence), classes, tableComplete }
}
