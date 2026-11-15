import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { assertPruneWithinLimit, importClassificationSource } from '../lib/classification-import'
import type { ClassificationSourceData, ShikihoProfileRecord } from '../lib/classification-source'

const DDL = [
  `CREATE TABLE stock_classification (ticker TEXT PRIMARY KEY, major_category TEXT NOT NULL,
    sub_industry TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
  `CREATE TABLE stock_shikiho_profiles (ticker TEXT PRIMARY KEY, forecast_per REAL, actual_pbr REAL,
    forecast_roe REAL, dividend_yield REAL, headline_1 TEXT, description_1 TEXT, headline_2 TEXT,
    description_2 TEXT, issue_label TEXT, release_date TEXT, company_feature TEXT, consolidated_business TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`,
  `CREATE TABLE stock_shikiho_rivals (ticker TEXT NOT NULL, position INTEGER NOT NULL, rival_code TEXT,
    rival_name TEXT NOT NULL, issue_label TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (ticker, position))`,
]

const profile = (ticker: string): ShikihoProfileRecord => ({
  ticker, forecastPer: 10, actualPbr: 1, forecastRoe: 8, dividendYield: 2, headline1: '見出し', description1: '本文',
  headline2: null, description2: null, issueLabel: '2026年4集秋号', releaseDate: '2026年9月16日',
  companyFeature: '特色', consolidatedBusiness: '事業100',
})

function source(tickers: string[], rivals: boolean): ClassificationSourceData {
  return {
    sheetName: 'csv', rawRowCount: tickers.length,
    records: tickers.map((ticker) => ({ ticker, majorCategory: '大分類', subIndustry: '細分類' })),
    profiles: tickers.map(profile),
    hasRivalsColumn: rivals,
    rivals: rivals ? tickers.map((ticker) => ({ ticker, position: 1, rivalCode: '7203', rivalName: 'トヨタ', issueLabel: '2026年4集秋号' })) : [],
    invalidRivalEntries: [], skippedRows: 0, recoveredMissingSubIndustries: [], invalidSubIndustries: [],
    duplicateTickers: [], invalidTickers: [], majorCategoryCount: 1, subIndustryCount: 1, multiParentSubIndustries: [],
  }
}

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-classification-import-'))
  const client = createClient({ url: `file:${path.join(directory, 'test.db')}` })
  try {
    for (const statement of DDL) await client.execute(statement)
    const scalar = async (sql: string) => Number((await client.execute(sql)).rows[0]?.n)
    const all = Array.from({ length: 4000 }, (_, i) => String(1000 + i))

    // 1. 列の無い CSV: 分類とプロフィールだけ入り、比較会社の表には触れない。
    await client.execute("INSERT INTO stock_shikiho_rivals (ticker, position, rival_code, rival_name) VALUES ('1000', 1, '9999', '既存')")
    let result = await importClassificationSource(client, source(all, false))
    assert.equal(result.classifications, 4000)
    assert.equal(result.rivals, null)
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_classification'), 4000)
    assert.equal(await scalar("SELECT COUNT(*) AS n FROM stock_shikiho_rivals WHERE rival_code='9999'"), 1)

    // 2. 列のある CSV: 比較会社を入れ替える。
    result = await importClassificationSource(client, source(all, true))
    assert.equal(result.rivals, 4000)
    assert.equal(await scalar("SELECT COUNT(*) AS n FROM stock_shikiho_rivals WHERE rival_code='9999'"), 0)

    // 3. 30 件までの削除は通る (4000 行の 1% は 40 なので、上限は 30)。
    result = await importClassificationSource(client, source(all.slice(0, 3970), true))
    assert.equal(result.prunedClassifications, 30)
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_classification'), 3970)

    // 4. 31 件の削除は、書き込む前に止まり、何も変わらない。
    await client.execute("UPDATE stock_classification SET major_category='変更前'")
    await assert.rejects(
      () => importClassificationSource(client, source(all.slice(0, 3939), true)),
      /too many rows from stock_classification: 31 of 3970 \(limit 30\)/,
    )
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_classification'), 3970)
    assert.equal(await scalar("SELECT COUNT(*) AS n FROM stock_classification WHERE major_category='変更前'"), 3970)
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_shikiho_rivals'), 3970)

    // 5. オーナーが確かめた件数ちょうどなら通る。違う件数なら止まる。
    await assert.rejects(() => importClassificationSource(client, source(all.slice(0, 3939), true), { expectedPruneRows: 30 }))
    result = await importClassificationSource(client, source(all.slice(0, 3939), true), { expectedPruneRows: 31 })
    assert.equal(result.prunedClassifications, 31)

    // 6. 比較会社の欄が空になる銘柄が多すぎるときも止まる (銘柄は CSV に残っている)。
    const emptied = source(all.slice(0, 3939), true)
    emptied.rivals = emptied.rivals.slice(0, 3900)
    await assert.rejects(() => importClassificationSource(client, emptied), /stock_shikiho_rivals \(emptied\): 39 of 3939/)
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_shikiho_rivals'), 3939)

    // 6b. 銘柄ごとの比較会社が一斉に減るとき (3 社 → 1 社) は、行の総数の 5% の確認で止まる。
    const three = source(all.slice(0, 3939), true)
    three.rivals = three.rivals.flatMap((rival) => [1, 2, 3].map((position) => ({ ...rival, position })))
    await importClassificationSource(client, three)
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_shikiho_rivals'), 3939 * 3)
    await assert.rejects(() => importClassificationSource(client, source(all.slice(0, 3939), true)), /shrink stock_shikiho_rivals too much/)
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_shikiho_rivals'), 3939 * 3)
    await importClassificationSource(client, three)

    // 6c. オーナーが確かめた件数 (CSV から消える銘柄の数) は、比較会社の無い銘柄があっても通る。
    await client.execute("DELETE FROM stock_shikiho_rivals WHERE ticker IN ('4900', '4901')")
    const approved = source(all.slice(0, 3900), true)
    approved.rivals = approved.rivals.flatMap((rival) => [1, 2, 3].map((position) => ({ ...rival, position })))
    const approvedResult = await importClassificationSource(client, approved, { expectedPruneRows: 39 })
    assert.equal(approvedResult.prunedClassifications, 39)
    assert.equal(approvedResult.prunedRivals, 37)
    await importClassificationSource(client, three, { expectedPruneRows: 0 })

    // 7. 分類とプロフィールを書いた後で失敗したら (比較会社の挿入で NOT NULL 違反)、すべて元に戻る。
    await client.execute("UPDATE stock_classification SET major_category='失敗前'")
    const broken = source(all.slice(0, 3939), true)
    broken.rivals = broken.rivals.flatMap((rival) => [1, 2, 3].map((position) => ({ ...rival, position })))
    broken.records = broken.records.map((record) => ({ ...record, majorCategory: '書き込み後' }))
    broken.rivals[broken.rivals.length - 1] = { ...broken.rivals[broken.rivals.length - 1], rivalName: null as unknown as string }
    await assert.rejects(() => importClassificationSource(client, broken), /NOT NULL/)
    assert.equal(await scalar("SELECT COUNT(*) AS n FROM stock_classification WHERE major_category='失敗前'"), 3939)
    assert.equal(await scalar('SELECT COUNT(*) AS n FROM stock_shikiho_rivals'), 3939 * 3)

    // 8. 上限の計算: 小さい表では 1% が先に効く。
    assert.throws(() => assertPruneWithinLimit({ table: 't', currentRows: 500, pruneRows: 6 }), /limit 5/)
    assertPruneWithinLimit({ table: 't', currentRows: 500, pruneRows: 5 })
    assertPruneWithinLimit({ table: 't', currentRows: 0, pruneRows: 0 })
  } finally {
    client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main()
  .then(() => console.log('classification import tests: ok'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
