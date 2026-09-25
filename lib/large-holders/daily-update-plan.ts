import { isLargeHolderDocument } from './filing'
import type { EdinetDocumentIndexRow } from '@/lib/server/edinet-api'
import { SOURCE_QUARANTINE_STATUS } from './source-quarantine'

export type StoredLargeHolderDocument = {
  parserVersion: string
  status: string
  submittedAt: string | null
  withdrawnAt: string | null
}

export function planLargeHolderIndexDay(rows: EdinetDocumentIndexRow[],
  stored: Map<string, StoredLargeHolderDocument>, parserVersion: string) {
  const documents = rows.filter(isLargeHolderDocument)
  const missing: string[] = [], changed: string[] = [], withdrawals: string[] = []
  for (const row of rows) {
    const target = row.withdrawalStatus === '1' ? row.parentDocID
      : row.withdrawalStatus === '2' ? row.docID : null
    const timestamp = row.withdrawalStatus === '1' ? row.submitDateTime : row.opeDateTime
    if (target && timestamp && stored.has(target)
      && stored.get(target)!.withdrawnAt !== timestamp) withdrawals.push(target)
  }
  for (const row of documents) {
    const previous = stored.get(row.docID)
    if (!previous) missing.push(row.docID)
    else if (previous.status === 'failed' || previous.status === SOURCE_QUARANTINE_STATUS
      || previous.status === 'review_required_source_inconsistency'
      || previous.parserVersion !== parserVersion
      || previous.submittedAt !== row.submitDateTime) changed.push(row.docID)
  }
  return { missing, changed, withdrawals, largeHolderDocuments: documents.length,
    changedDay: Boolean(missing.length || changed.length || withdrawals.length) }
}
