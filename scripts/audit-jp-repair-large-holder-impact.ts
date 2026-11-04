import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : null
  if (!value) throw new Error(`missing ${name}`)
  return path.resolve(value)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function main(): void {
  const repairedPath = argument('--database')
  const baselinePath = argument('--baseline')
  const outputPath = argument('--output')
  const repaired = new DatabaseSync(repairedPath, { readOnly: true })
  const baseline = new DatabaseSync(baselinePath, { readOnly: true })
  try {
    const targetPrice = repaired.prepare(
      "SELECT ticker,date,close FROM ohlcv_daily WHERE ticker='2001' AND date='2026-07-17'",
    ).get() as { ticker: string; date: string; close: number } | undefined
    if (!targetPrice) throw new Error('repaired 2001 target close is missing')
    const positions = baseline.prepare(`
      SELECT document_id AS documentId,holder_key AS holderKey,ticker,reference_date AS referenceDate,
             valuation_eligible_shares AS valuationEligibleShares,
             market_price_eligible_units AS marketPriceEligibleUnits,
             market_price_status AS marketPriceStatus,market_price_reason AS marketPriceReason,
             market_price_close_date AS marketPriceCloseDate,market_price_close AS marketPriceClose
      FROM large_holder_positions
      WHERE ticker='2001' AND reference_date='2026-07-17'
      ORDER BY document_id,holder_key
    `).all() as Array<Record<string, unknown>>
    if (positions.length !== 2) throw new Error(`unexpected Large Holder position count: ${positions.length}`)
    const unsafe = positions.filter((row) => (
      row.marketPriceStatus !== 'AMBIGUOUS'
      || row.valuationEligibleShares != null
      || row.marketPriceEligibleUnits != null
    ))
    if (unsafe.length > 0) throw new Error('Large Holder rows unexpectedly participate in valuation')
    const receipt = {
      version: 1,
      status: 'PASS',
      createdAt: new Date().toISOString(),
      repairedDatabase: fs.realpathSync(repairedPath),
      baselineDatabase: fs.realpathSync(baselinePath),
      targetPrice,
      positions,
      positionsSha256: sha256(positions),
      decision: 'PRESERVE_IMMUTABLE_EXCLUDE_FROM_REPAIR',
      rationale: 'Both rows are AMBIGUOUS with null valuation and market-price eligible units; the stale close evidence is not consumed by certified valuation.',
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    repaired.close()
    baseline.close()
  }
}

main()
