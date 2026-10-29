import fs from 'node:fs'
import path from 'node:path'
import {
  buildJpOhlcvBackfillPlan,
  sameJpOhlcvValue,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function absolute(flag: string): string {
  const result = value(flag)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function rows<T>(file: string): T[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as T[] | { rows?: T[]; reconstructedRows?: T[] }
  if (Array.isArray(parsed)) return parsed
  const result = parsed.reconstructedRows ?? parsed.rows
  if (!Array.isArray(result)) throw new Error(`runtime_evidence_rows_missing:${file}`)
  return result
}

const baselinePath = absolute('--baseline-existing')
const observedAddedPath = absolute('--observed-added')
const officialPath = absolute('--official')
const outputPath = absolute('--output')
const baseline = rows<JpOhlcvValue>(baselinePath)
const added = rows<JpOhlcvValue>(observedAddedPath)
const official = rows<JpOfficialOhlcvValue>(officialPath)
const targetDate = value('--date')
const expectedConflicts = value('--expected-conflicts').split(',').filter(Boolean).sort()
if (expectedConflicts.length === 0 || new Set(expectedConflicts).size !== expectedConflicts.length) {
  throw new Error('runtime_evidence_expected_conflicts_invalid')
}
for (const [label, source] of [['baseline', baseline], ['added', added], ['official', official]] as const) {
  if (source.some((row) => row.date !== targetDate)) {
    throw new Error(`runtime_evidence_${label}_target_date_mismatch`)
  }
  if (new Set(source.map((row) => `${row.ticker}:${row.date}`)).size !== source.length) {
    throw new Error(`runtime_evidence_${label}_duplicate`)
  }
}
const existingKeys = new Set(baseline.map((row) => `${row.ticker}:${row.date}`))
const officialByKey = new Map(official.map((row) => [`${row.ticker}:${row.date}`, row]))
if (new Set(added.map((row) => `${row.ticker}:${row.date}`)).size !== added.length) {
  throw new Error('runtime_evidence_added_duplicate')
}
for (const row of added) {
  const key = `${row.ticker}:${row.date}`
  const officialRow = officialByKey.get(key)
  if (existingKeys.has(key)) throw new Error(`runtime_evidence_added_already_in_baseline:${key}`)
  if (!officialRow || !sameJpOhlcvValue(row, officialRow)) {
    throw new Error(`runtime_evidence_added_not_current_official:${key}`)
  }
}
const merged = [...baseline, ...added].sort((left, right) => (
  left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)
))
const plan = buildJpOhlcvBackfillPlan({ date: targetDate, officialRows: official, existingRows: merged })
const actualConflicts = [...new Set(plan.conflicts.map((entry) => entry.ticker))].sort()
if (JSON.stringify(actualConflicts) !== JSON.stringify(expectedConflicts)) {
  throw new Error(`runtime_evidence_conflict_scope_changed:${actualConflicts.join(',')}`)
}
const output = {
  version: 1,
  evidenceKind: 'RECONSTRUCTED_FROM_BASELINE_AND_READ_ONLY_OBSERVATION',
  createdAt: new Date().toISOString(),
  provenance: {
    baselinePath,
    baselineSha256: stableSha256(baseline),
    observedAddedPath,
    observedAddedSha256: stableSha256(added),
    officialPath,
    officialSha256: plan.officialSha256,
  },
  reconstructedRows: merged,
  reconstructedRowsSha256: stableSha256(merged),
  plan,
}
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({
  status: 'PASS_RECONSTRUCTED_SCOPE',
  evidenceKind: output.evidenceKind,
  existingRows: plan.existingRows,
  matchingRows: plan.matchingRows,
  missingRows: plan.missingRows.length,
  conflicts: plan.conflicts.length,
  planSha256: plan.planSha256,
  output: outputPath,
}))
