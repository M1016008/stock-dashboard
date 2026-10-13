import { ensureReady, execAll } from '@/lib/db/client'
import { upsertNormalizedFinancialDataset } from '@/lib/server/financial-foundation-store'
import {
  normalizeSecCompanyFacts,
  secCompanyfactsConceptCoverage,
  type SecCompanyFacts,
} from '@/lib/us-sec-companyfacts'

const SEC_COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts/'
const RATE_LIMIT_MS = Math.max(100, Number(process.env.SEC_RATE_LIMIT_MS ?? 150))
const LIMIT = Math.max(0, Number(process.env.US_COMPANYFACTS_LIMIT ?? 0))
const TICKERS = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean) ?? []

type Target = { ticker: string; cik: string }

function requiredUserAgent(): string {
  const userAgent = process.env.SEC_USER_AGENT?.trim()
  if (!userAgent || !userAgent.includes('@')) {
    throw new Error('SEC_USER_AGENT with an operator contact email is required in machine-local environment')
  }
  return userAgent
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchCompanyFacts(cik: string, userAgent: string): Promise<SecCompanyFacts> {
  const response = await fetch(`${SEC_COMPANYFACTS_BASE}CIK${cik.padStart(10, '0')}.json`, {
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
      'user-agent': userAgent,
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`SEC Companyfacts HTTP ${response.status}`)
  return await response.json() as SecCompanyFacts
}

async function targets(): Promise<Target[]> {
  const tickerSql = TICKERS.length ? `AND c.ticker IN (${TICKERS.map(() => '?').join(',')})` : ''
  const limitSql = LIMIT > 0 ? 'LIMIT ?' : ''
  return await execAll<Target>(`
    SELECT c.ticker, json_extract(c.raw_json, '$.secMatch.cik') AS cik
    FROM market_classifications c
    INNER JOIN market_universe u ON u.market = c.market AND u.ticker = c.ticker
    WHERE c.market = 'US'
      AND c.taxonomy = 'US_SEC_SIC'
      AND c.effective_from = '0000-01-01'
      AND u.active = 1
      AND json_extract(c.raw_json, '$.secMatch.cik') IS NOT NULL
      ${tickerSql}
    ORDER BY c.ticker
    ${limitSql}
  `, [...TICKERS, ...(LIMIT > 0 ? [LIMIT] : [])])
}

async function main() {
  const userAgent = requiredUserAgent()
  await ensureReady()
  const queue = await targets()
  let succeeded = 0
  let failed = 0
  let disclosures = 0
  let facts = 0
  let derivedFacts = 0
  const errors: string[] = []
  const coverage = new Map<string, number>()

  console.log(`US SEC Companyfacts start: targets=${queue.length}`)
  for (let index = 0; index < queue.length; index += 1) {
    const target = queue[index]
    try {
      const payload = await fetchCompanyFacts(target.cik, userAgent)
      const normalized = normalizeSecCompanyFacts(target.ticker, payload)
      const result = await upsertNormalizedFinancialDataset(normalized, undefined, { includeDerivedFacts: true })
      for (const item of secCompanyfactsConceptCoverage(payload)) {
        if (item.observations > 0) coverage.set(item.metric, (coverage.get(item.metric) ?? 0) + 1)
      }
      succeeded += 1
      disclosures += result.disclosures
      facts += result.facts
      derivedFacts += result.derivedFacts
    } catch (error) {
      failed += 1
      errors.push(`${target.ticker}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (index + 1 < queue.length) await sleep(RATE_LIMIT_MS)
    if ((index + 1) % 25 === 0 || index + 1 === queue.length) {
      console.log(`[${index + 1}/${queue.length}] succeeded=${succeeded}, failed=${failed}`)
    }
  }

  console.log(JSON.stringify({
    targets: queue.length,
    succeeded,
    failed,
    disclosures,
    facts,
    derivedFacts,
    coverage: Object.fromEntries([...coverage.entries()].sort(([a], [b]) => a.localeCompare(b))),
    errors: errors.slice(0, 20),
  }, null, 2))
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
