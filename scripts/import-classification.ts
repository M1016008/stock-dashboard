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
  const profiles = source.profiles
  console.log(
    `Sheet "${source.sheetName}": ${source.rawRowCount} rows, `
    + `${source.majorCategoryCount} major categories, ${source.subIndustryCount} sub-industries, `
    + `${source.recoveredMissingSubIndustries.length} missing sub-industries recovered`,
  )
  console.log(`Importing ${records.length} unique valid records`)

  const CHUNK = 200
  await client.execute(`
    CREATE TEMP TABLE IF NOT EXISTS classification_import_tickers (
      ticker TEXT PRIMARY KEY
    )
  `)
  await client.execute('DELETE FROM classification_import_tickers')
  for (let i = 0; i < records.length; i += CHUNK) {
    await client.batch(
      records.slice(i, i + CHUNK).map((record) => ({
        sql: 'INSERT OR IGNORE INTO classification_import_tickers (ticker) VALUES (?)',
        args: [record.ticker],
      })),
      'write',
    )
  }

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

  let profileInserted = 0
  for (let i = 0; i < profiles.length; i += CHUNK) {
    const chunk = profiles.slice(i, i + CHUNK)
    await db
      .insert(stockShikihoProfiles)
      .values(chunk)
      .onConflictDoUpdate({
        target: stockShikihoProfiles.ticker,
        set: {
          forecastPer: sql`excluded.forecast_per`,
          actualPbr: sql`excluded.actual_pbr`,
          forecastRoe: sql`excluded.forecast_roe`,
          dividendYield: sql`excluded.dividend_yield`,
          headline1: sql`excluded.headline_1`,
          description1: sql`excluded.description_1`,
          headline2: sql`excluded.headline_2`,
          description2: sql`excluded.description_2`,
          issueLabel: sql`excluded.issue_label`,
          releaseDate: sql`excluded.release_date`,
          companyFeature: sql`excluded.company_feature`,
          consolidatedBusiness: sql`excluded.consolidated_business`,
          updatedAt: new Date(),
        },
      })
    profileInserted += chunk.length
  }

  const pruneResult = await client.execute(`
    DELETE FROM stock_classification
    WHERE ticker NOT IN (SELECT ticker FROM classification_import_tickers)
  `)
  const profilePruneResult = await client.execute(`
    DELETE FROM stock_shikiho_profiles
    WHERE ticker NOT IN (SELECT ticker FROM classification_import_tickers)
  `)
  await client.execute('DELETE FROM classification_import_tickers')

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
    + `旧プロフィール削除 ${profilePruneResult.rowsAffected} 件`,
  )
}

main().catch(e => { console.error(e); process.exit(1) })
