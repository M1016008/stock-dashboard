// scripts/import-classification.ts
//
// Phase 4 A2: Yoshio さん独自の CSV / Excel から 大分類 × 業種細分類 を stock_classification に取り込む。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run import:classification
//   USE_LOCAL_DB=1 CLASSIFICATION_FILE=./path/to/file.csv npm run import:classification
//   USE_LOCAL_DB=1 CLASSIFICATION_FILE=./path/to/file.xlsx npm run import:classification
//
// ファイル要件:
//   - CSV、または Excel の1シート目に「コード」「大分類」「業種細分類」列を含む

import { db, client } from '@/lib/db/client'
import { stockClassification, stockShikihoProfiles } from '@/lib/db/schema'
import { importClassificationSource } from '@/lib/classification-import'
import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import { ensureSchema } from '@/lib/db/migrate'
import {
  classificationValidationOptionsFromEnv,
  readClassificationSource,
  validateClassificationSource,
} from '@/lib/classification-source'

const SOURCE_PATH = process.env.CLASSIFICATION_FILE
  ?? process.env.CLASSIFICATION_EXCEL
  ?? './data/classification.xlsx'
async function main() {
  await ensureSchema(client)

  if (!fs.existsSync(SOURCE_PATH)) {
    console.error(`Classification file not found: ${SOURCE_PATH}`)
    console.error('Place the CSV / Excel at this path or set CLASSIFICATION_FILE env var.')
    process.exit(1)
  }

  console.log(`Reading ${SOURCE_PATH}...`)
  const source = await readClassificationSource(SOURCE_PATH)
  validateClassificationSource(source, classificationValidationOptionsFromEnv())
  const records = source.records
  console.log(
    `Sheet "${source.sheetName}": ${source.rawRowCount} rows, `
    + `${source.majorCategoryCount} major categories, ${source.subIndustryCount} sub-industries, `
    + `${source.recoveredMissingSubIndustries.length} missing sub-industries recovered`,
  )
  console.log(
    `Importing ${records.length} unique valid records`
    + (source.hasRivalsColumn
      ? `, ${source.rivals.length} rivals (${source.invalidRivalEntries.length} invalid entries skipped)`
      : ', no rivals column (rivals table untouched)'),
  )
  // 削除の件数がオーナーの確認済みのときだけ、その件数ちょうどを渡す (既定は 30 件または 1% で止める)。
  const expectedPruneRows = process.env.CLASSIFICATION_EXPECTED_PRUNE_ROWS
  const result = await importClassificationSource(client, source, {
    expectedPruneRows: expectedPruneRows ? Number(expectedPruneRows) : null,
  })
  const inserted = result.classifications
  const profileInserted = result.profiles
  const pruneResult = { rowsAffected: result.prunedClassifications }
  const profilePruneResult = { rowsAffected: result.prunedProfiles }

  // 集計表示
  const majorCount = await db
    .select({ n: sql<number>`COUNT(DISTINCT major_category)` })
    .from(stockClassification)
  const subCount = await db
    .select({ n: sql<number>`COUNT(DISTINCT sub_industry)` })
    .from(stockClassification)
  const rowCount = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(stockClassification)
  const profileCount = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(stockShikihoProfiles)

  console.log(
    `完了: ソース ${inserted} 件 / DB合計 ${rowCount[0]?.n ?? 0} 件 / `
    + `大分類 ${majorCount[0]?.n ?? 0} 種 / 業種細分類 ${subCount[0]?.n ?? 0} 種 / `
    + `四季報プロフィール ${profileInserted}/${profileCount[0]?.n ?? 0} 件 / `
    + `旧分類削除 ${pruneResult.rowsAffected} 件 / `
    + `旧プロフィール削除 ${profilePruneResult.rowsAffected} 件 / `
    + `比較会社 ${result.rivals ?? '(列なし)'} 件`,
  )
}

main().catch(e => { console.error(e); process.exit(1) })
