// Read-only, offline materialization. Never run this on an API request path.
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { sha256, verifyArchivedLineage, type RawEvidence, type PositionLineage } from '@/lib/large-holders/evidence-provenance'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'
import { currentPositionEntityId, OZAKI_ATSUSHI_SUCCESSION } from '@/lib/large-holders/entity-adjudications'
import { classifyEffectiveTransition, POSITION_FINGERPRINT_SQL, summarizeInvestor, type HoldingBasis, type HolderActivity,
  type InvestorClass, type RankedPosition, type RankingSnapshot } from '@/lib/large-holders/ranking-core'

type Row = Record<string, string | number | null>
type CertifiedLineage = PositionLineage & { entityId: string; ticker: string;
  decision: { classification: string; quantity: number; price: number; amount: number } }
type Manifest = { phase: string; asOf: string; certificationDate: string;
  rawSources: RawEvidence[]; lineages: CertifiedLineage[]; classificationLineages: PositionLineage[] }
const str = (value: unknown) => String(value ?? '')
const optional = (value: unknown) => value == null ? null : String(value)
const number = (value: unknown) => value == null ? null : Number(value)
const positionKey = (row: Row) => `${row.document_id}:${row.holder_key}`
const date = (row: Row) => str(row.obligation_date ?? row.submitted_at).slice(0, 10)

function legalBasis(row: Row): HoldingBasis | null {
  const all = JSON.parse(str(row.security_breakdown_json)) as { kind: string; holdingBasis: string;
    quantity: number; unit: string | null }[]
  const direct = all.filter((item) => item.kind === 'DIRECT_SECURITY' && item.quantity > 0)
  if (direct.length !== 1) return null
  return ({ OWNERSHIP_LIKE: 'OWNERSHIP', INVESTMENT_AUTHORITY: 'INVESTMENT_AUTHORITY',
    VOTING_AUTHORITY: 'VOTING_AUTHORITY', DERIVATIVE: 'OTHER' } as Record<string, HoldingBasis>)[direct[0].holdingBasis] ?? null
}

function compatibleDirect(before: Row, after: Row): boolean {
  const parse = (row: Row) => (JSON.parse(str(row.security_breakdown_json)) as { kind: string;
    holdingBasis: string; quantity: number; unit: string | null }[])
  const left = parse(before), right = parse(after)
  return left.length === 1 && right.length === 1
    && left[0].kind === 'DIRECT_SECURITY' && right[0].kind === 'DIRECT_SECURITY'
    && left[0].quantity > 0 && right[0].quantity > 0
    && left[0].holdingBasis === right[0].holdingBasis && left[0].unit === right[0].unit
    && left[0].quantity === number(before.market_price_eligible_units)
    && right[0].quantity === number(after.market_price_eligible_units)
    && str(before.issuer_edinet_code) === str(after.issuer_edinet_code)
    && str(before.issuer_security_code) === str(after.issuer_security_code)
    && str(before.ticker) === str(after.ticker)
}

function publicXml(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name) })
  const entry = Object.entries(files).filter(([name]) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(name))
    .sort((a, b) => b[1].byteLength - a[1].byteLength)[0]
  if (!entry) throw new Error('official_public_xbrl_missing')
  return new TextDecoder('utf-8').decode(entry[1])
}

async function main() {
  const manifestPath = process.argv[2]
  const dbPath = process.env.STOCKBOARD_DB_PATH
  if (!manifestPath || !dbPath) throw new Error('Usage: STOCKBOARD_DB_PATH=... tsx build-large-holder-ranking-snapshot.ts <manifest>')
  const manifestBytes = await readFile(manifestPath)
  const digest = sha256(manifestBytes)
  if (basename(manifestPath) !== `${digest}.json`) throw new Error('manifest_digest_mismatch')
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest
  if (manifest.phase !== '16A-8' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(manifest.asOf)
    || !await verifyArchivedLineage(manifest.rawSources,
      [...manifest.lineages, ...manifest.classificationLineages])) throw new Error('official_lineage_invalid')
  const activityManifestPath = process.argv[3]
  let activityEvidenceManifestSha256: string | null = null
  let activitySources: (RawEvidence & { documentId: string; xbrlSha256: string })[] = []
  if (activityManifestPath) {
    const bytes = await readFile(activityManifestPath)
    activityEvidenceManifestSha256 = sha256(bytes)
    if (basename(activityManifestPath) !== `${activityEvidenceManifestSha256}.json`)
      throw new Error('activity_manifest_digest_mismatch')
    const supplemental = JSON.parse(bytes.toString('utf8')) as { phase: string; asOf: string;
      baseManifestSha256: string; rawSources: typeof activitySources }
    if (supplemental.phase !== '16B-1-ACTIVITY' || supplemental.asOf !== manifest.asOf
      || supplemental.baseManifestSha256 !== digest || !Array.isArray(supplemental.rawSources))
      throw new Error('activity_manifest_scope_invalid')
    activitySources = supplemental.rawSources
    const seen = new Set<string>()
    for (const source of activitySources) {
      const archivedBytes = await readFile(source.archivePath)
      if (seen.has(source.documentId) || source.authority !== 'EDINET'
        || source.reference !== `https://api.edinet-fsa.go.jp/api/v2/documents/${source.documentId}?type=1`
        || archivedBytes.byteLength !== source.byteLength || sha256(archivedBytes) !== source.sha256)
        throw new Error('activity_official_source_invalid')
      seen.add(source.documentId)
    }
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  const all = (sql: string) => db.prepare(sql).all() as Row[]
  const one = (sql: string) => db.prepare(sql).get() as Row | undefined
  try {
    const marketDate = str(one('SELECT MAX(date) d FROM ohlcv_daily')?.d)
    const priceDate = str(one('SELECT MAX(price_date) d FROM large_holder_price_evidence')?.d)
    if (manifest.asOf !== marketDate || manifest.asOf !== priceDate)
      throw new Error('certification_stale_market_date')
    const filings = all(`SELECT f.*,s.xbrl_sha256,s.xbrl_xml FROM large_holder_filings f
      LEFT JOIN large_holder_source_documents s USING(document_id)`)
    const filingWatermark = {
      count: filings.length,
      maxImportedAt: filings.reduce<number | null>((max, row) => Math.max(max ?? 0, number(row.imported_at) ?? 0), null),
      maxSubmittedAt: filings.reduce<string | null>((max, row) => !max || str(row.submitted_at) > max
        ? str(row.submitted_at) : max, null),
    }
    if (filingWatermark.maxSubmittedAt && filingWatermark.maxSubmittedAt.slice(0, 10) > manifest.certificationDate)
      throw new Error('new_filings_after_certification')
    const revisions = resolveRevisionChains(filings.map((row): RevisionFiling => ({
      documentId: str(row.document_id), filingType: str(row.filing_type), submittedAt: str(row.submitted_at),
      obligationDate: optional(row.obligation_date), correctsFilingId: optional(row.corrected_document_id),
      previousFilingId: optional(row.previous_filing_id), issuerEdinetCode: optional(row.issuer_edinet_code),
      issuerSecurityCode: optional(row.issuer_security_code), withdrawnAt: optional(row.withdrawn_at),
      status: str(row.status), sourceSha256: optional(row.xbrl_sha256),
      reportSerialNumber: number(row.report_serial_number), submissionCount: number(row.submission_count),
    })), manifest.certificationDate)
    if (revisions.some((row) => row.unresolvedReason)) throw new Error('revision_chain_unresolved')
    const effective = new Map(revisions.filter((row) => row.isEffectiveRevision).map((row) => [row.documentId, row]))
    const filingById = new Map(filings.map((row) => [str(row.document_id), row]))
    const positions = all(`SELECT p.*,f.issuer_name,f.issuer_edinet_code,f.issuer_security_code,
      f.filer_edinet_code,f.report_serial_number,f.submitted_at,
      f.obligation_date AS filing_obligation_date,f.filing_type,f.source_url,
      s.xbrl_sha256 FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
      LEFT JOIN large_holder_source_documents s USING(document_id)`)
      .filter((row) => effective.has(str(row.document_id)))
    const newest = new Map<string, Row>()
    for (const row of positions.toSorted((a, b) => date(b).localeCompare(date(a))
      || str(b.submitted_at).localeCompare(str(a.submitted_at))
      || str(b.document_id).localeCompare(str(a.document_id)))) {
      const key = `${currentPositionEntityId(row)}:${row.ticker}`
      if (!newest.has(key)) newest.set(key, row)
    }
    const current = [...newest.values()]
    const latestKeys = new Set(current.map(positionKey))
    const classifiedKeys = new Set(manifest.classificationLineages.map((item) => item.positionKey.slice('INVESTOR:'.length)))
    if (latestKeys.size !== current.length || classifiedKeys.size !== current.length
      || [...latestKeys].some((key) => !classifiedKeys.has(key))) throw new Error('classification_population_changed')
    const publicByKey = new Map(manifest.lineages.map((item) => [item.positionKey, item]))
    if (publicByKey.size !== manifest.lineages.length
      || [...publicByKey.keys()].some((key) => !latestKeys.has(key))) throw new Error('public_population_changed')
    const classByKey = new Map(manifest.classificationLineages.map((item) =>
      [item.positionKey.slice('INVESTOR:'.length), (item.decision as { investorClass: string }).investorClass]))
    const classByEntity = new Map<string, InvestorClass>()
    const entityRows = new Map(all('SELECT entity_id,display_name,investor_type FROM investor_entities')
      .map((row) => [str(row.entity_id), row]))
    for (const row of current) {
      const rawClass = classByKey.get(positionKey(row))
      const cls: InvestorClass = rawClass === 'INDIVIDUAL' || rawClass === 'INSTITUTIONAL'
        ? rawClass : rawClass === 'OTHER' ? 'OTHER' : 'UNCLASSIFIED'
      const entity = str(row.entity_id)
      const prior = classByEntity.get(entity)
      if (prior && prior !== cls) throw new Error('investor_class_conflict')
      classByEntity.set(entity, cls)
    }
    const aliases = new Map<string, string[]>()
    for (const row of all('SELECT entity_id,raw_holder_name FROM investor_aliases')) {
      const rawId = str(row.entity_id)
      const id = rawId === OZAKI_ATSUSHI_SUCCESSION.priorEntityId
        ? OZAKI_ATSUSHI_SUCCESSION.canonicalEntityId : rawId
      const list = aliases.get(id) ?? []
      if (!list.includes(str(row.raw_holder_name))) list.push(str(row.raw_holder_name))
      aliases.set(id, list)
    }
    const industries = new Map(all(`SELECT ticker,name,market_segment,sector17_name,sector33_name FROM ticker_universe`)
      .map((row) => [str(row.ticker), row]))
    const edinetRaw = new Map([...manifest.rawSources.filter((item) => item.authority === 'EDINET'),
      ...activitySources].map((item) =>
      [item.reference.match(/\/documents\/([^?]+)\?type=1$/)?.[1] ?? '', item]))
    const outputPositions: RankedPosition[] = current.map((row) => {
      const lineage = publicByKey.get(positionKey(row))
      const basis = legalBasis(row)
      const info = industries.get(str(row.ticker))
      const official = edinetRaw.get(str(row.document_id))
      if (!official || !row.xbrl_sha256 || !entityRows.has(str(row.entity_id)))
        throw new Error('current_source_or_entity_missing')
      if (lineage) {
        if (!basis || lineage.entityId !== str(row.entity_id) || lineage.ticker !== str(row.ticker)
          || lineage.decision.quantity !== number(row.market_price_eligible_units)
          || lineage.decision.amount !== lineage.decision.quantity * lineage.decision.price
          || lineage.decision.price <= 0 || lineage.decision.quantity <= 0
          || str(row.market_price_status) === 'AMBIGUOUS') throw new Error('certified_position_db_mismatch')
        const direct = (JSON.parse(str(row.security_breakdown_json)) as { kind: string; quantity: number }[])
          .filter((item) => item.kind === 'DIRECT_SECURITY' && item.quantity > 0)
        if (direct.length !== 1 || direct[0].quantity !== lineage.decision.quantity)
          throw new Error('certified_legal_basis_mismatch')
      }
      return { positionKey: positionKey(row), documentId: str(row.document_id),
        investorEntityId: str(row.entity_id), ticker: str(row.ticker),
        issuerName: optional(row.issuer_name) ?? optional(info?.name),
        reportedShares: number(row.reported_shares), reportedHoldingPct: number(row.reported_holding_pct),
        certifiedUnits: lineage?.decision.quantity ?? null,
        estimatedCurrentValue: lineage?.decision.amount ?? null,
        holdingBasis: basis ?? 'OTHER', filingDate: str(row.submitted_at).slice(0, 10),
        obligationDate: optional(row.filing_obligation_date),
        holdingInformationDate: date(row), priceDate: lineage ? manifest.asOf : null,
        valuationStatus: lineage ? 'PUBLIC_CURRENT_VALUATION_READY' : 'UNVALUED',
        market: optional(info?.market_segment), industry17: optional(info?.sector17_name),
        industry33: optional(info?.sector33_name),
        source: { authority: 'EDINET', documentId: str(row.document_id), sourceSha256: official.sha256 },
      }
    })
    const byEntity = new Map<string, RankedPosition[]>()
    for (const position of outputPositions) byEntity.set(position.investorEntityId,
      [...(byEntity.get(position.investorEntityId) ?? []), position])
    const investors = [...byEntity].map(([id, rows]) => summarizeInvestor({
      investorEntityId: id, displayName: str(entityRows.get(id)?.display_name),
      investorClass: classByEntity.get(id)!, investorType: str(entityRows.get(id)?.investor_type),
      aliases: aliases.get(id) ?? [], positions: rows.toSorted((a, b) => a.ticker.localeCompare(b.ticker)),
    })).sort((a, b) => a.investorEntityId.localeCompare(b.investorEntityId))
    // Only archived, independently matched source documents may produce a public activity.
    const verifiedDocs = new Set<string>()
    for (const [doc, source] of edinetRaw) {
      const filing = filingById.get(doc)
      if (!filing || !filing.xbrl_sha256) continue
      if ('xbrlSha256' in source && source.xbrlSha256 !== filing.xbrl_sha256)
        throw new Error('activity_manifest_xbrl_mismatch')
      const xml = publicXml(new Uint8Array(await readFile(source.archivePath)))
      if (sha256(xml) !== filing.xbrl_sha256 || xml !== filing.xbrl_xml)
        throw new Error('official_edinet_db_mismatch')
      verifiedDocs.add(doc)
    }
    const effectiveFilingArchiveComplete = [...effective.keys()].every((doc) => verifiedDocs.has(doc))
    if (activityManifestPath && !effectiveFilingArchiveComplete)
      throw new Error('effective_filing_archive_incomplete')
    const currentPositionByPair = new Map(outputPositions.map((row) =>
      [`${row.investorEntityId}:${row.ticker}`, row]))
    const priceByPair = new Map(outputPositions.filter((row) => row.valuationStatus === 'PUBLIC_CURRENT_VALUATION_READY')
      .map((row) => [`${row.investorEntityId}:${row.ticker}`, row.estimatedCurrentValue! / row.certifiedUnits!]))
    const series = new Map<string, Row[]>()
    for (const row of positions) {
      const key = `${currentPositionEntityId(row)}:${row.ticker}`
      series.set(key, [...(series.get(key) ?? []), row])
    }
    const activities: HolderActivity[] = []
    for (const [key, list] of series) {
      const price = priceByPair.get(key)
      if (!price) continue
      const ordered = list.toSorted((a, b) => date(a).localeCompare(date(b))
        || str(a.submitted_at).localeCompare(str(b.submitted_at)) || str(a.document_id).localeCompare(str(b.document_id)))
      let previous: Row | null = null
      for (const row of ordered) {
        const revision = effective.get(str(row.document_id))!
        const root = filingById.get(revision.rootFilingId!)!
        const eventDate = str(root.obligation_date ?? root.submitted_at).slice(0, 10)
        const cert = currentPositionByPair.get(key)!
        const latestRow = newest.get(key)!
        const afterVerified = verifiedDocs.has(str(row.document_id))
        const beforeVerified = previous && verifiedDocs.has(str(previous.document_id))
        const beforePct = previous ? number(previous.reported_holding_pct) : null
        const afterPct = number(row.reported_holding_pct)
        const beforeShares = previous ? number(previous.market_price_eligible_units) : null
        const afterShares = number(row.market_price_eligible_units)
        const transition = classifyEffectiveTransition({ rootFilingType: str(root.filing_type),
          previousShares: beforeShares, previousWasObserved: previous !== null, currentShares: afterShares,
          previousHoldingPct: beforePct, currentHoldingPct: afterPct,
          afterOfficiallyVerified: afterVerified, beforeOfficiallyVerified: !!beforeVerified,
          sameCertifiedInstrument: compatibleDirect(latestRow, row)
            && (!previous || compatibleDirect(previous, row))
            && legalBasis(row) === cert.holdingBasis })
        if (transition) activities.push({ eventType: transition.eventType, investorEntityId: currentPositionEntityId(row),
          investorClass: classByEntity.get(currentPositionEntityId(row))!, ticker: str(row.ticker),
          issuerName: optional(row.issuer_name), documentId: str(row.document_id),
          filingDate: str(root.submitted_at).slice(0, 10), obligationDate: eventDate,
          reportedHoldingPct: afterPct, previousHoldingPct: beforePct,
          reportedShares: number(row.reported_shares), sharesDelta: transition.sharesDelta,
          holdingPctDelta: beforePct == null || afterPct == null ? null : afterPct - beforePct,
          currentValueEquivalent: transition.eventType === 'NEW_5PCT' ? afterShares! * price
            : transition.sharesDelta == null ? null : Math.abs(transition.sharesDelta) * price,
          holdingBasis: cert.holdingBasis, priceDate: manifest.asOf })
        previous = row
      }
    }
    const filingDetails = revisions.filter((row) => row.isEffectiveRevision).map((row) => {
      const item = filingById.get(row.documentId)!
      return { documentId: row.documentId, filingType: str(filingById.get(row.rootFilingId!)?.filing_type),
        filingDate: str(item.submitted_at).slice(0, 10), obligationDate: optional(item.obligation_date),
        issuerName: optional(item.issuer_name), ticker: optional(item.ticker),
        sourceUrl: str(item.source_url), sourceSha256: optional(item.xbrl_sha256),
        sourceVerified: verifiedDocs.has(row.documentId),
        rootFilingId: row.rootFilingId!, isCorrection: row.isCorrection,
        investorEntityIds: [...new Set(positions.filter((position) => position.document_id === row.documentId)
          .map((position) => currentPositionEntityId(position)))],
      }
    })
    const snapshot: RankingSnapshot = { version: 1, certificationAsOf: manifest.asOf,
      certificationDate: manifest.certificationDate, manifestSha256: digest,
      activityEvidenceManifestSha256, effectiveFilingArchiveComplete,
      latestEdinetDataAt: filingWatermark.maxSubmittedAt,
      latestPositionDate: outputPositions.reduce<string | null>((max, row) =>
        !max || row.holdingInformationDate > max ? row.holdingInformationDate : max, null),
      priceDate: manifest.asOf, filingWatermark,
      positionFingerprintSha256: sha256(JSON.stringify(all(POSITION_FINGERPRINT_SQL))),
      publicCurrentValuationReadyCount: outputPositions.filter((row) => row.valuationStatus === 'PUBLIC_CURRENT_VALUATION_READY').length,
      currentPositionCount: outputPositions.length, investors, activities,
      filings: filingDetails }
    if (snapshot.publicCurrentValuationReadyCount !== manifest.lineages.length)
      throw new Error('public_ready_count_mismatch')
    const bytes = JSON.stringify(snapshot)
    const outputDir = process.env.LARGE_HOLDER_RANKING_DIR ?? join(dirname(dirname(manifestPath)), 'rankings')
    await mkdir(outputDir, { recursive: true, mode: 0o700 })
    const outputPath = join(outputDir, `${sha256(bytes)}.json`)
    try { await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || await readFile(outputPath, 'utf8') !== bytes) throw error }
    console.log(JSON.stringify({ snapshotPath: outputPath, manifestSha256: digest,
      publicReady: snapshot.publicCurrentValuationReadyCount, positions: snapshot.currentPositionCount,
      investors: investors.length, classes: Object.fromEntries(['INDIVIDUAL','INSTITUTIONAL','OTHER','UNCLASSIFIED']
        .map((name) => [name, investors.filter((item) => item.investorClass === name).length])),
      completeness: Object.fromEntries(['COMPLETE','PARTIAL','NONE']
        .map((name) => [name, investors.filter((item) => item.portfolioCompleteness === name).length])),
      activities: Object.fromEntries(['NEW_5PCT','INCREASE','DECREASE','EXIT_5PCT']
        .map((name) => [name, activities.filter((item) => item.eventType === name).length])),
      effectiveFilingArchiveComplete,
      dbWrites: 0 }))
  } finally { db.close() }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
