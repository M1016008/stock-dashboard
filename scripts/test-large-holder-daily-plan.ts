import assert from 'node:assert/strict'
import { planLargeHolderIndexDay, type StoredLargeHolderDocument } from '@/lib/large-holders/daily-update-plan'
import type { EdinetDocumentIndexRow } from '@/lib/server/edinet-api'

const parserVersion = '16a6-1'
const filing = (docID: string): EdinetDocumentIndexRow => ({ docID, docTypeCode: '350',
  xbrlFlag: '1', withdrawalStatus: '0', disclosureStatus: '0',
  submitDateTime: '2026-09-22 16:00:00' })
const stored = new Map<string, StoredLargeHolderDocument>([
  ['READY', { parserVersion, status: 'ready', submittedAt: filing('READY').submitDateTime!, withdrawnAt: null }],
  ['REVIEW', { parserVersion, status: 'review', submittedAt: filing('REVIEW').submitDateTime!, withdrawnAt: null }],
  ['OLD', { parserVersion: 'old', status: 'ready', submittedAt: filing('OLD').submitDateTime!, withdrawnAt: null }],
  ['FAILED', { parserVersion, status: 'failed', submittedAt: filing('FAILED').submitDateTime!, withdrawnAt: null }],
  ['QUARANTINED', { parserVersion, status: 'quarantined_source_inconsistency',
    submittedAt: filing('QUARANTINED').submitDateTime!, withdrawnAt: null }],
])
const unchanged = planLargeHolderIndexDay([filing('READY'), filing('REVIEW')], stored, parserVersion)
assert.equal(unchanged.changedDay, false)
assert.deepEqual(unchanged.changed, [])
const update = planLargeHolderIndexDay([filing('NEW'), filing('OLD'), filing('FAILED'), filing('QUARANTINED'),
  { docID: 'WITHDRAW', withdrawalStatus: '1', parentDocID: 'READY',
    submitDateTime: '2026-09-22 17:00:00' }], stored, parserVersion)
assert.deepEqual(update.missing, ['NEW'])
assert.deepEqual(update.changed, ['OLD', 'FAILED', 'QUARANTINED'])
assert.deepEqual(update.withdrawals, ['READY'])
assert.equal(update.largeHolderDocuments, 4)
assert.equal(update.changedDay, true)
const sameWithdrawal = new Map(stored)
sameWithdrawal.set('READY', { ...sameWithdrawal.get('READY')!, withdrawnAt: '2026-09-22 17:00:00' })
assert.deepEqual(planLargeHolderIndexDay([{ docID: 'WITHDRAW', withdrawalStatus: '1',
  parentDocID: 'READY', submitDateTime: '2026-09-22 17:00:00' }], sameWithdrawal, parserVersion).withdrawals, [])
console.log('large-holder daily index plan: PASS')
