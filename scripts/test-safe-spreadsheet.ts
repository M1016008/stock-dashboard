import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import {
  readSafeSpreadsheetBuffer,
  readSafeSpreadsheetFile,
} from '@/lib/safe-spreadsheet'
import { parseJpxEarningsWorkbook } from '@/lib/jpx-earnings'

async function main(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stockboard-spreadsheet-'))
  try {
    const workbook = new ExcelJS.Workbook()
    const first = workbook.addWorksheet('最初')
    first.addRow(['コード', '会社名'])
    first.addRow(['7003', '三井E&S'])
    const holdings = workbook.addWorksheet('保有明細')
    holdings.addRow(['Code', 'Weight'])
    holdings.addRow(['7003', 12.5])
    const merged = workbook.addWorksheet('結合セル')
    merged.mergeCells('A1:B1')
    merged.addRow(['7003', '三井E&S'])
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer())

    const selected = await readSafeSpreadsheetBuffer(xlsx, { sheetName: '保有明細' })
    assert.equal(selected.sheetName, '保有明細')
    assert.deepEqual(selected.rows, [['Code', 'Weight'], ['7003', '12.5']])
    const mergedRows = await readSafeSpreadsheetBuffer(xlsx, { sheetName: '結合セル' })
    assert.deepEqual(mergedRows.rows, [['', ''], ['7003', '三井E&S']])

    const jpxWorkbook = new ExcelJS.Workbook()
    const jpxSheet = jpxWorkbook.addWorksheet('List')
    jpxSheet.addRow(['決算発表予定日\nScheduled Dates for Earnings Announcements', 'コード\nCode', '会社名'])
    jpxSheet.addRow([new Date('2026-08-12T00:00:00Z'), '7003', '三井E&S'])
    const jpxRows = await parseJpxEarningsWorkbook(
      Buffer.from(await jpxWorkbook.xlsx.writeBuffer()),
      { url: 'https://www.jpx.co.jp/test.xlsx', title: '2026年8月12日開示予定分' },
    )
    assert.equal(jpxRows.length, 1)
    assert.equal(jpxRows[0].announceDate, '2026-08-12')
    assert.equal(jpxRows[0].ticker, '7003')
    await assert.rejects(
      readSafeSpreadsheetBuffer(xlsx, { maxInputBytes: 4 }),
      /exceeds 4 bytes/,
    )
    await assert.rejects(
      readSafeSpreadsheetBuffer(xlsx, { maxRows: 1 }),
      /exceeds 1 rows/,
    )

    const csvPath = path.join(directory, 'quoted.csv')
    await fs.writeFile(csvPath, '\ufeffcode,name\r\n7003,"三井,E&S"\r\n', 'utf8')
    const csv = await readSafeSpreadsheetFile(csvPath)
    assert.equal(csv.sheetName, 'CSV')
    assert.deepEqual(csv.rows, [['code', 'name'], ['7003', '三井,E&S']])

    const malformedPath = path.join(directory, 'malformed.csv')
    await fs.writeFile(malformedPath, 'code,name\n7003,"unterminated', 'utf8')
    await assert.rejects(readSafeSpreadsheetFile(malformedPath), /unterminated quoted cell/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

main()
  .then(() => console.log('safe spreadsheet tests: ok'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
