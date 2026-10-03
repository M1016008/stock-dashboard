import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { XbrlFactReader, type XbrlFact } from '@/lib/edinet-xbrl-facts'
import { downloadEdinetPublicArchiveBytes, listEdinetDocuments } from '@/lib/server/edinet-api'

const documentId = 'S100Z2WE'
const submittedDate = '2026-09-17'
const output = process.argv[2]
const dbPath = process.env.PHASE16D_SOURCE_FIXTURE_DB
if (!output?.includes('/qa/phase16d-shadow/')
  || !dbPath?.includes('/qa/phase16d-shadow/')) {
  throw new Error('phase16d4_isolated_evidence_paths_required')
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const value = (fact: XbrlFact | undefined) => fact?.numericValue ?? fact?.textValue ?? null
const factRecord = (fact: XbrlFact) => ({ concept: fact.qname, context: fact.contextRef,
  unit: fact.unit?.label ?? null, value: value(fact) })

async function main() {
  const index = (await listEdinetDocuments(submittedDate)).find((row) => row.docID === documentId)
  if (!index) throw new Error('official_index_document_absent')
  const archive = await downloadEdinetPublicArchiveBytes(documentId)
  const entries = Object.entries(unzipSync(archive, {
    filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name),
  })).sort((left, right) => right[1].byteLength - left[1].byteLength)
  const source = entries[0]
  if (!source) throw new Error('official_public_xbrl_absent')
  const xml = new TextDecoder('utf-8').decode(source[1])
  const sourceSha256 = sha256(xml)
  const db = new DatabaseSync(dbPath!, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try {
    const row = db.prepare(`SELECT f.raw_index_json,s.xbrl_sha256,s.xbrl_xml
      FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
      WHERE f.document_id=?`).get(documentId) as {
      raw_index_json: string; xbrl_sha256: string; xbrl_xml: string } | undefined
    if (!row || row.xbrl_sha256 !== sourceSha256 || row.xbrl_xml !== xml
      || JSON.parse(row.raw_index_json).docID !== index.docID) {
      throw new Error('official_archive_shadow_source_mismatch')
    }
  } finally { db.close() }

  const facts = new XbrlFactReader(xml).facts
  const cover = facts.filter((fact) => fact.localName === 'TotalNumberOfFilersAndJointHoldersCoverPage')
    .map(factRecord)
  const byMember = new Map<string, XbrlFact[]>()
  for (const fact of facts) {
    const member = fact.context?.dimensions.find((item) =>
      item.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis'))?.member
    if (!member) continue
    byMember.set(member, [...(byMember.get(member) ?? []), fact])
  }
  const members = [...byMember].map(([qname, entries]) => {
    const pick = (name: string) => value(entries.find((fact) => fact.localName === name))
    return { qname, number: Number(qname.match(/Holder(\d+)Member/)?.[1] ?? NaN),
      name: pick('Name'), address: pick('ResidentialAddressOrAddressOfRegisteredHeadquarter'),
      currentShares: pick('TotalNumberOfStocksEtcHeld'),
      previousShares: null,
      currentHoldingRatio: pick('HoldingRatioOfShareCertificatesEtc'),
      previousHoldingRatio: pick('HoldingRatioOfShareCertificatesEtcPerLastReport'),
      holderType: pick('IndividualOrCorporation'),
      filingAndLegalFacts: entries.filter((fact) =>
        /Filer|Joint|Stocks|Holding|Residual|Authority|Rights|Class|Kind|Basis/i.test(fact.localName))
        .map(factRecord),
      allFacts: entries.map(factRecord) }
  }).sort((left, right) => left.number - right.number)
  if (cover.length !== 1 || Number(cover[0].value) !== 13 || members.length !== 14
    || members.some((member) => !member.name || !member.address
      || typeof member.currentShares !== 'number' || member.currentShares <= 0)
    || new Set(members.map((member) => `${member.name}:${member.address}`)).size !== 14) {
    throw new Error('official_source_findings_changed')
  }
  const evidence = { documentId, submittedDate, officialIndex: index,
    archiveReference: `https://api.edinet-fsa.go.jp/api/v2/documents/${documentId}?type=1`,
    archiveSha256: sha256(archive), xbrlSha256: sourceSha256, xbrlPath: source[0],
    cover, members, nonMemberFacts: facts.filter((fact) =>
      !fact.context?.dimensions.some((item) =>
        item.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis')))
      .map(factRecord) }
  await mkdir(output!, { recursive: true, mode: 0o700 })
  const archivePath = join(output!, `${documentId}.zip`)
  const evidencePath = join(output!, `${documentId}-evidence.json`)
  await writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 })
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 })
  if (sha256(await readFile(archivePath)) !== evidence.archiveSha256) throw new Error('archive_write_mismatch')
  console.log(JSON.stringify({ documentId, coverCount: cover[0].value,
    axisMembers: members.length, allPositiveAndDistinct: true,
    archiveSha256: evidence.archiveSha256, xbrlSha256: evidence.xbrlSha256,
    archivePath, evidencePath }))
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
