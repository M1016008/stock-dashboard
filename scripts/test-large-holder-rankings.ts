import assert from 'node:assert/strict'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { GET as rankingGet } from '@/app/api/large-holders/rankings/route'
import { GET as investorsGet } from '@/app/api/large-holders/investors/route'
import { GET as investorGet } from '@/app/api/large-holders/investors/[id]/route'
import { GET as stockGet } from '@/app/api/large-holders/stocks/[ticker]/route'
import { GET as filingGet } from '@/app/api/large-holders/filings/[docId]/route'
import { classifyEffectiveTransition, summarizeInvestor, type RankingSnapshot } from '@/lib/large-holders/ranking-core'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'


async function main() {
  const base = { rootFilingType: 'CHANGE', previousShares: 100, currentShares: 110,
    previousWasObserved: true,
    previousHoldingPct: 5.5, currentHoldingPct: 6, afterOfficiallyVerified: true,
    beforeOfficiallyVerified: true, sameCertifiedInstrument: true }
  assert.equal(classifyEffectiveTransition(base)?.eventType, 'INCREASE')
  assert.equal(classifyEffectiveTransition({ ...base, currentShares: 90 })?.eventType, 'DECREASE')
  assert.equal(classifyEffectiveTransition({ ...base, currentShares: 90,
    currentHoldingPct: 4.5 })?.eventType, 'EXIT_5PCT')
  assert.equal(classifyEffectiveTransition({ ...base, rootFilingType: 'INITIAL',
    previousShares: null, previousWasObserved: false, beforeOfficiallyVerified: false })?.eventType, 'NEW_5PCT')
  assert.equal(classifyEffectiveTransition({ ...base, rootFilingType: 'INITIAL',
    previousShares: null }), null)
  assert.equal(classifyEffectiveTransition({ ...base, rootFilingType: 'AMENDMENT' }), null)
  assert.equal(classifyEffectiveTransition({ ...base, sameCertifiedInstrument: false }), null)
  assert.equal(classifyEffectiveTransition({ ...base, beforeOfficiallyVerified: false }), null)
  const snapshotPath = process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH
  const dbPath = process.env.STOCKBOARD_DB_PATH
  const manifestPath = process.argv[2]
  if (!snapshotPath || !dbPath || !manifestPath) throw new Error('snapshot, DB and manifest paths required')
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as RankingSnapshot
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    lineages: { positionKey: string; entityId: string; decision: { amount: number } }[] }
  assert.equal(snapshot.publicCurrentValuationReadyCount, 179)
  assert.equal(snapshot.currentPositionCount, 224)
  assert.equal(snapshot.investors.length, 165)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try {
    const values = manifest.lineages.map(() => '(?,?,?)').join(',')
    const args = manifest.lineages.flatMap((item) => {
      const i = item.positionKey.indexOf(':')
      return [item.positionKey.slice(0, i), item.positionKey.slice(i + 1), item.decision.amount]
    })
    const totals = db.prepare(`WITH certified(document_id,holder_key,amount) AS (VALUES ${values})
      SELECT p.entity_id,COUNT(*) n,SUM(certified.amount) total
      FROM certified JOIN large_holder_positions p USING(document_id,holder_key)
      GROUP BY p.entity_id`).all(...args) as { entity_id: string; n: number; total: number }[]
    const byId = new Map(totals.map((row) => [row.entity_id, row]))
    const basisTotals = db.prepare(`WITH certified(document_id,holder_key,amount) AS (VALUES ${values})
      SELECT p.entity_id,json_extract(p.security_breakdown_json,'$[0].holdingBasis') basis,
        SUM(certified.amount) total
      FROM certified JOIN large_holder_positions p USING(document_id,holder_key)
      GROUP BY p.entity_id,basis`).all(...args) as { entity_id: string; basis: string; total: number }[]
    const byBasis = new Map(basisTotals.map((row) => [`${row.entity_id}:${row.basis}`, row.total]))
    const checked = snapshot.investors.filter((item) => item.valuedPositionCount > 0)
    for (const investor of checked) {
      const sql = byId.get(investor.investorEntityId)
      assert.ok(sql, `missing_sql:${investor.investorEntityId}`)
      assert.equal(sql.n, investor.valuedPositionCount)
      assert.ok(Math.abs(sql.total - investor.estimatedCurrentValue!) < 0.01,
        `rank_sum_mismatch:${investor.investorEntityId}`)
      const independent = summarizeInvestor({ investorEntityId: investor.investorEntityId,
        displayName: investor.displayName, investorClass: investor.investorClass,
        investorType: investor.investorType, aliases: investor.aliases, positions: investor.positions })
      assert.equal(investor.ownershipEstimatedValue, independent.ownershipEstimatedValue)
      assert.equal(investor.investmentAuthorityEstimatedValue, independent.investmentAuthorityEstimatedValue)
      assert.ok(Math.abs((investor.ownershipEstimatedValue ?? 0)
        - (byBasis.get(`${investor.investorEntityId}:OWNERSHIP_LIKE`) ?? 0)) < 0.01)
      assert.ok(Math.abs((investor.investmentAuthorityEstimatedValue ?? 0)
        - (byBasis.get(`${investor.investorEntityId}:INVESTMENT_AUTHORITY`) ?? 0)) < 0.01)
      assert.equal(investor.portfolioCompleteness, independent.portfolioCompleteness)
      assert.equal(investor.unvaluedPositionCount,
        investor.totalRelevantPositionCount - investor.valuedPositionCount)
    }
    assert.ok(checked.length >= 30)
    assert.ok(checked.filter((item) => item.investorClass === 'INDIVIDUAL').length >= 10)
    assert.ok(checked.filter((item) => item.investorClass === 'INSTITUTIONAL').length >= 10)
    assert.equal(new Set(snapshot.investors.flatMap((item) => item.positions
      .map((position) => `${item.investorEntityId}:${position.ticker}`))).size, 224)
    assert.equal(snapshot.activities.filter((activity) => {
      const filing = snapshot.filings.find((item) => item.documentId === activity.documentId)
      return !filing || filing.filingType === 'AMENDMENT'
    }).length, 0)
    const filings = db.prepare(`SELECT f.document_id,f.filing_type,f.submitted_at,f.obligation_date,
      f.corrected_document_id,f.previous_filing_id,f.issuer_edinet_code,f.issuer_security_code,
      f.withdrawn_at,f.status,f.report_serial_number,f.submission_count,s.xbrl_sha256
      FROM large_holder_filings f LEFT JOIN large_holder_source_documents s USING(document_id)`)
      .all() as Record<string, string | number | null>[]
    const revisions = resolveRevisionChains(filings.map((row): RevisionFiling => ({
      documentId: String(row.document_id), filingType: String(row.filing_type),
      submittedAt: String(row.submitted_at), obligationDate: row.obligation_date as string | null,
      correctsFilingId: row.corrected_document_id as string | null,
      previousFilingId: row.previous_filing_id as string | null,
      issuerEdinetCode: row.issuer_edinet_code as string | null,
      issuerSecurityCode: row.issuer_security_code as string | null,
      withdrawnAt: row.withdrawn_at as string | null, status: String(row.status),
      reportSerialNumber: row.report_serial_number as number | null,
      submissionCount: row.submission_count as number | null,
      sourceSha256: row.xbrl_sha256 as string | null,
    })), snapshot.certificationDate)
    const effective = new Map(revisions.filter((row) => row.isEffectiveRevision)
      .map((row) => [row.documentId, row]))
    const filingById = new Map(filings.map((row) => [String(row.document_id), row]))
    const effectivePositions = db.prepare(`SELECT p.document_id,p.holder_key,p.entity_id,p.ticker,
      p.market_price_eligible_units,p.reported_holding_pct,f.submitted_at,f.obligation_date
      FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)`)
      .all() as Record<string, string | number | null>[]
    const byPair = new Map<string, typeof effectivePositions>()
    for (const row of effectivePositions.filter((item) => effective.has(String(item.document_id)))) {
      const key = `${row.entity_id}:${row.ticker}`
      byPair.set(key, [...(byPair.get(key) ?? []), row])
    }
    for (const event of snapshot.activities) {
      const ordered = byPair.get(`${event.investorEntityId}:${event.ticker}`)!
        .toSorted((a, b) => String(a.obligation_date ?? a.submitted_at)
          .localeCompare(String(b.obligation_date ?? b.submitted_at))
          || String(a.submitted_at).localeCompare(String(b.submitted_at))
          || String(a.document_id).localeCompare(String(b.document_id)))
      const index = ordered.findIndex((row) => row.document_id === event.documentId)
      assert.ok(index >= 0)
      const after = ordered[index], before = index ? ordered[index - 1] : null
      const revision = effective.get(event.documentId)!
      const root = filingById.get(revision.rootFilingId!)!
      assert.notEqual(root.filing_type, 'AMENDMENT')
      assert.equal(event.filingDate, String(root.submitted_at).slice(0, 10))
      assert.equal(event.obligationDate, String(root.obligation_date ?? root.submitted_at).slice(0, 10))
      assert.equal(event.reportedHoldingPct, after.reported_holding_pct)
      const latest = snapshot.investors.find((item) => item.investorEntityId === event.investorEntityId)!
        .positions.find((item) => item.ticker === event.ticker)!
      const price = latest.estimatedCurrentValue! / latest.certifiedUnits!
      if (event.eventType === 'NEW_5PCT') {
        assert.equal(before, null)
        assert.equal(root.filing_type, 'INITIAL')
        assert.ok(event.reportedHoldingPct! >= 5)
        assert.equal(event.currentValueEquivalent, Number(after.market_price_eligible_units) * price)
      } else {
        assert.ok(before)
        assert.equal(root.filing_type, 'CHANGE')
        const delta = Number(after.market_price_eligible_units) - Number(before.market_price_eligible_units)
        assert.equal(event.sharesDelta, delta)
        assert.equal(event.currentValueEquivalent, Math.abs(delta) * price)
        if (event.eventType === 'INCREASE') assert.ok(delta > 0)
        if (event.eventType === 'DECREASE') assert.ok(delta < 0)
      }
    }
    if (snapshot.activityEvidenceManifestSha256) assert.equal(snapshot.effectiveFilingArchiveComplete, true)
    assert.ok(snapshot.activities.every((activity) => activity.currentValueEquivalent == null
      || activity.currentValueEquivalent > 0))
    assert.ok(snapshot.investors.some((item) => item.portfolioCompleteness === 'COMPLETE'))
    assert.ok(snapshot.investors.some((item) => item.portfolioCompleteness === 'PARTIAL'))
    assert.ok(snapshot.investors.some((item) => item.portfolioCompleteness === 'NONE'))
    const status = async (type: string, query = '') => {
      const response = await rankingGet(new Request(`http://localhost/api/large-holders/rankings?rankingType=${type}&period=1Y${query}`))
      assert.equal(response.status, 200)
      return response.json() as Promise<{ total: number; rows: unknown[] }>
    }
    const total = await status('TOTAL_VALUE')
    assert.equal(total.total, 165)
    const individuals = await status('TOTAL_VALUE', '&investorClass=INDIVIDUAL')
    const institutions = await status('TOTAL_VALUE', '&investorClass=INSTITUTIONAL')
    assert.equal(individuals.total, 56)
    assert.equal(institutions.total, 25)
    assert.equal((await status('TOTAL_VALUE', '&completeness=COMPLETE')).total, 131)
    assert.equal((await status('TOTAL_VALUE', '&completeness=PARTIAL')).total, 7)
    assert.equal((await status('TOTAL_VALUE', '&completeness=NONE')).total, 27)
    const investment = await status('TOTAL_VALUE', '&basis=INVESTMENT_AUTHORITY')
    assert.equal(investment.total, 165)
    const page1 = await status('TOTAL_VALUE', '&pageSize=10&page=1')
    const page2 = await status('TOTAL_VALUE', '&pageSize=10&page=2')
    const ids = [...page1.rows, ...page2.rows].map((row) =>
      (row as { investorEntityId: string }).investorEntityId)
    assert.equal(new Set(ids).size, 20)
    const rankingValues = page1.rows.map((row) => (row as { rankingValue: number | null }).rankingValue)
    assert.ok(rankingValues.every((value, i) => i === 0 || (rankingValues[i - 1] ?? -1) >= (value ?? -1)))
    const ascending = await status('TOTAL_VALUE', '&sort=value_asc&pageSize=10')
    const ascendingValues = ascending.rows.map((row) => (row as { rankingValue: number | null }).rankingValue)
    assert.ok(ascendingValues.every((value, i) => i === 0 || (ascendingValues[i - 1] ?? -1) <= (value ?? Infinity)))
    const byName = await status('TOTAL_VALUE', '&sort=name_asc&pageSize=10')
    const names = byName.rows.map((row) => (row as { displayName: string }).displayName)
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ja')))
    const actualMarket = firstMarket(snapshot)
    const marketRows = await status('TOTAL_VALUE', `&market=${encodeURIComponent(actualMarket)}`)
    assert.ok(marketRows.total > 0 && marketRows.total < 165)
    for (const row of marketRows.rows) {
      const item = row as { investorEntityId: string; rankingValue: number | null }
      const expected = snapshot.investors.find((investor) => investor.investorEntityId === item.investorEntityId)!
        .positions.filter((position) => position.market === actualMarket && position.holdingBasis === 'OWNERSHIP'
          && position.estimatedCurrentValue !== null)
        .reduce((sum, position) => sum + position.estimatedCurrentValue!, 0)
      assert.ok(Math.abs((item.rankingValue ?? 0) - expected) < 0.01)
    }
    assert.equal((await status('TOTAL_VALUE', '&market=NONEXISTENT')).total, 0)
    assert.equal((await status('NEW_5PCT')).total,
      snapshot.activities.filter((item) => item.eventType === 'NEW_5PCT' && item.holdingBasis === 'OWNERSHIP').length)
    await status('RECENT_INCREASE')
    await status('DECREASE')
    assert.ok((await status('NEW_5PCT', '&period=7D')).total <= (await status('NEW_5PCT')).total)
    assert.equal((await rankingGet(new Request('http://localhost/api/large-holders/rankings?pageSize=1000'))).status, 400)
    assert.equal((await rankingGet(new Request('http://localhost/api/large-holders/rankings?rankingType=OTHER'))).status, 400)
    assert.equal((await investorsGet(new Request('http://localhost/api/large-holders/investors?investorClass=INDIVIDUAL'))).status, 200)
    const first = snapshot.investors.find((item) => item.positions.length > 0)!
    assert.equal((await investorGet(new Request('http://localhost/api/large-holders/investors/x'),
      { params: Promise.resolve({ id: first.investorEntityId }) })).status, 200)
    assert.equal((await stockGet(new Request('http://localhost/api/large-holders/stocks/x'),
      { params: Promise.resolve({ ticker: first.positions[0].ticker }) })).status, 200)
    const filingResponse = await filingGet(new Request('http://localhost/api/large-holders/filings/x'),
      { params: Promise.resolve({ docId: first.positions[0].documentId }) })
    assert.equal(filingResponse.status, 200)
    const filingJson = await filingResponse.text()
    assert.ok(!filingJson.includes('archivePath') && !filingJson.includes('/Users/'))
    const originalPath = process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH
    process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH = '/nonexistent/large-holder-snapshot.json'
    assert.equal((await rankingGet(new Request('http://localhost/api/large-holders/rankings'))).status, 503)
    process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH = originalPath
    console.log(JSON.stringify({ passed: true, independentlyCheckedInvestors: checked.length,
      individual: checked.filter((item) => item.investorClass === 'INDIVIDUAL').length,
      institutional: checked.filter((item) => item.investorClass === 'INSTITUTIONAL').length,
      mismatch: 0, jointDuplicates: 0, amendmentFalseActivity: 0,
      activity: Object.fromEntries(['NEW_5PCT','INCREASE','DECREASE']
        .map((type) => [type, snapshot.activities.filter((item) => item.eventType === type).length])) }))
  } finally { db.close() }
}

function firstMarket(snapshot: RankingSnapshot): string {
  const value = snapshot.investors.flatMap((item) => item.positions)
    .find((position) => position.market)?.market
  if (!value) throw new Error('market_fixture_missing')
  return value
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
