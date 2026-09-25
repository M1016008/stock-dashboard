import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { XbrlFactReader, type XbrlFact } from '@/lib/edinet-xbrl-facts'
import { downloadEdinetPublicArchiveBytes, listEdinetDocuments } from '@/lib/server/edinet-api'

const output = process.argv[2]
if (!output?.includes('/qa/phase16d-shadow/')) {
  throw new Error('An isolated phase16d shadow evidence directory is required')
}
const documentIds = ['S100Z34W', 'S100Z3AM', 'S100YI0J', 'S100YQZ0', 'S100YX61', 'S100Z2FD']
const days = ['2026-09-14', '2026-09-18']
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  await mkdir(output, { recursive: true })
  const rows = (await Promise.all(days.map(listEdinetDocuments))).flat()
  const summaries = []
  for (const documentId of documentIds) {
    const row = rows.find((entry) => entry.docID === documentId)
    if (!row) throw new Error(`Official index row absent: ${documentId}`)
    const archive = await downloadEdinetPublicArchiveBytes(documentId)
    await writeFile(join(output, `${documentId}.zip`), archive)
    const files = unzipSync(archive, { filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name) })
    const source = Object.entries(files).sort((a, b) => b[1].byteLength - a[1].byteLength)[0]
    if (!source) throw new Error(`Official XBRL absent: ${documentId}`)
    const xml = new TextDecoder().decode(source[1])
    const facts = new XbrlFactReader(xml).facts
    const cover = facts.filter((fact) => fact.localName === 'TotalNumberOfFilersAndJointHoldersCoverPage')
      .map((fact) => ({ concept: fact.qname, context: fact.contextRef, unit: fact.unit?.label ?? null,
        value: fact.numericValue, text: fact.textValue }))
    const members = new Map<string, XbrlFact[]>()
    for (const fact of facts) {
      const member = fact.context?.dimensions.find((item) => item.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis'))?.member
      if (!member) continue
      const entries = members.get(member) ?? []
      entries.push(fact)
      members.set(member, entries)
    }
    const holders = [...members].map(([member, entries]) => ({
      member,
      contexts: [...new Set(entries.map((fact) => fact.contextRef))],
      factCount: entries.length,
      facts: entries.map((fact) => ({ concept: fact.localName, context: fact.contextRef,
        unit: fact.unit?.label ?? null, value: fact.numericValue ?? fact.textValue })),
    }))
    const other = facts.filter((fact) => /succession|inherit|joint|holder|correction|amendment|documenttitles/i.test(fact.localName)
      && !fact.context?.dimensions.some((item) => item.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis')))
      .map((fact) => ({ concept: fact.localName, context: fact.contextRef,
        value: fact.numericValue ?? fact.textValue }))
    const summary = {
      documentId, index: row, archiveSha256: sha256(archive), xbrlSha256: sha256(xml),
      xbrlPath: source[0], cover, memberCount: holders.length, holders, other,
    }
    summaries.push(summary)
    console.log(JSON.stringify({ documentId, cover: cover.map((fact) => fact.value),
      memberCount: holders.length, xbrlSha256: summary.xbrlSha256,
      holders: holders.map((holder) => ({ member: holder.member,
        name: holder.facts.find((fact) => fact.concept === 'Name')?.value,
        address: holder.facts.find((fact) => fact.concept === 'ResidentialAddressOrAddressOfRegisteredHeadquarter')?.value,
        shares: holder.facts.find((fact) => fact.concept === 'TotalNumberOfStocksEtcHeld')?.value,
        pct: holder.facts.find((fact) => fact.concept === 'HoldingRatioOfShareCertificatesEtc')?.value,
      })) }))
    await sleep(800)
  }
  await writeFile(join(output, 'official-sources.json'), JSON.stringify(summaries, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
