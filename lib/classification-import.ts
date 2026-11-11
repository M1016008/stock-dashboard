// 四季報の分類 CSV を、分類・四季報プロフィール・比較会社の表へ 1 つのトランザクションで取り込む。
// CSV に無い銘柄の削除は、件数が多すぎるときは書き込む前に止める (30 件または現在の行数の 1% を超えたら)。
import type { Client, InStatement } from '@libsql/client'
import type { ClassificationSourceData } from '@/lib/classification-source'

export const MAX_PRUNE_ROWS = 30
export const MAX_PRUNE_RATIO = 0.01
export const MAX_RIVAL_ROW_DROP_RATIO = 0.05
const CHUNK = 200

export type ClassificationImportResult = {
  classifications: number
  profiles: number
  rivals: number | null
  prunedClassifications: number
  prunedProfiles: number
  prunedRivals: number | null
}

// 削除してよい件数の上限。現在の行数の 1% と 30 件の小さい方。
// オーナーが件数を確かめて承認した場合だけ、expectedPruneRows にその件数ちょうどを渡して通す。
export function assertPruneWithinLimit(input: {
  table: string
  currentRows: number
  pruneRows: number
  expectedPruneRows?: number | null
}): void {
  if (input.expectedPruneRows != null && input.expectedPruneRows === input.pruneRows) return
  const limit = Math.min(MAX_PRUNE_ROWS, Math.floor(input.currentRows * MAX_PRUNE_RATIO))
  if (input.pruneRows > limit) {
    throw new Error(
      `Classification import would delete too many rows from ${input.table}: `
      + `${input.pruneRows} of ${input.currentRows} (limit ${limit}). Nothing was written.`,
    )
  }
}

function count(value: unknown): number {
  return Number(value ?? 0)
}

export async function importClassificationSource(
  client: Client,
  source: ClassificationSourceData,
  options: { expectedPruneRows?: number | null } = {},
): Promise<ClassificationImportResult> {
  const tx = await client.transaction('write')
  try {
    await tx.execute('CREATE TEMP TABLE IF NOT EXISTS classification_import_tickers (ticker TEXT PRIMARY KEY)')
    await tx.execute('DELETE FROM classification_import_tickers')
    for (let i = 0; i < source.records.length; i += CHUNK) {
      const chunk = source.records.slice(i, i + CHUNK)
      await tx.execute({
        sql: `INSERT OR IGNORE INTO classification_import_tickers (ticker) VALUES ${chunk.map(() => '(?)').join(',')}`,
        args: chunk.map((record) => record.ticker),
      })
    }

    // 書き込む前に、削除の件数を確かめる。
    const pruneTables = ['stock_classification', 'stock_shikiho_profiles']
    const pruneCounts: Record<string, number> = {}
    if (source.hasRivalsColumn) {
      // 比較会社は表ごと入れ替える。CSV から消えた銘柄の比較会社は、下の分類の削除の確認で扱う。
      // ここでは (1) CSV に残っているのに比較会社が空になる銘柄の数を、分類と同じ上限 (30 件または 1%) で、
      // (2) 比較会社の行の総数の減り方を 5% までで確かめる (読み取りが壊れて件数が一斉に減った場合に止めるため)。
      const existing = (await tx.execute(
        'SELECT ticker, COUNT(*) AS n FROM stock_shikiho_rivals GROUP BY ticker',
      )).rows.map((row) => ({ ticker: String(row.ticker), rows: count(row.n) }))
      const importing = new Set(source.records.map((record) => record.ticker))
      const incoming = new Set(source.rivals.map((rival) => rival.ticker))
      const emptied = existing.filter((row) => importing.has(row.ticker) && !incoming.has(row.ticker)).length
      pruneCounts.stock_shikiho_rivals = existing.filter((row) => !importing.has(row.ticker)).length
      assertPruneWithinLimit({ table: 'stock_shikiho_rivals (emptied)', currentRows: existing.length, pruneRows: emptied })
      const existingRows = existing.reduce((sum, row) => sum + row.rows, 0)
      const keptRows = existing.filter((row) => !importing.has(row.ticker)).reduce((sum, row) => sum + row.rows, 0)
      const comparableRows = existingRows - keptRows
      if (comparableRows > 0 && source.rivals.length < Math.floor(comparableRows * (1 - MAX_RIVAL_ROW_DROP_RATIO))) {
        throw new Error(
          `Classification import would shrink stock_shikiho_rivals too much: ${source.rivals.length} rows `
          + `for tickers that had ${comparableRows} (allowed drop ${MAX_RIVAL_ROW_DROP_RATIO * 100}%). Nothing was written.`,
        )
      }
    }
    for (const table of pruneTables) {
      const current = await tx.execute(`SELECT COUNT(DISTINCT ticker) AS n FROM ${table}`)
      const prune = await tx.execute(
        `SELECT COUNT(DISTINCT ticker) AS n FROM ${table} WHERE ticker NOT IN (SELECT ticker FROM classification_import_tickers)`,
      )
      pruneCounts[table] = count(prune.rows[0]?.n)
      assertPruneWithinLimit({
        table,
        currentRows: count(current.rows[0]?.n),
        pruneRows: pruneCounts[table],
        expectedPruneRows: options.expectedPruneRows,
      })
    }

    const statements: InStatement[] = []
    for (let i = 0; i < source.records.length; i += CHUNK) {
      const chunk = source.records.slice(i, i + CHUNK)
      statements.push({
        sql: `INSERT INTO stock_classification (ticker, major_category, sub_industry, updated_at)
          VALUES ${chunk.map(() => '(?, ?, ?, unixepoch())').join(',')}
          ON CONFLICT(ticker) DO UPDATE SET major_category=excluded.major_category,
            sub_industry=excluded.sub_industry, updated_at=excluded.updated_at`,
        args: chunk.flatMap((record) => [record.ticker, record.majorCategory, record.subIndustry]),
      })
    }
    for (let i = 0; i < source.profiles.length; i += CHUNK) {
      const chunk = source.profiles.slice(i, i + CHUNK)
      statements.push({
        sql: `INSERT INTO stock_shikiho_profiles (ticker, forecast_per, actual_pbr, forecast_roe, dividend_yield,
            headline_1, description_1, headline_2, description_2, issue_label, release_date,
            company_feature, consolidated_business, updated_at)
          VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())').join(',')}
          ON CONFLICT(ticker) DO UPDATE SET forecast_per=excluded.forecast_per, actual_pbr=excluded.actual_pbr,
            forecast_roe=excluded.forecast_roe, dividend_yield=excluded.dividend_yield,
            headline_1=excluded.headline_1, description_1=excluded.description_1,
            headline_2=excluded.headline_2, description_2=excluded.description_2,
            issue_label=excluded.issue_label, release_date=excluded.release_date,
            company_feature=excluded.company_feature, consolidated_business=excluded.consolidated_business,
            updated_at=excluded.updated_at`,
        args: chunk.flatMap((profile) => [profile.ticker, profile.forecastPer, profile.actualPbr,
          profile.forecastRoe, profile.dividendYield, profile.headline1, profile.description1,
          profile.headline2, profile.description2, profile.issueLabel, profile.releaseDate,
          profile.companyFeature, profile.consolidatedBusiness]),
      })
    }
    statements.push('DELETE FROM stock_classification WHERE ticker NOT IN (SELECT ticker FROM classification_import_tickers)')
    statements.push('DELETE FROM stock_shikiho_profiles WHERE ticker NOT IN (SELECT ticker FROM classification_import_tickers)')
    if (source.hasRivalsColumn) {
      // 取り込む銘柄の比較会社は、CSV の内容で入れ替える。CSV に無い銘柄の比較会社は消す。
      statements.push('DELETE FROM stock_shikiho_rivals')
      for (let i = 0; i < source.rivals.length; i += CHUNK) {
        const chunk = source.rivals.slice(i, i + CHUNK)
        statements.push({
          sql: `INSERT INTO stock_shikiho_rivals (ticker, position, rival_code, rival_name, issue_label, updated_at)
            VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, unixepoch())').join(',')}`,
          args: chunk.flatMap((rival) => [rival.ticker, rival.position, rival.rivalCode, rival.rivalName, rival.issueLabel]),
        })
      }
    }
    for (const statement of statements) await tx.execute(statement)
    await tx.execute('DELETE FROM classification_import_tickers')
    await tx.commit()
    return {
      classifications: source.records.length,
      profiles: source.profiles.length,
      rivals: source.hasRivalsColumn ? source.rivals.length : null,
      prunedClassifications: pruneCounts.stock_classification,
      prunedProfiles: pruneCounts.stock_shikiho_profiles,
      prunedRivals: source.hasRivalsColumn ? pruneCounts.stock_shikiho_rivals : null,
    }
  } catch (error) {
    await tx.rollback()
    throw error
  } finally {
    tx.close()
  }
}
