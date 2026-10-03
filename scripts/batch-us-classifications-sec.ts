// SEC EDGARのSIC情報をUS銘柄分類マスタへ保存する。
// 価格データはTiingoを第一参照にし、Tiingoにない業種分類だけをSECで補完する。

import { db, ensureReady, execAll, execGet } from '@/lib/db/client'
import { marketClassifications, marketUniverse } from '@/lib/db/schema'
import { US_SEC_SIC_TAXONOMY, sectorFromSic, usClassificationTickerAliases } from '@/lib/us-classification'
import { and, eq, sql } from 'drizzle-orm'

const MARKET = 'US'
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json'
const SEC_SUBMISSIONS_BASE = 'https://data.sec.gov/submissions/'
const RATE_LIMIT_MS = Number(process.env.SEC_RATE_LIMIT_MS ?? 150)
const LIMIT = Number(process.env.US_CLASSIFICATION_LIMIT ?? 0)
const REFRESH = process.env.US_CLASSIFICATION_REFRESH === '1'
const INCLUDE_INACTIVE = process.env.US_INCLUDE_INACTIVE === '1'
const TICKERS = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)

type SecCompanyTickersExchange = {
  fields: string[]
  data: Array<Array<string | number | null>>
}

type SecSubmission = {
  cik: string
  entityType?: string
  sic?: string
  sicDescription?: string
  name?: string
  tickers?: string[]
  exchanges?: string[]
  category?: string
}

type Target = {
  ticker: string
  name: string | null
  active: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function secUserAgent(): string {
  return process.env.SEC_USER_AGENT?.trim() || `StockBoard/1.0 (${process.env.USER ?? 'local'}; set SEC_USER_AGENT for contact)`
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': secUserAgent(),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SEC fetch failed: HTTP ${res.status}${body ? ` ${body.slice(0, 160)}` : ''}`)
  }
  return await res.json() as T
}

async function loadSecTickerMap(): Promise<Map<string, { cik: string; name: string; exchange: string }>> {
  const payload = await fetchJson<SecCompanyTickersExchange>(SEC_COMPANY_TICKERS_URL)
  const cikIndex = payload.fields.indexOf('cik')
  const nameIndex = payload.fields.indexOf('name')
  const tickerIndex = payload.fields.indexOf('ticker')
  const exchangeIndex = payload.fields.indexOf('exchange')
  const map = new Map<string, { cik: string; name: string; exchange: string }>()
  for (const row of payload.data) {
    const ticker = String(row[tickerIndex] ?? '').trim().toUpperCase()
    const cik = String(row[cikIndex] ?? '').padStart(10, '0')
    if (!ticker || !cik) continue
    const item = {
      cik,
      name: String(row[nameIndex] ?? ''),
      exchange: String(row[exchangeIndex] ?? ''),
    }
    for (const alias of usClassificationTickerAliases(ticker)) {
      if (!map.has(alias)) map.set(alias, item)
    }
  }
  return map
}

async function fetchSubmission(cik: string): Promise<SecSubmission> {
  await sleep(RATE_LIMIT_MS)
  return await fetchJson<SecSubmission>(`${SEC_SUBMISSIONS_BASE}CIK${cik}.json`)
}

async function loadTargets(): Promise<Target[]> {
  const args: Array<string | number> = [MARKET, INCLUDE_INACTIVE ? 1 : 0]
  const tickerFilter = TICKERS?.length
    ? `AND u.ticker IN (${TICKERS.map(() => '?').join(',')})`
    : ''
  if (TICKERS?.length) args.push(...TICKERS)
  if (!REFRESH) args.push(MARKET, US_SEC_SIC_TAXONOMY)
  if (LIMIT > 0) args.push(LIMIT)

  return await execAll<Target>(
    `
    SELECT u.ticker, u.name, CASE WHEN u.active THEN 1 ELSE 0 END AS active
    FROM market_universe u
    ${REFRESH ? '' : `
      LEFT JOIN market_classifications c
        ON c.market = u.market
       AND c.ticker = u.ticker
       AND c.taxonomy = ?
       AND c.effective_from = '0000-01-01'
    `}
    WHERE u.market = ?
      AND (? = 1 OR u.active = 1)
      ${tickerFilter}
      ${REFRESH ? '' : `AND c.ticker IS NULL`}
    ORDER BY u.active DESC, u.ticker
    ${LIMIT > 0 ? 'LIMIT ?' : ''}
    `,
    REFRESH
      ? args
      : [US_SEC_SIC_TAXONOMY, MARKET, INCLUDE_INACTIVE ? 1 : 0, ...(TICKERS ?? []), ...(LIMIT > 0 ? [LIMIT] : [])],
  )
}

function buildRawJson(target: Target, secMatch: { cik: string; name: string; exchange: string }, submission: SecSubmission): string {
  return JSON.stringify({
    target,
    secMatch,
    submission: {
      cik: submission.cik,
      entityType: submission.entityType,
      sic: submission.sic,
      sicDescription: submission.sicDescription,
      name: submission.name,
      tickers: submission.tickers,
      exchanges: submission.exchanges,
      category: submission.category,
    },
  })
}

async function main() {
  await ensureReady()
  const targets = await loadTargets()
  const secTickers = await loadSecTickerMap()
  let matched = 0
  let classified = 0
  let unknown = 0
  let failed = 0
  const errors: string[] = []

  console.log(`US SEC classification start: targets=${targets.length}, refresh=${REFRESH}, includeInactive=${INCLUDE_INACTIVE}`)

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]
    const secMatch = usClassificationTickerAliases(target.ticker)
      .map((alias) => secTickers.get(alias))
      .find(Boolean)

    if (!secMatch) {
      unknown += 1
      continue
    }

    matched += 1
    try {
      const submission = await fetchSubmission(secMatch.cik)
      const industryCode = submission.sic?.trim() || null
      const industryName = submission.sicDescription?.trim() || null
      const sector = sectorFromSic(industryCode)
      await db.insert(marketClassifications).values({
        market: MARKET,
        ticker: target.ticker,
        taxonomy: US_SEC_SIC_TAXONOMY,
        effectiveFrom: '0000-01-01',
        effectiveTo: null,
        sectorCode: sector.sectorCode,
        sectorName: sector.sectorName,
        industryCode,
        industryName,
        source: 'sec_edgar_submissions',
        confidence: industryCode ? 0.82 : 0.35,
        rawJson: buildRawJson(target, secMatch, submission),
      }).onConflictDoUpdate({
        target: [
          marketClassifications.market,
          marketClassifications.ticker,
          marketClassifications.taxonomy,
          marketClassifications.effectiveFrom,
        ],
        set: {
          effectiveTo: null,
          sectorCode: sql`excluded.sector_code`,
          sectorName: sql`excluded.sector_name`,
          industryCode: sql`excluded.industry_code`,
          industryName: sql`excluded.industry_name`,
          source: sql`excluded.source`,
          confidence: sql`excluded.confidence`,
          rawJson: sql`excluded.raw_json`,
          updatedAt: sql`unixepoch()`,
        },
      })

      await db.update(marketUniverse).set({
        sector: sector.sectorName,
        industry: industryName,
        sourcePayloadJson: sql`json_patch(COALESCE(source_payload_json, '{}'), json_object('classificationTaxonomy', ${US_SEC_SIC_TAXONOMY}, 'classificationSource', 'sec_edgar_submissions', 'sic', ${industryCode}, 'sicDescription', ${industryName}))`,
        updatedAt: new Date(),
      }).where(and(eq(marketUniverse.market, MARKET), eq(marketUniverse.ticker, target.ticker)))

      classified += 1
    } catch (error) {
      failed += 1
      errors.push(`${target.ticker}: ${error instanceof Error ? error.message : String(error)}`)
    }

    if ((i + 1) % 50 === 0 || i + 1 === targets.length) {
      console.log(`[${i + 1}/${targets.length}] matched=${matched}, classified=${classified}, unknown=${unknown}, failed=${failed}`)
    }
  }

  const summary = await execGet<{
    total: number
    classified: number
    sectors: number
    industries: number
  }>(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN c.ticker IS NOT NULL THEN 1 ELSE 0 END) AS classified,
      COUNT(DISTINCT c.sector_name) AS sectors,
      COUNT(DISTINCT c.industry_name) AS industries
    FROM market_universe u
    LEFT JOIN market_classifications c
      ON c.market = u.market
     AND c.ticker = u.ticker
     AND c.taxonomy = ?
     AND c.effective_from = '0000-01-01'
    WHERE u.market = ?
    `,
    [US_SEC_SIC_TAXONOMY, MARKET],
  )
  console.log(`US SEC classification complete: matched=${matched}, classified=${classified}, unknown=${unknown}, failed=${failed}`)
  console.log(JSON.stringify({ summary, errors: errors.slice(0, 10) }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
