// Independent SAX extraction against stored EDINET XBRL. Read-only; no migrations.
import { createHash } from 'node:crypto'
import { SaxesParser } from 'saxes'
import { client } from '@/lib/db/client'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'

type Fact = { name: string; context: string; value: string; scale: number; sign: string }
type SourceRow = {
  document_id: string; filing_type: string; schema_regime: string; submitted_at: string
  obligation_date: string | null; issuer_security_code: string | null
  issuer_edinet_code: string | null; filer_edinet_code: string | null; filer_name: string | null
  corrected_document_id: string | null; previous_filing_id: string | null
  report_serial_number: number | null; submission_count: number | null
  withdrawn_at: string | null; status: string
  group_shares: number | null; group_holding_pct: number | null
  raw_index_json: string; raw_parsed_payload_json: string | null
  xbrl_sha256: string; xbrl_xml: string
}

function extract(xml: string) {
  const parser = new SaxesParser({ xmlns: true })
  const members = new Map<string, string>()
  const facts: Fact[] = []
  let contextId = ''
  let member = ''
  let memberText = ''
  let fact: Fact | null = null
  let factDepth = 0
  let depth = 0
  parser.on('opentag', (tag) => {
    depth += 1
    const attrs = Object.values(tag.attributes)
    const attr = (key: string) => attrs.find((item) => item.local === key)?.value
    if (tag.local === 'context') { contextId = attr('id') ?? ''; member = '' }
    if (contextId && tag.local === 'explicitMember'
        && (attr('dimension') ?? '').includes('FilersLargeVolumeHoldersAndJointHoldersAxis')) memberText = ''
    const ref = attr('contextRef')
    if (ref && !fact) {
      fact = { name: tag.local, context: ref, value: '', scale: Number(attr('scale') ?? 0),
        sign: attr('sign') ?? '' }
      factDepth = depth
    }
  })
  parser.on('text', (value) => { if (fact) fact.value += value; if (contextId) memberText += value })
  parser.on('cdata', (value) => { if (fact) fact.value += value })
  parser.on('closetag', (tag) => {
    if (tag.local === 'explicitMember' && contextId && memberText.includes('Member')) {
      member = memberText.trim()
      memberText = ''
    }
    if (tag.local === 'context' && contextId) {
      if (member) members.set(contextId, member)
      contextId = ''
    }
    if (fact && depth === factDepth) { facts.push(fact); fact = null }
    depth -= 1
  })
  parser.write(xml).close()
  const root = facts.filter((item) => !members.has(item.context))
  const holders = new Map<string, Fact[]>()
  for (const item of facts) {
    const key = members.get(item.context)
    if (!key) continue
    const list = holders.get(key) ?? []
    list.push(item)
    holders.set(key, list)
  }
  const field = (rows: Fact[], name: string) => rows.find((item) => item.name === name)?.value.trim() ?? null
  const numeric = (rows: Fact[], name: string) => {
    const item = rows.find((candidate) => candidate.name === name)
    if (!item || !item.value.trim()) return null
    const value = Number(item.value.replaceAll(',', '').trim()) * (10 ** item.scale)
    return Number.isFinite(value) ? (item.sign === '-' ? -value : value) : null
  }
  return { root, holders, field, numeric }
}

function select(rows: SourceRow[], limit: number): SourceRow[] {
  const buckets = [
    rows.filter((r) => r.schema_regime.startsWith('LEGACY') && r.filing_type !== 'AMENDMENT'),
    rows.filter((r) => r.schema_regime.startsWith('CURRENT') && r.filing_type !== 'AMENDMENT'),
    rows.filter((r) => r.schema_regime.startsWith('LEGACY') && r.filing_type === 'AMENDMENT'),
    rows.filter((r) => r.schema_regime.startsWith('CURRENT') && r.filing_type === 'AMENDMENT'),
  ]
  const selected: SourceRow[] = []
  while (selected.length < limit && buckets.some((bucket) => bucket.length)) {
    for (const bucket of buckets) {
      const next = bucket.shift()
      if (next) selected.push(next)
      if (selected.length === limit) break
    }
  }
  return selected
}

async function main() {
  const limit = Number(process.argv[2] ?? 50)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid_sample_size')
  const rows = (await client.execute(`SELECT f.document_id, f.filing_type, f.schema_regime,
    f.submitted_at, f.obligation_date, f.issuer_security_code, f.issuer_edinet_code,
    f.filer_edinet_code, f.filer_name, f.corrected_document_id, f.previous_filing_id,
    f.report_serial_number, f.submission_count,
    f.withdrawn_at, f.status, f.group_shares, f.group_holding_pct,
    f.raw_index_json, f.raw_parsed_payload_json,
    s.xbrl_sha256, s.xbrl_xml
    FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
    WHERE f.status IN ('ready','withdrawn') ORDER BY f.document_id`)).rows as unknown as SourceRow[]
  const mismatches: { documentId: string; field: string }[] = []
  let jointFilings = 0
  let groupDiscrepancies = 0
  let checkedPositions = 0
  let checkedCorrections = 0
  let checkedValuation = 0
  const sample = select(rows, limit)
  const revisions = resolveRevisionChains(rows.map((row): RevisionFiling => ({
    documentId: row.document_id, filingType: row.filing_type, submittedAt: row.submitted_at,
    obligationDate: row.obligation_date, correctsFilingId: row.corrected_document_id,
    previousFilingId: row.previous_filing_id, issuerEdinetCode: row.issuer_edinet_code,
    issuerSecurityCode: row.issuer_security_code, withdrawnAt: row.withdrawn_at,
    status: row.status, sourceSha256: row.xbrl_sha256,
    reportSerialNumber: row.report_serial_number, submissionCount: row.submission_count,
  })), '9999-12-31')
  const unresolvedRevisions = revisions.filter((row) => row.unresolvedReason)
  for (const row of sample) {
    const id = row.document_id
    const fail = (field: string) => mismatches.push({ documentId: id, field })
    if (createHash('sha256').update(row.xbrl_xml).digest('hex') !== row.xbrl_sha256) fail('source_hash')
    const source = extract(row.xbrl_xml)
    const index = JSON.parse(row.raw_index_json)
    if (index.docID !== id || index.submitDateTime !== row.submitted_at) fail('submitted_index')
    if (index.edinetCode !== row.filer_edinet_code) fail('filer_edinet_index')
    if (index.issuerEdinetCode !== row.issuer_edinet_code) fail('issuer_edinet_index')
    const filer = source.field(source.root, 'FilerNameInJapaneseDEI')
    const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, '')
    if (filer && row.filer_name && normalized(filer) !== normalized(row.filer_name)) fail('filer_name')
    if (source.field(source.root, 'SecurityCodeOfIssuer') !== row.issuer_security_code) fail('issuer_security_code')
    if (source.field(source.root, 'DateWhenFilingRequirementAroseCoverPage') !== row.obligation_date) fail('obligation_date')
    if (source.numeric(source.root, 'NumberOfSubmissionDEI') !== row.submission_count) fail('submission_count')
    const expectedRegime = row.obligation_date == null ? 'UNKNOWN' : row.obligation_date < '2026-05-01'
      ? 'LEGACY_PRE_2026_05_01' : 'CURRENT_2026_05_01_PLUS'
    if (expectedRegime !== row.schema_regime) fail('regime')
    if (row.filing_type === 'AMENDMENT') {
      checkedCorrections += 1
      if (source.field(source.root, 'IdentificationOfDocumentSubjectToAmendmentDEI')
          !== row.corrected_document_id) fail('correction_target')
    }
    const parsed = JSON.parse(row.raw_parsed_payload_json ?? '{}')
    const positionRows = (await client.execute({
      sql: `SELECT holder_key, reported_shares, reported_holding_pct, previous_holding_pct,
        valuation_eligible_shares, valuation_evidence_json, security_breakdown_json,
        deductions_json, market_price_eligible_units, market_price_status,
        market_price_basis_json, market_price_evidence_json, market_price_close_date,
        market_price_close FROM large_holder_positions WHERE document_id=?`,
      args: [id],
    })).rows
    if (positionRows.length !== source.holders.size || parsed.holders?.length !== source.holders.size) fail('holder_count')
    if (source.holders.size > 1) jointFilings += 1
    let sum = 0
    let complete = true
    for (const position of positionRows) {
      const facts = source.holders.get(String(position.holder_key))
      if (!facts) { fail('holder_key'); continue }
      checkedPositions += 1
      const shares = source.numeric(facts, 'TotalNumberOfStocksEtcHeld')
      const holding = source.numeric(facts, 'HoldingRatioOfShareCertificatesEtc')
      const previous = source.numeric(facts, 'HoldingRatioOfShareCertificatesEtcPerLastReport')
      if (shares !== position.reported_shares) fail('holder_shares')
      if (holding != null && Math.abs(holding * 100 - Number(position.reported_holding_pct)) > 1e-6) fail('holder_pct')
      if (previous != null && Math.abs(previous * 100 - Number(position.previous_holding_pct)) > 1e-6) fail('previous_holder_pct')
      if (shares == null) complete = false
      else sum += shares
      const eligible = position.valuation_eligible_shares
      const breakdown = JSON.parse(String(position.security_breakdown_json)) as {
        kind: string; holdingBasis: string; concept: string; context: string; quantity: number; unit: string | null
      }[]
      for (const part of breakdown) {
        const fact = facts.find((item) => item.name === part.concept.split(':').at(-1)
          && item.context === part.context)
        if (!fact || source.numeric([fact], fact.name) !== part.quantity) fail('security_component_source')
        const expectedBasis = part.concept.match(/Article27233(MainClause|Item[123])$/)?.[1]
        if (part.holdingBasis !== ({ MainClause: 'OWNERSHIP_LIKE', Item1: 'VOTING_AUTHORITY',
          Item2: 'INVESTMENT_AUTHORITY', Item3: 'DERIVATIVE' } as Record<string, string>)[expectedBasis ?? '']) fail('holding_basis')
      }
      for (const deduction of JSON.parse(String(position.deductions_json)) as { concept: string; context: string; quantity: number }[]) {
        const fact = facts.find((item) => item.name === deduction.concept.split(':').at(-1)
          && item.context === deduction.context)
        if (!fact || source.numeric([fact], fact.name) !== deduction.quantity) fail('deduction_source')
      }
      const status = String(position.market_price_status)
      if (status === 'FULL_DIRECT' || status === 'PARTIAL_DIRECT') {
        const units = Number(position.market_price_eligible_units)
        const direct = breakdown.filter((part) => part.kind === 'DIRECT_SECURITY' && part.quantity > 0)
        const basis = JSON.parse(String(position.market_price_basis_json)) as Record<string, number>
        if (direct.length === 0 || direct.reduce((sum, part) => sum + part.quantity, 0) !== units
          || Object.values(basis).filter((value) => value > 0).length !== 1
          || JSON.parse(String(position.deductions_json)).length !== 0
          || units > Number(shares) || !position.market_price_close_date || Number(position.market_price_close) <= 0) {
          fail('market_price_units')
        }
        const evidence = JSON.parse(String(position.market_price_evidence_json))
        if (!evidence.issuerCodeMatches || !evidence.listedAtReference || !evidence.uniquePriceInstrument
          || !evidence.priceDate || evidence.close !== position.market_price_close) fail('price_evidence')
      } else if (position.market_price_eligible_units != null) fail('ineligible_market_price_units')
      if (eligible != null) {
        checkedValuation += 1
        const note = source.field(facts, 'NotesNumberOfStocksEtcHeldTextBlock')
        if (note !== `普通株式 ${Number(eligible).toLocaleString('en-US')}株`
          && note !== `普通株式 ${eligible}株`) fail('valuation_source_note')
        const evidence = JSON.parse(String(position.valuation_evidence_json))
        if (evidence.length !== 1 || evidence[0].quantity !== eligible) fail('valuation_evidence')
      }
    }
    const group = source.numeric(source.root, 'TotalNumberOfStocksEtcHeld')
    if (complete && group != null && Math.abs(sum - group) > 1e-6) groupDiscrepancies += 1
    if (group !== row.group_shares) fail('group_shares')
    const groupPct = source.numeric(source.root, 'HoldingRatioOfShareCertificatesEtc')
    if (groupPct != null && Math.abs(groupPct * 100 - Number(row.group_holding_pct)) > 1e-6) fail('group_pct')
  }
  console.log(JSON.stringify({ sampled: sample.length, legacy: sample.filter((r) => r.schema_regime.startsWith('LEGACY')).length,
    current: sample.filter((r) => r.schema_regime.startsWith('CURRENT')).length,
    original: sample.filter((r) => r.filing_type === 'INITIAL').length,
    change: sample.filter((r) => r.filing_type === 'CHANGE').length,
    correction: checkedCorrections, jointFilings, checkedPositions, checkedValuation,
    groupDiscrepancies, unresolvedRevisions: unresolvedRevisions.map((row) => ({
      documentId: row.documentId, reason: row.unresolvedReason,
    })), mismatches }, null, 2))
  if (mismatches.length || groupDiscrepancies || unresolvedRevisions.length) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
