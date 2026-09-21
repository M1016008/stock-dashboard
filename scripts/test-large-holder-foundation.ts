import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EdinetDocumentIndexRow } from '@/lib/server/edinet-api'
import { parseLargeHolderFiling } from '@/lib/large-holders/filing'
import { regimeForObligationDate } from '@/lib/large-holders/filing'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'
import { CORRECTION_PREDECESSOR_ADJUDICATIONS } from '@/lib/large-holders/revision-adjudications'
import { assessMarketPriceHolding, type MarketPriceEvidence } from '@/lib/large-holders/market-price-eligibility'
import { classifyFromFiling } from '@/lib/large-holders/classification'
import { submissionDateHintFromCoverHtml } from '@/lib/server/large-holders/resolve-document'

const dir = mkdtempSync(path.join(tmpdir(), 'stockboard-large-holders-'))
process.env.USE_LOCAL_DB = '1'
process.env.STOCKBOARD_DB_PATH = path.join(dir, 'test.db')

const member = (n: number) => `Holder${n}Member`
const context = (id: string, n?: number) => `<xbrli:context id="${id}">
  <xbrli:entity><xbrli:identifier scheme="edinet">E00001</xbrli:identifier>${n ? `<xbrli:segment>
    <xbrldi:explicitMember dimension="jplvh_cor:FilersLargeVolumeHoldersAndJointHoldersAxis">jplvh:${member(n)}</xbrldi:explicitMember>
  </xbrli:segment>` : ''}</xbrli:entity>
  <xbrli:period><xbrli:instant>2026-09-17</xbrli:instant></xbrli:period>
</xbrli:context>`
const field = (tag: string, ctx: string, value: string) => `<jplvh:${tag} contextRef="${ctx}"${/Article27233/.test(tag) ? ' unitRef="shares"' : ''}>${value}</jplvh:${tag}>`
function xbrl(mixed = false, submissionCount = 1): string {
  const primary = 'FilingDateInstant_Holder1Member'
  const joint = 'FilingDateInstant_Holder2Member'
  return `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:jplvh="https://example.test/jplvh"
      xmlns:jplvh_cor="https://example.test/jplvh-cor">
    ${context('FilingDateInstant')}${context(primary, 1)}${context(joint, 2)}
    <xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
    ${field('NameOfIssuer', 'FilingDateInstant', '発行会社')}
    ${field('SecurityCodeOfIssuer', 'FilingDateInstant', '7003')}
    ${field('FilerNameInJapaneseDEI', 'FilingDateInstant', '試験 太郎')}
    ${field('NumberOfSubmissionDEI', 'FilingDateInstant', String(submissionCount))}
    ${field('DocumentTitleCoverPage', 'FilingDateInstant', '変更報告書 No.2')}
    ${field('ListedOrOTC', 'FilingDateInstant', '上場')}
    ${field('StockListing', 'FilingDateInstant', '東京')}
    ${field('DateWhenFilingRequirementAroseCoverPage', 'FilingDateInstant', '2026-09-16')}
    ${field('BaseDate', 'FilingDateInstant', '2026-09-16')}
    ${field('TotalNumberOfFilersAndJointHoldersCoverPage', 'FilingDateInstant', '2')}
    ${field('TotalNumberOfStocksEtcHeld', 'FilingDateInstant', '1500')}
    ${field('HoldingRatioOfShareCertificatesEtc', 'FilingDateInstant', '0.075')}
    ${field('Name', primary, '試験 太郎')}
    ${field('IndividualOrCorporation', primary, '個人')}
    ${field('ResidentialAddressOrAddressOfRegisteredHeadquarter', primary, '東京都Ａ区')}
    ${field('BaseDate', primary, '2026-09-16')}
    ${field('TotalNumberOfStocksEtcHeld', primary, '1000')}
    ${field('StocksOrInvestmentSecuritiesEtcArticle27233MainClause', primary, '1000')}
    ${field('HoldingRatioOfShareCertificatesEtc', primary, '0.05')}
    ${field('HoldingRatioOfShareCertificatesEtcPerLastReport', primary, '0.045')}
    ${field('Name', joint, '試験株式会社')}
    ${field('IndividualOrCorporation', joint, '法人（株式会社）')}
    ${field('ResidentialAddressOrAddressOfRegisteredHeadquarter', joint, '東京都Ｂ区')}
    ${field('TotalNumberOfStocksEtcHeld', joint, '500')}
    ${field('StocksOrInvestmentSecuritiesEtcArticle27233MainClause', joint, String(mixed ? 200 : 500))}
    ${mixed ? field('StocksOrInvestmentSecuritiesEtcArticle27233Item2', joint, '300') : ''}
    ${field('HoldingRatioOfShareCertificatesEtc', joint, '0.025')}
  </xbrli:xbrl>`
}

const row: EdinetDocumentIndexRow = {
  docID: 'S100TEST1',
  docTypeCode: '350',
  docDescription: '変更報告書',
  submitDateTime: '2026-09-17 09:00',
  edinetCode: 'E00001',
  xbrlFlag: '1',
  withdrawalStatus: '0',
}

async function main() {
  const cover = (date: string) => `<table><tr><td class="Item">【提出日】</td><td class="Ivalue">${date}</td></tr></table>`
  assert.equal(submissionDateHintFromCoverHtml(cover('令和8年5月1日')), '2026-05-01')
  assert.equal(submissionDateHintFromCoverHtml(cover('2026年9月14日')), '2026-09-14')
  assert.equal(submissionDateHintFromCoverHtml(cover('平成31年4月30日')), '2019-04-30')
  assert.equal(submissionDateHintFromCoverHtml(cover('2026年2月30日')), null)
  assert.equal(submissionDateHintFromCoverHtml(cover('該当事項なし')), null)
  assert.equal(regimeForObligationDate('2026-04-30'), 'LEGACY_PRE_2026_05_01')
  assert.equal(regimeForObligationDate('2026-05-01'), 'CURRENT_2026_05_01_PLUS')
  assert.equal(regimeForObligationDate(null), 'UNKNOWN')
  const filing = parseLargeHolderFiling(row, xbrl())
  assert.equal(filing.issuerSecurityCode, '7003')
  assert.equal(filing.issuerExchange, '東京')
  assert.equal(filing.issuerEvidence.securityCode?.concept, 'jplvh:SecurityCodeOfIssuer')
  assert.equal(filing.issuerEvidence.securityCode?.context, 'FilingDateInstant')
  assert.equal(filing.issuerEvidence.exchange?.value, '東京')
  assert.match(filing.issuerEvidence.sourceDocumentHash, /^[a-f0-9]{64}$/)
  assert.equal(filing.obligationDate, '2026-09-16')
  assert.equal(filing.filingType, 'CHANGE')
  assert.equal(filing.reportSerialNumber, 2)
  assert.equal(filing.submissionCount, 1)
  assert.equal(parseLargeHolderFiling({ ...row, parentDocID: 'S100PRIOR' }, xbrl()).correctedDocumentId, null)
  assert.equal(filing.holders.length, 2)
  assert.deepEqual(filing.holders.map((holder) => holder.role), ['PRIMARY', 'JOINT'])
  assert.deepEqual(filing.holders.map((holder) => holder.shares), [1000, 500])
  assert.deepEqual(filing.holders.map((holder) => holder.holdingPct), [5, 2.5])
  assert.equal(filing.groupShares, 1500)
  assert.equal(filing.holders[0].previousHoldingPct, 4.5)
  assert.equal(filing.holders[0].valuationEligibleShares, null)
  assert.equal(filing.holders[0].valuationStatus, 'NOT_PROVEN')
  assert.equal(filing.schemaRegime, 'CURRENT_2026_05_01_PLUS')
  assert.equal(parseLargeHolderFiling({ ...row, submitDateTime: '2026-09-17 09:00' },
    xbrl().replaceAll('2026-09-16', '2026-04-30')).schemaRegime, 'LEGACY_PRE_2026_05_01')
  const legacyInstrument = xbrl(true).replaceAll('2026-09-16', '2026-04-30')
  const currentInstrument = xbrl(true).replace('</xbrli:xbrl>',
    `${field('ShareAcquisitionRightsOrInvestmentUnitAcquisitionRightsEtcArticle27233Item3',
      'FilingDateInstant_Holder2Member', '50')}</xbrli:xbrl>`)
  assert.ok(parseLargeHolderFiling(row, legacyInstrument).holders[1].securityComponents.some(
    (item) => item.concept.includes('Article27233Item2')))
  assert.ok(parseLargeHolderFiling(row, currentInstrument).holders[1].securityComponents.some(
    (item) => item.concept.includes('Article27233Item3')))
  const withExplicitNote = xbrl().replace('</xbrli:xbrl>',
    `${field('NotesNumberOfStocksEtcHeldTextBlock', 'FilingDateInstant_Holder1Member', '普通株式 1,000株')}</xbrli:xbrl>`)
  const proven = parseLargeHolderFiling(row, withExplicitNote).holders[0]
  assert.equal(proven.valuationEligibleShares, 1000)
  assert.equal(proven.valuationStatus, 'PROVEN_COMMON_SHARE')
  assert.equal(proven.valuationEvidence[0].quantity, 1000)
  const partialNote = xbrl(true).replace('</xbrli:xbrl>',
    `${field('NotesNumberOfStocksEtcHeldTextBlock', 'FilingDateInstant_Holder2Member', '普通株式 150株')}</xbrli:xbrl>`)
  assert.equal(parseLargeHolderFiling(row, partialNote).holders[1].valuationStatus, 'PARTIAL')
  assert.equal(parseLargeHolderFiling(row, partialNote).holders[1].valuationEligibleShares, 150)
  const transactionOnly = xbrl().replace('</xbrli:xbrl>',
    `${field('DetailsOfAcquisitionsAndDisposalsOfStocksEtcIssuedByIssuerOfSaidStocksEtcDuringLast60DaysTextBlock',
      'FilingDateInstant_Holder1Member', '普通株式 1,000株')}</xbrli:xbrl>`)
  assert.equal(parseLargeHolderFiling(row, transactionOnly).holders[0].valuationEligibleShares, null)
  assert.equal(parseLargeHolderFiling(row, xbrl(true)).holders[1].ordinaryShareCandidate, null)
  const priceEvidence: MarketPriceEvidence = {
    issuerCodeMatches: true, uniquePriceInstrument: true, listedAtReference: true,
    priceDate: '2026-09-16', close: 1234, classAmbiguous: false,
  }
  const full = assessMarketPriceHolding(filing.holders[0], priceEvidence)
  assert.equal(full.status, 'FULL_DIRECT')
  assert.equal(full.eligibleUnits, 1000)
  assert.equal(full.basisUnits.OWNERSHIP_LIKE, 1000)
  const withPotential = xbrl(true).replace('</xbrli:xbrl>',
    `${field('ConvertibleBondsArticle27233MainClause', 'FilingDateInstant_Holder2Member', '12')}</xbrli:xbrl>`)
  const mixedHolder = parseLargeHolderFiling(row, withPotential).holders[1]
  assert.equal(mixedHolder.securityBreakdown.find((part) => part.kind === 'CONVERTIBLE_BOND')?.quantity, 12)
  assert.equal(assessMarketPriceHolding(mixedHolder, priceEvidence).status, 'AMBIGUOUS')
  const directPartial = parseLargeHolderFiling(row, xbrl(true).replace('</xbrli:xbrl>',
    `${field('ConvertibleBondsArticle27233MainClause', 'FilingDateInstant_Holder1Member', '50')}</xbrli:xbrl>`)).holders[0]
  assert.equal(assessMarketPriceHolding(directPartial, priceEvidence).status, 'PARTIAL_DIRECT')
  assert.equal(assessMarketPriceHolding(directPartial, priceEvidence).eligibleUnits, 1000)
  const deducted = parseLargeHolderFiling(row, xbrl().replace('</xbrli:xbrl>',
    `${field('NumberOfStocksEtcToDeductAsRightsToDemandExistBetweenJointHolders',
      'FilingDateInstant_Holder1Member', '50')}</xbrli:xbrl>`)).holders[0]
  assert.equal(assessMarketPriceHolding(deducted, priceEvidence).reason, 'unallocated_legal_deduction')
  assert.equal(assessMarketPriceHolding(filing.holders[0], { ...priceEvidence, priceDate: null }).eligibleUnits, null)
  assert.equal(assessMarketPriceHolding(filing.holders[0], {
    ...priceEvidence, issuerCodeMatches: false,
  }).status, 'AMBIGUOUS')
  assert.equal(assessMarketPriceHolding(filing.holders[0], { ...priceEvidence, classAmbiguous: true }).status, 'AMBIGUOUS')
  const potentialOnly = parseLargeHolderFiling(row, xbrl().replace(
    field('StocksOrInvestmentSecuritiesEtcArticle27233MainClause', 'FilingDateInstant_Holder1Member', '1000'),
    field('ConvertibleBondsArticle27233MainClause', 'FilingDateInstant_Holder1Member', '1000'),
  )).holders[0]
  assert.equal(assessMarketPriceHolding(potentialOnly, priceEvidence).status, 'NOT_APPLICABLE')
  assert.equal(assessMarketPriceHolding(parseLargeHolderFiling(row, xbrl(true)).holders[1],
    priceEvidence).basisUnits.INVESTMENT_AUTHORITY, 300)
  assert.equal(classifyFromFiling('個人').category, 'INDIVIDUAL')
  assert.equal(classifyFromFiling('法人（株式会社）', '投資運用業', '東京都千代田区').category,
    'DOMESTIC_ASSET_MANAGER')
  assert.equal(classifyFromFiling('法人（株式会社）', '銀行業', '東京都港区').category, 'FINANCIAL_INSTITUTION')
  assert.equal(classifyFromFiling('法人（香港法人）', '投資運用業', '香港・セントラル').category,
    'FOREIGN_ASSET_MANAGER')
  assert.equal(classifyFromFiling('法人（株式会社）', '投資運用業', '〒105-0011 東京都港区').category,
    'DOMESTIC_ASSET_MANAGER')
  assert.equal(classifyFromFiling('法人（株式会社）', '株式保有', '東京都港区').category, 'UNCLASSIFIED')

  const correctionXml = xbrl(false, 2)
  const correction = parseLargeHolderFiling({ ...row, docID: 'S100TEST2', docTypeCode: '360',
    parentDocID: 'S100TEST1', docDescription: '訂正報告書' }, correctionXml)
  assert.equal(correction.filingType, 'AMENDMENT')
  assert.equal(correction.correctedDocumentId, 'S100TEST1')
  assert.throws(() => parseLargeHolderFiling({ ...row, withdrawalStatus: '1' }, xbrl()))
  assert.throws(() => parseLargeHolderFiling({ ...row, withdrawalStatus: '2' }, xbrl()))
  assert.throws(() => parseLargeHolderFiling({ ...row, disclosureStatus: '1' }, xbrl()))

  const original: RevisionFiling = {
    documentId: 'S100ROOT', filingType: 'INITIAL', submittedAt: '2026-09-15 09:00',
    obligationDate: '2026-09-11', correctsFilingId: null, previousFilingId: null,
    issuerEdinetCode: 'E_ISSUER', issuerSecurityCode: '7003', withdrawnAt: null, status: 'ready',
    reportSerialNumber: 2, submissionCount: 1,
  }
  const revision1: RevisionFiling = { ...original, documentId: 'S100REV1', filingType: 'AMENDMENT',
    correctsFilingId: 'S100ROOT', submittedAt: '2026-09-16 10:00', submissionCount: 2 }
  const revision2: RevisionFiling = { ...revision1, documentId: 'S100REV2',
    correctsFilingId: 'S100ROOT', submittedAt: '2026-09-17 10:00', submissionCount: 3 }
  assert.deepEqual(resolveRevisionChains([original, revision1, revision2], '2026-09-15')
    .filter((r) => r.isEffectiveRevision).map((r) => r.documentId), ['S100ROOT'])
  assert.deepEqual(resolveRevisionChains([original, revision1, revision2], '2026-09-16')
    .filter((r) => r.isEffectiveRevision).map((r) => r.documentId), ['S100REV1'])
  const chain = resolveRevisionChains([original, revision1, revision2], '2026-09-17')
  assert.deepEqual(chain.map((r) => [r.rootFilingId, r.revisionSequence, r.isSuperseded, r.isEffectiveRevision]),
    [['S100ROOT', 0, true, false], ['S100ROOT', 1, true, false], ['S100ROOT', 2, false, true]])
  assert.equal(resolveRevisionChains([revision2], '2026-09-17')[0].unresolvedReason, 'missing_correction_origin')
  assert.deepEqual(resolveRevisionChains([original, revision1, revision2], '2026-09-17 09:00')
    .filter((r) => r.isEffectiveRevision).map((r) => r.documentId), ['S100REV1'])
  assert.deepEqual(resolveRevisionChains([original, revision1, revision2], '2026-09-17 10:00')
    .filter((r) => r.isEffectiveRevision).map((r) => r.documentId), ['S100REV2'])
  assert.equal(resolveRevisionChains([original, revision1,
    { ...revision2, reportSerialNumber: 3 }], '2026-09-17')
    .filter((r) => r.isEffectiveRevision).length, 0)
  assert.equal(resolveRevisionChains([original, revision1, { ...revision1, documentId: 'S100FORK' }],
    '2026-09-17').filter((r) => r.isEffectiveRevision).length, 0)

  const legacyAdjudication = CORRECTION_PREDECESSOR_ADJUDICATIONS.S100Y1RL
  const legacyRoot = { ...original, documentId: 'S100Y0JP', submittedAt: '2026-04-24 14:56',
    issuerSecurityCode: '5530', obligationDate: '2026-04-20' }
  const legacyFirst = { ...legacyRoot, documentId: 'S100Y1GY', filingType: 'AMENDMENT',
    submittedAt: '2026-04-30 09:32', correctsFilingId: 'S100Y0JP',
    submissionCount: 2,
    sourceSha256: legacyAdjudication.predecessorSha256 }
  const legacySecond = { ...legacyFirst, documentId: 'S100Y1RL', submittedAt: '2026-05-01 09:10',
    sourceSha256: legacyAdjudication.currentSha256 }
  assert.deepEqual(resolveRevisionChains([legacyRoot, legacyFirst, legacySecond], '2026-04-30')
    .filter((r) => r.isEffectiveRevision).map((r) => r.documentId), ['S100Y1GY'])
  const resolvedLegacy = resolveRevisionChains([legacyRoot, legacyFirst, legacySecond], '2026-05-01')
  assert.deepEqual(resolvedLegacy.map((r) => [r.revisionSequence, r.isEffectiveRevision]),
    [[0, false], [1, false], [2, true]])
  assert.equal(resolvedLegacy[2].effectivePredecessorId, 'S100Y1GY')
  assert.equal(resolveRevisionChains([legacyRoot, legacyFirst,
    { ...legacySecond, sourceSha256: 'changed' }], '2026-05-01')
    .filter((r) => r.isEffectiveRevision).length, 0)
  assert.equal(resolveRevisionChains([legacyRoot, legacySecond], '2026-05-01')
    .filter((r) => r.isEffectiveRevision).length, 0)

  const currentAdjudication = CORRECTION_PREDECESSOR_ADJUDICATIONS.S100Z26F
  const currentRoot = { ...original, documentId: 'S100YZFC', filingType: 'CHANGE',
    submittedAt: '2026-08-28 16:45', issuerSecurityCode: '195A', obligationDate: '2026-05-01' }
  const currentFirst = { ...currentRoot, documentId: 'S100Z1X5', filingType: 'AMENDMENT',
    submittedAt: '2026-09-14 14:39', correctsFilingId: 'S100YZFC',
    submissionCount: 2,
    sourceSha256: currentAdjudication.predecessorSha256 }
  const currentSecond = { ...currentFirst, documentId: 'S100Z26F', submittedAt: '2026-09-14 15:25',
    sourceSha256: currentAdjudication.currentSha256 }
  assert.deepEqual(resolveRevisionChains([currentRoot, currentFirst, currentSecond], '2026-09-14')
    .map((r) => [r.revisionSequence, r.isEffectiveRevision]),
  [[0, false], [1, false], [2, true]])

  const { storeLargeHolderFiling } = await import('@/lib/server/large-holders/ingest')
  const { client } = await import('@/lib/db/client')
  await storeLargeHolderFiling(row, filing, xbrl())
  await storeLargeHolderFiling(row, filing, xbrl())
  await assert.rejects(storeLargeHolderFiling(row, filing, xbrl().replace('東京都Ａ区', '東京都別区')),
    /immutable_large_holder_source_changed/)
  const { latestDisclosedPositions } = await import('@/lib/server/large-holders/latest-positions')
  assert.equal((await latestDisclosedPositions('2026-09-16')).length, 0)
  assert.equal((await latestDisclosedPositions('2026-09-17')).length, 2)
  await storeLargeHolderFiling({ ...row, docID: 'S100TEST2', docTypeCode: '360', parentDocID: 'S100TEST1' }, correction, correctionXml)
  const latest = await latestDisclosedPositions('2026-09-17')
  assert.equal(latest.length, 2)
  assert.ok(latest.every((position) => position.documentId === 'S100TEST2'))
  const { compareCorrection } = await import('@/lib/server/large-holders/latest-positions')
  const comparison = await compareCorrection('S100TEST2', '2026-09-17')
  assert.equal(comparison.before?.issuerSecurityCode, '7003')
  assert.deepEqual(comparison.before?.holders.map((holder) => holder.shares), [1000, 500])
  assert.deepEqual(comparison.after.holders.map((holder) => holder.shares), [1000, 500])
  await assert.rejects(compareCorrection('S100TEST2', '2026-09-16'), /correction_not_available_as_of/)
  const { recordLargeHolderWithdrawal } = await import('@/lib/server/large-holders/ingest')
  await recordLargeHolderWithdrawal('S100TEST2', '2026-09-18 13:00')
  assert.equal((await latestDisclosedPositions('2026-09-17')).length, 2)
  assert.ok((await latestDisclosedPositions('2026-09-18')).every((position) => position.documentId === 'S100TEST1'))
  await recordLargeHolderWithdrawal('S100TEST1', '2026-09-19 11:00')
  assert.equal((await latestDisclosedPositions('2026-09-19')).length, 0)
  const query = async (sql: string) => (await client.execute(sql)).rows
  assert.equal((await query('SELECT count(*) AS n FROM large_holder_filings'))[0].n, 2)
  assert.equal((await query('SELECT count(*) AS n FROM large_holder_positions'))[0].n, 4)
  assert.equal((await query('SELECT count(*) AS n FROM large_holder_groups'))[0].n, 2)
  assert.equal((await query('SELECT count(*) AS n FROM investor_entities'))[0].n, 2)
  assert.equal((await query('SELECT count(*) AS n FROM investor_identity_reviews'))[0].n, 1)
  assert.equal((await query('SELECT sum(reported_shares) AS n FROM large_holder_positions WHERE document_id=\'S100TEST1\''))[0].n, 1500)
  const group = (await query("SELECT group_shares AS n FROM large_holder_groups WHERE document_id='S100TEST1'"))[0].n
  assert.equal(group, 1500) // Not added to the individual shares.
  const swapped = xbrl().replace(
    '>試験 太郎</jplvh:FilerNameInJapaneseDEI>',
    '>試験株式会社</jplvh:FilerNameInJapaneseDEI>',
  )
  const swappedRow = { ...row, docID: 'S100TEST3', edinetCode: 'E_CORP' }
  await storeLargeHolderFiling(swappedRow, parseLargeHolderFiling(swappedRow, swapped), swapped)
  assert.equal((await query('SELECT count(*) AS n FROM investor_entities'))[0].n, 2)
  assert.equal((await query('SELECT count(*) AS n FROM large_holder_positions'))[0].n, 6)
  const corporate = (await query("SELECT entity_id FROM investor_entities WHERE display_name='試験株式会社'"))[0].entity_id
  const { setEvidenceBackedInvestorClassification } = await import('@/lib/server/large-holders/ingest')
  await assert.rejects(setEvidenceBackedInvestorClassification(String(corporate), 'FUND', ''),
    /classification_requires_specific_category_and_source_evidence/)
  await setEvidenceBackedInvestorClassification(String(corporate), 'DOMESTIC_ASSET_MANAGER',
    'EDINET document S100TEST3 verified business activity')
  await storeLargeHolderFiling(swappedRow, parseLargeHolderFiling(swappedRow, swapped), swapped)
  assert.equal((await query("SELECT investor_class FROM investor_entities WHERE display_name='試験株式会社'"))[0].investor_class, 'INSTITUTIONAL')
  const distinctAddressRow = { ...row, docID: 'S100TEST4' }
  const distinctAddress = xbrl().replace('東京都Ｂ区', '東京都Ｃ区')
  await storeLargeHolderFiling(distinctAddressRow, parseLargeHolderFiling(distinctAddressRow, distinctAddress), distinctAddress)
  assert.equal((await query('SELECT count(*) AS n FROM investor_entities'))[0].n, 3)
  console.log('large holder foundation: parser, correction, joint-holder separation, identity, idempotency PASS')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
