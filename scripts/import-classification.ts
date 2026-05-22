// scripts/import-classification.ts
//
// Phase 4 A2: Yoshio さん独自の Excel から 大分類 × 業種細分類 を stock_classification に取り込む。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run import:classification
//   USE_LOCAL_DB=1 CLASSIFICATION_EXCEL=./path/to/file.xlsx npm run import:classification
//
// Excel 要件:
//   - 1 シート目に「コード」「大分類」「業種細分類」列を含む

import { db, client } from '@/lib/db/client'
import { stockClassification } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'
import * as XLSX from 'xlsx'
import fs from 'node:fs'
import { ensureSchema } from '@/lib/db/migrate'

const EXCEL_PATH = process.env.CLASSIFICATION_EXCEL ?? './data/classification.xlsx'

interface ExcelRow {
  コード?: string | number
  大分類?: string
  業種細分類?: string
  // 名称ゆらぎ対応 (中分類, 業種大分類 等)
  業種大分類?: string
  業種?: string
  業界?: string
}

function pick(row: ExcelRow, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = (row as Record<string, unknown>)[k]
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return undefined
}

async function main() {
  await ensureSchema(client)

  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`Excel file not found: ${EXCEL_PATH}`)
    console.error('Place the classification Excel at this path or set CLASSIFICATION_EXCEL env var.')
    process.exit(1)
  }

  console.log(`Reading ${EXCEL_PATH}...`)
  const wb = XLSX.readFile(EXCEL_PATH)
  const sheetName = wb.SheetNames[0]
  const sheet = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<ExcelRow>(sheet)
  console.log(`Sheet "${sheetName}": ${rows.length} rows`)

  let skipped = 0
  const records = rows
    .map(r => {
      const codeRaw = pick(r, ['コード', 'Code', 'code', 'ticker', '銘柄コード'])
      const major = pick(r, ['大分類', '業種大分類', 'major_category', 'Major'])
      const sub = pick(r, ['業種細分類', '業種', '業界', 'sub_industry', 'SubIndustry'])
      if (!codeRaw || !major || !sub) {
        skipped++
        return null
      }
      // ".T" や ".JP" サフィックスがあれば落とし、数値なら 4 桁ゼロ埋め
      const code = codeRaw.replace(/\.T$/i, '').replace(/\.JP$/i, '').trim()
      const ticker = /^\d+$/.test(code) ? code.padStart(4, '0') : code
      return { ticker, majorCategory: major, subIndustry: sub }
    })
    .filter((r): r is { ticker: string; majorCategory: string; subIndustry: string } => r !== null)

  console.log(`Importing ${records.length} valid records (skipped ${skipped}, missing required cols)`)

  const CHUNK = 200
  let inserted = 0
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK)
    await db
      .insert(stockClassification)
      .values(chunk)
      .onConflictDoUpdate({
        target: stockClassification.ticker,
        set: {
          majorCategory: sql`excluded.major_category`,
          subIndustry:   sql`excluded.sub_industry`,
          updatedAt:     new Date(),
        },
      })
    inserted += chunk.length
  }

  // 集計表示
  const majorCount = await db
    .select({ n: sql<number>`COUNT(DISTINCT major_category)` })
    .from(stockClassification)
  const subCount = await db
    .select({ n: sql<number>`COUNT(DISTINCT sub_industry)` })
    .from(stockClassification)

  console.log(`完了: ${inserted} 件取り込み / 大分類 ${majorCount[0]?.n ?? 0} 種 / 業種細分類 ${subCount[0]?.n ?? 0} 種`)
}

main().catch(e => { console.error(e); process.exit(1) })
