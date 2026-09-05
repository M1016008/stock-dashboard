import { execGet } from '@/lib/db/client'
import { evaluateAllSavedScreeningDefinitions } from '@/lib/server/saved-screening-evaluations'

async function main() {
  const requestedAsOf = process.argv.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? null
  const before = await execGet<{ page_count: number; page_size: number }>('SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()')
  const startedAt = Date.now()
  const results = await evaluateAllSavedScreeningDefinitions(requestedAsOf)
  const after = await execGet<{ page_count: number; page_size: number }>('SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()')
  const bytesBefore = Number(before?.page_count ?? 0) * Number(before?.page_size ?? 0)
  const bytesAfter = Number(after?.page_count ?? 0) * Number(after?.page_size ?? 0)
  console.log(JSON.stringify({
    requestedAsOf,
    definitions: results.length,
    completed: results.filter((result) => result.evaluation).length,
    errors: results.filter((result) => result.error).length,
    elapsedMs: Date.now() - startedAt,
    dbBytesAdded: bytesAfter - bytesBefore,
    results,
  }))
  if (results.some((result) => result.error)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
