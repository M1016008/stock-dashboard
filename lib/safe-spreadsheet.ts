import ExcelJS from 'exceljs'
import fs from 'node:fs/promises'
import path from 'node:path'

export type SpreadsheetRows = {
  sheetName: string
  rows: string[][]
}

export type SpreadsheetReadOptions = {
  sheetName?: string
  maxInputBytes?: number
  maxExpandedBytes?: number
  maxRows?: number
  maxColumns?: number
  maxCellCharacters?: number
}

const DEFAULT_LIMITS = {
  maxInputBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 128,
  maxCellCharacters: 32_767,
}

const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50

function limits(options: SpreadsheetReadOptions) {
  return {
    maxInputBytes: options.maxInputBytes ?? DEFAULT_LIMITS.maxInputBytes,
    maxExpandedBytes: options.maxExpandedBytes ?? DEFAULT_LIMITS.maxExpandedBytes,
    maxRows: options.maxRows ?? DEFAULT_LIMITS.maxRows,
    maxColumns: options.maxColumns ?? DEFAULT_LIMITS.maxColumns,
    maxCellCharacters: options.maxCellCharacters ?? DEFAULT_LIMITS.maxCellCharacters,
  }
}

function assertInputSize(buffer: Buffer, maxInputBytes: number): void {
  if (buffer.byteLength === 0) throw new Error('Spreadsheet input is empty.')
  if (buffer.byteLength > maxInputBytes) {
    throw new Error(`Spreadsheet input exceeds ${maxInputBytes} bytes.`)
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset
  }
  return -1
}

function assertSafeZip(buffer: Buffer, maxExpandedBytes: number): void {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error('Spreadsheet is not a valid XLSX ZIP container.')
  }

  const endOffset = findEndOfCentralDirectory(buffer)
  if (endOffset < 0) throw new Error('Spreadsheet ZIP directory is missing.')
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const directorySize = buffer.readUInt32LE(endOffset + 12)
  const directoryOffset = buffer.readUInt32LE(endOffset + 16)
  if (entryCount === 0 || entryCount === 0xffff || entryCount > 1_024) {
    throw new Error(`Spreadsheet ZIP entry count is invalid: ${entryCount}.`)
  }
  if (
    directorySize === 0xffffffff
    || directoryOffset === 0xffffffff
    || directoryOffset + directorySize > endOffset
  ) {
    throw new Error('Spreadsheet ZIP64 or malformed directory is not supported.')
  }

  let offset = directoryOffset
  let totalCompressed = 0
  let totalExpanded = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('Spreadsheet ZIP directory is malformed.')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const expandedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    if ((flags & 0x1) !== 0) throw new Error('Encrypted spreadsheet entries are not supported.')
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff) {
      throw new Error('Spreadsheet ZIP64 entries are not supported.')
    }
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > buffer.length) throw new Error('Spreadsheet ZIP entry exceeds its container.')
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (
      entryName.includes('\0')
      || entryName.startsWith('/')
      || entryName.startsWith('\\')
      || entryName.split(/[\\/]/).includes('..')
    ) {
      throw new Error('Spreadsheet ZIP contains an unsafe path.')
    }
    totalCompressed += compressedSize
    totalExpanded += expandedSize
    if (expandedSize > maxExpandedBytes || totalExpanded > maxExpandedBytes) {
      throw new Error(`Spreadsheet expands beyond ${maxExpandedBytes} bytes.`)
    }
    if (expandedSize > 1024 * 1024 && compressedSize > 0 && expandedSize / compressedSize > 250) {
      throw new Error('Spreadsheet ZIP compression ratio is unsafe.')
    }
    offset = nextOffset
  }
  if (offset > directoryOffset + directorySize || totalCompressed > buffer.length * 2) {
    throw new Error('Spreadsheet ZIP directory sizes are inconsistent.')
  }
}

function assertCell(value: string, row: number, column: number, maxCellCharacters: number): string {
  if (value.length > maxCellCharacters) {
    throw new Error(`Spreadsheet cell ${row}:${column} exceeds ${maxCellCharacters} characters.`)
  }
  return value
}

function spreadsheetCellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  if ('result' in record) return spreadsheetCellText(record.result)
  if (typeof record.text === 'string') return record.text
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) => (
        part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          ? String((part as Record<string, unknown>).text)
          : ''
      ))
      .join('')
  }
  if (record.error != null) return String(record.error)
  return ''
}

function parseDelimitedText(
  buffer: Buffer,
  delimiter: string,
  options: Required<ReturnType<typeof limits>>,
): SpreadsheetRows {
  const text = buffer.toString('utf8').replace(/^\ufeff/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  const pushCell = () => {
    if (row.length >= options.maxColumns) {
      throw new Error(`Spreadsheet exceeds ${options.maxColumns} columns.`)
    }
    row.push(assertCell(cell, rows.length + 1, row.length + 1, options.maxCellCharacters))
    cell = ''
  }
  const pushRow = () => {
    pushCell()
    if (row.some((value) => value !== '')) {
      if (rows.length >= options.maxRows) {
        throw new Error(`Spreadsheet exceeds ${options.maxRows} rows.`)
      }
      rows.push(row)
    }
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === delimiter && !quoted) {
      pushCell()
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      pushRow()
    } else {
      cell += character
      if (cell.length > options.maxCellCharacters) {
        throw new Error(`Spreadsheet cell exceeds ${options.maxCellCharacters} characters.`)
      }
    }
  }
  if (quoted) throw new Error('Spreadsheet CSV contains an unterminated quoted cell.')
  if (cell !== '' || row.length > 0) pushRow()
  return { sheetName: 'CSV', rows }
}

async function readXlsxBuffer(
  buffer: Buffer,
  options: SpreadsheetReadOptions,
): Promise<SpreadsheetRows> {
  const safeLimits = limits(options)
  assertInputSize(buffer, safeLimits.maxInputBytes)
  assertSafeZip(buffer, safeLimits.maxExpandedBytes)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
  const worksheet = options.sheetName
    ? workbook.getWorksheet(options.sheetName)
    : workbook.worksheets[0]
  if (!worksheet) throw new Error('Spreadsheet has no readable worksheets.')
  if (worksheet.actualRowCount > safeLimits.maxRows || worksheet.rowCount > safeLimits.maxRows) {
    throw new Error(`Spreadsheet exceeds ${safeLimits.maxRows} rows.`)
  }
  if (worksheet.actualColumnCount > safeLimits.maxColumns || worksheet.columnCount > safeLimits.maxColumns) {
    throw new Error(`Spreadsheet exceeds ${safeLimits.maxColumns} columns.`)
  }

  const rows: string[][] = []
  for (let rowIndex = 1; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    const sourceRow = worksheet.getRow(rowIndex)
    const width = Math.min(sourceRow.cellCount, safeLimits.maxColumns)
    const row: string[] = []
    for (let columnIndex = 1; columnIndex <= width; columnIndex += 1) {
      row.push(assertCell(
        spreadsheetCellText(sourceRow.getCell(columnIndex).value),
        rowIndex,
        columnIndex,
        safeLimits.maxCellCharacters,
      ))
    }
    rows.push(row)
  }
  return { sheetName: worksheet.name, rows }
}

export async function readSafeSpreadsheetBuffer(
  buffer: Buffer,
  options: SpreadsheetReadOptions = {},
): Promise<SpreadsheetRows> {
  return readXlsxBuffer(buffer, options)
}

export async function readSafeSpreadsheetFile(
  sourcePath: string,
  options: SpreadsheetReadOptions = {},
): Promise<SpreadsheetRows> {
  const safeLimits = limits(options)
  const stat = await fs.stat(sourcePath)
  if (!stat.isFile()) throw new Error(`Spreadsheet source is not a file: ${sourcePath}`)
  if (stat.size > safeLimits.maxInputBytes) {
    throw new Error(`Spreadsheet input exceeds ${safeLimits.maxInputBytes} bytes.`)
  }
  const buffer = await fs.readFile(sourcePath)
  assertInputSize(buffer, safeLimits.maxInputBytes)
  const extension = path.extname(sourcePath).toLowerCase()
  if (extension === '.csv' || extension === '.tsv') {
    return parseDelimitedText(buffer, extension === '.tsv' ? '\t' : ',', safeLimits)
  }
  if (extension !== '.xlsx') {
    throw new Error(`Unsupported spreadsheet extension: ${extension || '(none)'}`)
  }
  return readXlsxBuffer(buffer, options)
}
