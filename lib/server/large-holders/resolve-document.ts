import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { parseLargeHolderFiling, type LargeHolderFiling } from '@/lib/large-holders/filing'
import { downloadEdinetPublicXbrlWithCover, listEdinetDocuments, type EdinetDocumentIndexRow } from '@/lib/server/edinet-api'

export type SourcedLargeHolderFiling = {
  row: EdinetDocumentIndexRow
  filing: LargeHolderFiling
  xml: string
}

export function submissionDateHintFromCoverHtml(html: string | null): string | null {
  if (!html) return null
  const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, ' ').normalize('NFKC').trim())
  const labelIndex = cells.findIndex((cell) => cell === '【提出日】')
  if (labelIndex < 0) return null
  const match = cells[labelIndex + 1]?.match(/^(?:(\d{4})年|(令和|平成)(元|\d+)年)(\d{1,2})月(\d{1,2})日$/)
  if (!match) return null
  const year = match[1] ? Number(match[1])
    : (match[2] === '令和' ? 2018 : 1988) + (match[3] === '元' ? 1 : Number(match[3]))
  const month = Number(match[4])
  const day = Number(match[5])
  const result = new Date(Date.UTC(year, month - 1, day))
  if (result.getUTCFullYear() !== year || result.getUTCMonth() + 1 !== month || result.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// A correction's attached XBRL cover can retain the original filing date.
// HTML and archive dates are lookup hints only; the index supplies submittedAt.
export async function resolveLargeHolderDocument(
  documentId: string,
  indexCache = new Map<string, EdinetDocumentIndexRow[]>(),
): Promise<SourcedLargeHolderFiling> {
  if (!/^S[0-9A-Z]{7}$/.test(documentId)) throw new Error(`invalid_document_id:${documentId}`)
  const { xml, coverHtml, archiveDateHint } = await downloadEdinetPublicXbrlWithCover(documentId)
  const facts = new XbrlFactReader(xml).facts
  const filingDate = facts.find((fact) => fact.localName === 'FilingDateCoverPage'
    && !fact.context?.dimensions.length)?.textValue.trim()
  const isCorrection = facts.some((fact) => fact.localName === 'AmendmentFlagDEI' && fact.textValue === 'true')
  const coverDate = submissionDateHintFromCoverHtml(coverHtml)
  if (isCorrection && !coverDate && !archiveDateHint) {
    throw new Error(`correction_submission_date_not_evidenced:${documentId}`)
  }
  if (!isCorrection && coverDate && filingDate && coverDate !== filingDate) {
    throw new Error(`filing_date_disagreement:${documentId}`)
  }
  const candidateDates = [...new Set([coverDate, archiveDateHint, isCorrection ? null : filingDate]
    .filter((value): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)))]
  if (candidateDates.length === 0) {
    throw new Error(`filing_date_not_evidenced:${documentId}`)
  }
  for (const indexDate of candidateDates) {
    let index = indexCache.get(indexDate)
    if (!index) {
      index = await listEdinetDocuments(indexDate)
      indexCache.set(indexDate, index)
    }
    const row = index.find((entry) => entry.docID === documentId)
    if (!row) continue
    if (row.submitDateTime?.slice(0, 10) !== indexDate) {
      throw new Error(`index_submission_date_disagreement:${documentId}`)
    }
    return { row, xml, filing: parseLargeHolderFiling(row, xml) }
  }
  throw new Error(`index_record_unavailable:${documentId}:${candidateDates.join(',')}`)
}

export async function resolveCorrectionAncestors(
  filing: LargeHolderFiling,
  cache = new Map<string, EdinetDocumentIndexRow[]>(),
): Promise<SourcedLargeHolderFiling[]> {
  const result: SourcedLargeHolderFiling[] = []
  const visited = new Set([filing.documentId])
  let target = filing.filingType === 'AMENDMENT' ? filing.correctedDocumentId : null
  while (target) {
    if (visited.has(target) || visited.size > 16) throw new Error(`correction_cycle_or_depth:${target}`)
    visited.add(target)
    const source = await resolveLargeHolderDocument(target, cache)
    if (source.filing.issuerEdinetCode !== filing.issuerEdinetCode
        || source.filing.issuerSecurityCode !== filing.issuerSecurityCode
        || source.filing.submittedAt > filing.submittedAt) {
      throw new Error(`correction_origin_mismatch:${target}`)
    }
    result.unshift(source)
    target = source.filing.filingType === 'AMENDMENT' ? source.filing.correctedDocumentId : null
  }
  if (filing.filingType === 'AMENDMENT' && result.length === 0) {
    throw new Error(`correction_target_missing:${filing.documentId}`)
  }
  return result
}
