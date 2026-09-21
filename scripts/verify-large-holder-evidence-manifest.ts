import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { sha256, verifyArchivedLineage,
  type PositionLineage, type RawEvidence } from '@/lib/large-holders/evidence-provenance'

async function main() {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: tsx scripts/verify-large-holder-evidence-manifest.ts <manifest.json>')
  const bytes = await readFile(path)
  if (basename(path) !== `${sha256(bytes)}.json`) throw new Error('manifest_sha256_mismatch')
  const manifest = JSON.parse(bytes.toString('utf8')) as { phase: string; asOf: string;
    rawSources: RawEvidence[]; lineages: PositionLineage[];
    classificationLineages: PositionLineage[] }
  if (manifest.phase !== '16A-8' || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.asOf)
    || !Array.isArray(manifest.rawSources) || !Array.isArray(manifest.lineages)
    || !Array.isArray(manifest.classificationLineages)
    || !await verifyArchivedLineage(manifest.rawSources,
      [...manifest.lineages, ...manifest.classificationLineages]))
    throw new Error('manifest_lineage_invalid')
  console.log(JSON.stringify({ phase: manifest.phase, asOf: manifest.asOf,
    rawSources: manifest.rawSources.length, positions: manifest.lineages.length,
    classificationPositions: manifest.classificationLineages.length,
    manifestSha256: sha256(bytes), verified: true }))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
