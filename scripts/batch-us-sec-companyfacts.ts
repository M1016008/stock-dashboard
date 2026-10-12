import { deriveFinancialFacts } from '@/lib/financial-foundation'
import { calculateFinancialMetrics } from '@/lib/financial-metrics'
import { execAll, execGet } from '@/lib/db/client'
import { upsertNormalizedFinancialDataset } from '@/lib/server/financial-foundation-store'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import {
  deriveSecInstantFinancialFacts,
  normalizeSecCompanyfacts,
  secTickerAliases,
  type SecCompanyFactsPayload,
  type SecSubmissionsPayload,
} from '@/lib/us-sec-companyfacts'

const MARKET = 'US'
const COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json'
const COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts/'
const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions/'
const RATE_LIMIT_MS = Math.max(110, Number(process.env.SEC_RATE_LIMIT_MS ?? 150))
const LIMIT = Math.max(0, Number(process.env.US_SEC_FINANCIAL_LIMIT ?? 0))
const WRITE = process.env.US_SEC_FINANCIAL_WRITE === '1'
const FULL = process.env.US_SEC_FINANCIAL_FULL === '1'
const TICKERS = process.env.TICKERS
  ?.split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean)

type SecTickerPayload = {
  fields: string[]
  data: Array<Array<string | number | null>>
}

type Target = {
  ticker: string
  name: string | null
  exchange: string | null
  secCik: string | null
  secName: string | null
  secExchange: string | null
}

type SecIdentity = {
  cik: string
  name: string
  exchange: string
}

type RunSummary = {
  requested: number
  matched: number
  normalized: number
  disclosures: number
  sourceFacts: number
  derivedFacts: number
  calculatedMetrics: number
  written: number
  failed: number
  writeMode: boolean
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function secUserAgent(): string {
  const value = process.env.SEC_USER_AGENT?.trim()
  if (!value) {
    throw new Error('SEC_USER_AGENT is required. Configure a machine-local identifying user agent before SEC requests.')
  }
  return value
}

async function fetchJson<T>(url: string): Promise<T> {
  const userAgent = secUserAgent()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': userAgent,
      },
      signal: AbortSignal.timeout(60_000),
    }).catch((error) => {
      if (attempt >= 2) throw error
      return null
    })
    if (!response) {
      await sleep(500 * (attempt + 1))
      continue
    }
    if (response.ok) return await response.json() as T
    const retriable = response.status === 429 || response.status >= 500
    const message = await response.text().catch(() => '')
    if (!retriable || attempt >= 2) {
      throw new Error(`SEC request failed: HTTP ${response.status}${message ? ` ${message.slice(0, 120)}` : ''}`)
    }
    await sleep(1_000 * (attempt + 1))
  }
  throw new Error('SEC request failed after bounded retries')
}

async function loadTargets(): Promise<Target[]> {
  if (!TICKERS?.length && LIMIT === 0 && !FULL) {
    throw new Error('Bounded run required: set TICKERS, US_SEC_FINANCIAL_LIMIT, or explicit US_SEC_FINANCIAL_FULL=1.')
  }
  const tickerFilter = TICKERS?.length
    ? `AND u.ticker IN (${TICKERS.map(() => '?').join(',')})`
    : ''
  const limitSql = LIMIT > 0 ? 'LIMIT ?' : ''
  return execAll<Target>(`
    SELECT
      u.ticker,
      u.name,
      u.exchange,
      json_extract(c.raw_json, '$.secMatch.cik') AS secCik,
      json_extract(c.raw_json, '$.secMatch.name') AS secName,
      json_extract(c.raw_json, '$.secMatch.exchange') AS secExchange
    FROM market_universe u
    LEFT JOIN market_classifications c
      ON c.market = u.market
     AND c.ticker = u.ticker
     AND c.taxonomy = '${US_SEC_SIC_TAXONOMY}'
     AND c.effective_from = '0000-01-01'
    WHERE u.market = ?
      AND u.active = 1
      AND u.asset_type = 'Stock'
      ${tickerFilter}
    ORDER BY u.ticker
    ${limitSql}
  `, [MARKET, ...(TICKERS ?? []), ...(LIMIT > 0 ? [LIMIT] : [])])
}

async function loadSecIdentities(): Promise<Map<string, SecIdentity[]>> {
  const payload = await fetchJson<SecTickerPayload>(COMPANY_TICKERS_URL)
  const cikIndex = payload.fields.indexOf('cik')
  const nameIndex = payload.fields.indexOf('name')
  const tickerIndex = payload.fields.indexOf('ticker')
  const exchangeIndex = payload.fields.indexOf('exchange')
  const output = new Map<string, SecIdentity[]>()
  for (const row of payload.data) {
    const ticker = String(row[tickerIndex] ?? '').trim().toUpperCase()
    const cik = String(row[cikIndex] ?? '').replace(/^0+/, '').padStart(10, '0')
    if (!ticker || !cik) continue
    const identity = {
      cik,
      name: String(row[nameIndex] ?? ''),
      exchange: String(row[exchangeIndex] ?? ''),
    }
    for (const alias of secTickerAliases(ticker)) {
      const candidates = output.get(alias) ?? []
      if (!candidates.some((candidate) => candidate.cik === identity.cik)) candidates.push(identity)
      output.set(alias, candidates)
    }
  }
  return output
}

function comparableName(value: string | null): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function resolveNetworkIdentity(target: Target, identities: Map<string, SecIdentity[]>): SecIdentity | undefined {
  const candidates = secTickerAliases(target.ticker)
    .flatMap((alias) => identities.get(alias) ?? [])
    .filter((candidate, index, all) => all.findIndex((item) => item.cik === candidate.cik) === index)
  if (candidates.length <= 1) return candidates[0]
  const exchangeMatches = candidates.filter((candidate) => (
    candidate.exchange.toUpperCase() === String(target.exchange ?? '').toUpperCase()
  ))
  if (exchangeMatches.length === 1) return exchangeMatches[0]
  const expectedName = comparableName(target.name)
  const nameMatches = (exchangeMatches.length > 0 ? exchangeMatches : candidates).filter((candidate) => {
    const candidateName = comparableName(candidate.name)
    return expectedName.length >= 4 && (candidateName.includes(expectedName) || expectedName.includes(candidateName))
  })
  return nameMatches.length === 1 ? nameMatches[0] : undefined
}

async function main() {
  const targets = await loadTargets()
  const identities = targets.some((target) => !target.secCik)
    ? await loadSecIdentities()
    : new Map<string, SecIdentity[]>()
  const summary: RunSummary = {
    requested: targets.length,
    matched: 0,
    normalized: 0,
    disclosures: 0,
    sourceFacts: 0,
    derivedFacts: 0,
    calculatedMetrics: 0,
    written: 0,
    failed: 0,
    writeMode: WRITE,
  }
  const failures: string[] = []

  for (const [index, target] of targets.entries()) {
    const classifiedIdentity = target.secCik
      ? {
        cik: String(target.secCik).replace(/^0+/, '').padStart(10, '0'),
        name: target.secName ?? target.name ?? '',
        exchange: target.secExchange ?? '',
      }
      : null
    const identity = classifiedIdentity ?? resolveNetworkIdentity(target, identities)
    if (!identity) continue
    summary.matched += 1
    try {
      await sleep(RATE_LIMIT_MS)
      const [companyfacts, submissions] = await Promise.all([
        fetchJson<SecCompanyFactsPayload>(`${COMPANYFACTS_BASE}CIK${identity.cik}.json`),
        fetchJson<SecSubmissionsPayload>(`${SUBMISSIONS_BASE}CIK${identity.cik}.json`),
      ])
      const normalized = normalizeSecCompanyfacts(target.ticker, companyfacts, submissions)
      const derived = [
        ...deriveFinancialFacts(normalized.facts),
        ...deriveSecInstantFinancialFacts(normalized.facts),
      ]
      summary.normalized += 1
      summary.disclosures += normalized.disclosures.length
      summary.sourceFacts += normalized.facts.length
      summary.derivedFacts += derived.length
      const price = await execGet<{ date: string; close: number }>(`
        SELECT date, close
        FROM market_ohlcv_daily
        WHERE market = 'US' AND ticker = ?
        ORDER BY date DESC
        LIMIT 1
      `, [target.ticker])
      const classification = await execGet<{ sector_name: string | null }>(`
        SELECT sector_name
        FROM market_classifications
        WHERE market = 'US' AND ticker = ?
        ORDER BY effective_from DESC
        LIMIT 1
      `, [target.ticker])
      const calculated = price
        ? calculateFinancialMetrics({
          ticker: target.ticker,
          asOf: price.date,
          facts: [...normalized.facts, ...derived],
          forecasts: [],
          price: {
            value: Number(price.close),
            date: price.date,
            inputId: `price:US:${target.ticker}:${price.date}`,
          },
          isFinancialSector: /bank|finance|financial|insurance/i.test(classification?.sector_name ?? ''),
        })
        : []
      summary.calculatedMetrics += calculated.length
      if (WRITE) {
        await upsertNormalizedFinancialDataset({
          disclosures: normalized.disclosures,
          facts: [...normalized.facts, ...derived],
          forecasts: [],
        }, Math.floor(Date.now() / 1_000), { deferDerivedAndMetrics: true })
        summary.written += normalized.facts.length + derived.length
      }
      console.log(JSON.stringify({
        ticker: target.ticker,
        cik: identity.cik,
        disclosures: normalized.disclosures.length,
        sourceFacts: normalized.facts.length,
        derivedFacts: derived.length,
        calculatedMetrics: calculated.map((metric) => metric.metric),
        ignored: normalized.ignored,
        write: WRITE ? 'APPLIED' : 'DRY_RUN',
      }))
    } catch (error) {
      summary.failed += 1
      failures.push(`${target.ticker}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if ((index + 1) % 25 === 0) {
      console.log(JSON.stringify({ progress: index + 1, total: targets.length, failed: summary.failed }))
    }
  }

  console.log(JSON.stringify({ summary, failures: failures.slice(0, 20) }, null, 2))
  if (summary.failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
