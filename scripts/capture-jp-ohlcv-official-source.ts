import fs from 'node:fs'
import path from 'node:path'
import {
  fetchJQuantsDailyByDateWithEvidence,
  jQuantsDailyByDateSourceContract,
} from '@/lib/jquants'

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

async function main(): Promise<void> {
  const targetDate = value('--date')
  const output = path.resolve(value('--output'))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('official_source_date_invalid')
  if (!path.isAbsolute(output)) throw new Error('official_source_output_absolute_path_required')
  if (fs.existsSync(output)) throw new Error('official_source_output_must_not_exist')

  const evidence = await fetchJQuantsDailyByDateWithEvidence(targetDate)
  const sourceContract = evidence.unexpectedRejectedRows === 0
    ? jQuantsDailyByDateSourceContract(evidence)
    : null
  const payload = {
    version: 2 as const,
    status: sourceContract ? 'PASS' as const : 'HOLD' as const,
    date: targetDate,
    priceBasis: 'jquants-adjusted-ohlcv-v1' as const,
    capturedAt: evidence.completedAt,
    sourceContract,
    rejectedRows: evidence.rejectedRowEvidence,
    rows: evidence.rows,
  }
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({
    status: payload.status,
    output,
    providerRows: evidence.providerRows,
    acceptedRows: evidence.acceptedRows,
    rejectedRows: evidence.rejectedRows,
    noTradeRows: evidence.noTradeRows,
    unexpectedRejectedRows: evidence.unexpectedRejectedRows,
    contentSha256: evidence.contentSha256,
    rejectedRowsSha256: evidence.rejectedRowsSha256,
  }))
  if (!sourceContract) {
    const sample = evidence.rejectedRowEvidence
      .filter((row) => row.reason !== 'ALL_OHLCV_FIELDS_NULL')
      .slice(0, 10)
      .map((row) => `${row.code}:${row.reason}`)
      .join(',')
    throw new Error(`official_source_capture_hold_unexpected_rejected_rows:${evidence.unexpectedRejectedRows}:${sample}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
