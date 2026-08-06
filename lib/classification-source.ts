import * as XLSX from 'xlsx'

export type ClassificationRecord = {
  ticker: string
  majorCategory: string
  subIndustry: string
}

type ClassificationRow = Record<string, unknown>

export type ClassificationSourceData = {
  sheetName: string
  rawRowCount: number
  records: ClassificationRecord[]
  skippedRows: number
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
  maxDuplicateTickers: number
}

function pick(row: ClassificationRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (value != null && String(value).trim() !== '') return String(value).trim()
  }
  return undefined
}

function normalizeTicker(value: string): string {
  const code = value.replace(/\.T$/i, '').replace(/\.JP$/i, '').trim().toUpperCase()
  return /^\d+$/.test(code) ? code.padStart(4, '0') : code
}

export function readClassificationSource(sourcePath: string): ClassificationSourceData {
  const workbook = XLSX.readFile(sourcePath)
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error('Classification source has no worksheets.')
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<ClassificationRow>(sheet)
  const recordsByTicker = new Map<string, ClassificationRecord>()
  const tickerCounts = new Map<string, number>()
  const invalidTickers = new Set<string>()
  let skippedRows = 0

  for (const row of rows) {
    const codeRaw = pick(row, ['コード', 'Code', 'code', 'ticker', '銘柄コード'])
    const majorCategory = pick(row, ['大分類', '業種大分類', 'major_category', 'Major'])
    const subIndustry = pick(row, ['業種細分類', '業種', '業界', 'sub_industry', 'SubIndustry'])
    if (!codeRaw || !majorCategory || !subIndustry) {
      skippedRows += 1
      continue
    }

    const ticker = normalizeTicker(codeRaw)
    if (!/^(?:\d{4}|\d{3}[A-Z])$/.test(ticker)) {
      invalidTickers.add(ticker)
      continue
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
    sheetName,
    rawRowCount: rows.length,
    records,
    skippedRows,
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
  if (source.duplicateTickers.length > options.maxDuplicateTickers) {
    issues.push(`duplicateTickers=${source.duplicateTickers.length}/${options.maxDuplicateTickers}`)
  }
  if (source.invalidTickers.length > 0) {
    issues.push(`invalidTickers=${source.invalidTickers.length}`)
  }
  if (source.multiParentSubIndustries.length > 0) {
    issues.push(`multiParentSubIndustries=${source.multiParentSubIndustries.length}`)
  }
  if (issues.length > 0) {
    throw new Error(`Classification source validation failed: ${issues.join(', ')}`)
  }
}

export function classificationValidationOptionsFromEnv(): ClassificationValidationOptions {
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
    maxDuplicateTickers: Math.max(
      0,
      Number(process.env.CLASSIFICATION_MAX_DUPLICATE_TICKERS ?? '0') || 0,
    ),
  }
}
