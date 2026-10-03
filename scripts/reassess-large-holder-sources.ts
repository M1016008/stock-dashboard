// Research-only replay of immutable saved EDINET instances; no network or web deploy.
import { client, ensureReady } from '@/lib/db/client'
import { parseLargeHolderFiling } from '@/lib/large-holders/filing'
import { storeLargeHolderFiling } from '@/lib/server/large-holders/ingest'
import type { EdinetDocumentIndexRow } from '@/lib/server/edinet-api'

async function main() {
  await ensureReady()
  const rows = await client.execute(`SELECT f.document_id, f.raw_index_json, s.xbrl_xml
    FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
    WHERE f.status IN ('ready','withdrawn') ORDER BY f.submitted_at, f.document_id`)
  let reprocessed = 0
  for (const row of rows.rows) {
    const index = JSON.parse(String(row.raw_index_json)) as EdinetDocumentIndexRow
    const xml = String(row.xbrl_xml)
    if (index.docID !== row.document_id) throw new Error(`index_document_mismatch:${row.document_id}`)
    await storeLargeHolderFiling(index, parseLargeHolderFiling(index, xml), xml)
    reprocessed += 1
  }
  const counts = await client.execute(`SELECT market_price_status, count(*) AS n
    FROM large_holder_positions GROUP BY market_price_status ORDER BY market_price_status`)
  const classified = await client.execute(`SELECT investor_class, count(*) AS n
    FROM investor_entities GROUP BY investor_class ORDER BY investor_class`)
  console.log(JSON.stringify({ reprocessed, positions: counts.rows, entities: classified.rows }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
