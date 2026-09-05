import { buildScreeningServingDate } from '@/lib/server/integrated-screener-serving'
import { execGet } from '@/lib/db/client'

async function main() {
  const requestedDate = process.argv.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? null
  const force = process.argv.includes('--force') || process.env.INTEGRATED_SCREENER_FORCE === '1'
  const before = await execGet<{ page_count: number; page_size: number }>('SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()')
  const result = await buildScreeningServingDate(requestedDate, force)
  const after = await execGet<{ page_count: number; page_size: number }>('SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()')
  const bytesBefore = Number(before?.page_count ?? 0) * Number(before?.page_size ?? 0)
  const bytesAfter = Number(after?.page_count ?? 0) * Number(after?.page_size ?? 0)
  console.log(JSON.stringify({ ...result, dbBytesBefore: bytesBefore, dbBytesAfter: bytesAfter, dbBytesAdded: bytesAfter - bytesBefore }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
