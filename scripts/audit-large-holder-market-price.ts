// Read-only independent price and source-component audit of research positions.
import { client } from '@/lib/db/client'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'

async function main() {
  const rows = await client.execute(`SELECT p.document_id, p.holder_key, p.ticker,
    p.market_price_eligible_units AS units, p.market_price_status AS status,
    p.market_price_close_date AS price_date, p.market_price_close AS stored_close,
    p.security_breakdown_json AS breakdown, p.deductions_json AS deductions,
    p.market_price_basis_json AS basis, p.market_price_evidence_json AS evidence,
    f.submitted_at, f.issuer_security_code, s.xbrl_xml
    FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
    JOIN large_holder_source_documents s USING(document_id)
    ORDER BY p.document_id, p.holder_key`)
  const counts: Record<string, number> = {}
  const composition = { direct: 0, potentialOnly: 0, mixed: 0 }
  const samples: { documentId: string; ticker: string; basis: string; units: number;
    pitDate: string; pitValue: number; latestDate: string; currentValue: number | null }[] = []
  const errors: string[] = []
  const marketDate = String((await client.execute('SELECT max(date) AS date FROM ohlcv_daily')).rows[0]?.date ?? '')
  for (const row of rows.rows) {
    const id = `${row.document_id}:${row.holder_key}`
    const breakdown = JSON.parse(String(row.breakdown)) as {
      kind: string; concept: string; context: string; quantity: number; holdingBasis: string
    }[]
    const direct = breakdown.filter((part) => part.kind === 'DIRECT_SECURITY' && part.quantity > 0)
    const potential = breakdown.filter((part) => part.kind !== 'DIRECT_SECURITY' && part.quantity > 0)
    if (direct.length) composition.direct += 1
    if (potential.length && !direct.length) composition.potentialOnly += 1
    if (potential.length && direct.length) composition.mixed += 1
    counts[String(row.status)] = (counts[String(row.status)] ?? 0) + 1
    const holderFacts = new XbrlFactReader(String(row.xbrl_xml)).facts.filter((fact) =>
      fact.context?.dimensions.some((dimension) => dimension.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis')
        && dimension.member === row.holder_key))
    for (const part of breakdown) {
      const fact = holderFacts.find((item) => item.qname === part.concept && item.contextRef === part.context)
      if (fact?.numericValue !== part.quantity) errors.push(`${id}:source_component`)
    }
    if (row.units == null) continue
    const units = Number(row.units)
    const basis = JSON.parse(String(row.basis)) as Record<string, number>
    const evidence = JSON.parse(String(row.evidence))
    if (!['FULL_DIRECT', 'PARTIAL_DIRECT'].includes(String(row.status))
      || JSON.parse(String(row.deductions)).length || Object.values(basis).filter((v) => v > 0).length !== 1
      || !evidence.issuerCodeMatches || !evidence.listedAtReference || !evidence.uniquePriceInstrument
      || direct.reduce((sum, part) => sum + part.quantity, 0) !== units) errors.push(`${id}:eligibility`)
    const price = await client.execute({ sql: `SELECT date, close FROM ohlcv_daily
      WHERE ticker=? AND date=?`, args: [row.ticker, row.price_date] })
    const latest = await client.execute({ sql: `SELECT date, close FROM ohlcv_daily
      WHERE ticker=? ORDER BY date DESC LIMIT 1`, args: [row.ticker] })
    if (price.rows[0]?.close !== row.stored_close || !latest.rows.length
      || String(row.price_date) > String(row.submitted_at).slice(0, 10)) errors.push(`${id}:pit_price`)
    if (samples.length < 20 && price.rows[0] && latest.rows[0]) samples.push({
      documentId: String(row.document_id), ticker: String(row.ticker),
      basis: Object.entries(basis).find(([, count]) => count > 0)?.[0] ?? 'UNKNOWN', units,
      pitDate: String(price.rows[0].date), pitValue: units * Number(price.rows[0].close),
      latestDate: String(latest.rows[0].date),
      currentValue: Date.parse(`${marketDate}T00:00:00Z`) - Date.parse(`${latest.rows[0].date}T00:00:00Z`)
        <= 7 * 86_400_000 ? units * Number(latest.rows[0].close) : null,
    })
  }
  console.log(JSON.stringify({ documents: new Set(rows.rows.map((row) => row.document_id)).size,
    positions: rows.rows.length, composition, counts, crossCheckedPrices: samples.length,
    samples, errors: errors.slice(0, 20) }, null, 2))
  if (samples.length < 20 || errors.length) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
