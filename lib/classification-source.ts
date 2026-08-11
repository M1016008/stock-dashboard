import { readSafeSpreadsheetFile } from '@/lib/safe-spreadsheet'

export type ClassificationRecord = {
  ticker: string
  majorCategory: string
  subIndustry: string
}

export type ClassificationSourceData = {
  sheetName: string
  rawRowCount: number
  records: ClassificationRecord[]
  skippedRows: number
  recoveredMissingSubIndustries: string[]
  invalidSubIndustries: string[]
  duplicateTickers: string[]
  invalidTickers: string[]
  majorCategoryCount: number
  subIndustryCount: number
  multiParentSubIndustries: string[]
}

export type ClassificationValidationOptions = {
  minRecords: number
  expectedMajorCategories: number
  minSubIndustries: number
  maxSkippedRows: number
  maxRecoveredMissingSubIndustries: number
  maxDuplicateTickers: number
}

const MISSING_SUB_INDUSTRY = '未分類'

function pick(row: string[], headerIndexes: Map<string, number>, keys: string[]): string | undefined {
  for (const key of keys) {
    const index = headerIndexes.get(key)
    const value = index == null ? undefined : row[index]
    if (value != null && String(value).trim() !== '') return String(value).trim()
  }
  return undefined
}

function normalizeTicker(value: string): string {
  const code = value.replace(/\.T$/i, '').replace(/\.JP$/i, '').trim().toUpperCase()
  return /^\d+$/.test(code) ? code.padStart(4, '0') : code
}

function looksLikeExcelDateSerial(value: string): boolean {
  if (/^\d{1,2}[\/-]\d{1,2}$/.test(value)) return true
  if (!/^\d+(?:\.0+)?$/.test(value)) return false
  const serial = Number(value)
  return Number.isInteger(serial) && serial >= 20_000 && serial <= 80_000
}

export async function readClassificationSource(sourcePath: string): Promise<ClassificationSourceData> {
  const spreadsheet = await readSafeSpreadsheetFile(sourcePath, {
    maxRows: 20_000,
    maxColumns: 64,
  })
  const header = spreadsheet.rows[0]
  if (!header) throw new Error('Classification source has no header row.')
  const headerIndexes = new Map<string, number>()
  for (const [index, value] of header.entries()) {
    const normalized = value.trim()
    if (!normalized || ['__proto__', 'prototype', 'constructor'].includes(normalized)) continue
    if (!headerIndexes.has(normalized)) headerIndexes.set(normalized, index)
  }
  const rows = spreadsheet.rows.slice(1).filter((row) => row.some((value) => value.trim() !== ''))
  const recordsByTicker = new Map<string, ClassificationRecord>()
  const tickerCounts = new Map<string, number>()
  const invalidTickers = new Set<string>()
  const recoveredMissingSubIndustries = new Set<string>()
  const invalidSubIndustries = new Set<string>()
  let skippedRows = 0

  for (const row of rows) {
    const codeRaw = pick(row, headerIndexes, ['コード', 'Code', 'code', 'ticker', '銘柄コード'])
    const majorCategory = pick(row, headerIndexes, ['大分類', '業種大分類', 'major_category', 'Major'])
    const subIndustryRaw = pick(row, headerIndexes, ['業種細分類', '業種', '業界', 'sub_industry', 'SubIndustry'])
    if (!codeRaw || !majorCategory || !subIndustryRaw) {
      skippedRows += 1
      continue
    }

    const ticker = normalizeTicker(codeRaw)
    if (!/^(?:\d{4}|\d{3}[A-Z])$/.test(ticker)) {
      invalidTickers.add(ticker)
      continue
    }
    const updateTime = pick(row, headerIndexes, ['更新時刻', 'updated_at', 'UpdatedAt'])
    const shiftedUpdateTime = !updateTime && looksLikeExcelDateSerial(subIndustryRaw)
    const subIndustry = shiftedUpdateTime ? MISSING_SUB_INDUSTRY : subIndustryRaw
    if (shiftedUpdateTime) recoveredMissingSubIndustries.add(ticker)
    if (/^\d+(?:\.\d+)?$/.test(subIndustry)) {
      invalidSubIndustries.add(`${ticker}:${subIndustry}`)
    }
    tickerCounts.set(ticker, (tickerCounts.get(ticker) ?? 0) + 1)
    recordsByTicker.set(ticker, { ticker, majorCategory, subIndustry })
  }

  const records = Array.from(recordsByTicker.values())
  const subIndustryParents = new Map<string, Set<string>>()
  for (const record of records) {
    const parents = subIndustryParents.get(record.subIndustry) ?? new Set<string>()
    parents.add(record.majorCategory)
    subIndustryParents.set(record.subIndustry, parents)
  }

  return {
    sheetName: spreadsheet.sheetName,
    rawRowCount: rows.length,
    records,
    skippedRows,
    recoveredMissingSubIndustries: Array.from(recoveredMissingSubIndustries).sort(),
    invalidSubIndustries: Array.from(invalidSubIndustries).sort(),
    duplicateTickers: Array.from(tickerCounts)
      .filter(([, count]) => count > 1)
      .map(([ticker]) => ticker)
      .sort(),
    invalidTickers: Array.from(invalidTickers).sort(),
    majorCategoryCount: new Set(records.map((record) => record.majorCategory)).size,
    subIndustryCount: new Set(records.map((record) => record.subIndustry)).size,
    multiParentSubIndustries: Array.from(subIndustryParents)
      .filter(([, parents]) => parents.size > 1)
      .map(([subIndustry]) => subIndustry)
      .sort(),
  }
}

export function validateClassificationSource(
  source: ClassificationSourceData,
  options: ClassificationValidationOptions,
): void {
  const issues: string[] = []
  if (source.records.length < options.minRecords) {
    issues.push(`records=${source.records.length}/${options.minRecords}`)
  }
  if (source.majorCategoryCount !== options.expectedMajorCategories) {
    issues.push(`majorCategories=${source.majorCategoryCount}/${options.expectedMajorCategories}`)
  }
  if (source.subIndustryCount < options.minSubIndustries) {
    issues.push(`subIndustries=${source.subIndustryCount}/${options.minSubIndustries}`)
  }
  if (source.skippedRows > options.maxSkippedRows) {
    issues.push(`skippedRows=${source.skippedRows}/${options.maxSkippedRows}`)
  }
  if (source.recoveredMissingSubIndustries.length > options.maxRecoveredMissingSubIndustries) {
    issues.push(
      `recoveredMissingSubIndustries=${source.recoveredMissingSubIndustries.length}`
      + `/${options.maxRecoveredMissingSubIndustries}`,
    )
  }
  if (source.duplicateTickers.length > options.maxDuplicateTickers) {
    issues.push(`duplicateTickers=${source.duplicateTickers.length}/${options.maxDuplicateTickers}`)
  }
  if (source.invalidTickers.length > 0) {
    issues.push(`invalidTickers=${source.invalidTickers.length}`)
  }
  if (source.invalidSubIndustries.length > 0) {
    issues.push(`invalidSubIndustries=${source.invalidSubIndustries.length}`)
  }
  if (source.multiParentSubIndustries.length > 0) {
    issues.push(`multiParentSubIndustries=${source.multiParentSubIndustries.length}`)
  }
  if (issues.length > 0) {
    throw new Error(`Classification source validation failed: ${issues.join(', ')}`)
  }
}

export function classificationValidationOptionsFromEnv(): ClassificationValidationOptions {
  const recoveredMissingLimit = Number(
    process.env.CLASSIFICATION_MAX_RECOVERED_MISSING_SUB_INDUSTRIES ?? '20',
  )
  return {
    minRecords: Math.max(1, Number(process.env.CLASSIFICATION_MIN_RECORDS ?? '3500') || 3500),
    expectedMajorCategories: Math.max(
      1,
      Number(process.env.CLASSIFICATION_EXPECTED_MAJOR_CATEGORIES ?? '60') || 60,
    ),
    minSubIndustries: Math.max(
      1,
      Number(process.env.CLASSIFICATION_MIN_SUB_INDUSTRIES ?? '450') || 450,
    ),
    maxSkippedRows: Math.max(
      0,
      Number(process.env.CLASSIFICATION_MAX_SKIPPED_ROWS ?? '0') || 0,
    ),
    maxRecoveredMissingSubIndustries: Number.isFinite(recoveredMissingLimit)
      ? Math.max(0, recoveredMissingLimit)
      : 20,
    maxDuplicateTickers: Math.max(
      0,
      Number(process.env.CLASSIFICATION_MAX_DUPLICATE_TICKERS ?? '0') || 0,
    ),
  }
}
