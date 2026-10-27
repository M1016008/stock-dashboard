import { execGet } from '@/lib/db/client'
import { isPlaceholderOpenAIKey } from '@/lib/assistant/config'
import { hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { loadUsDailyCoverageSla } from '@/lib/server/us-source-availability-store'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { summarizeUsDailyCoverageSla, type UsDailyCoverageSla } from '@/lib/us-source-availability'
import { usInvestableSymbolSql, usTestSymbolExclusionSql } from '@/lib/us-symbol-quality'

type UsUniverseSummary = {
  total: number
  active: number
  productionActive: number
  stocks: number
  etfs: number
  mutualFunds: number
  testSymbols: number
  excludedArtifacts: number
}

type UsDateRange = {
  firstDate: string | null
  latestDate: string | null
}

type UsSnapshotDate = {
  latestDate: string | null
}

type UsSnapshotCount = {
  tickers: number
}

type UsCoverageCount = {
  eligible: number
  covered: number
}

export type UsCoverageState = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'

export type UsCoverageSummary = {
  date: string | null
  eligible: number
  covered: number
  percent: number | null
  status: UsCoverageState
}

export type UsLatestRun = {
  job_type: string
  status: string
  started_at: number
  finished_at: number | null
  total_tickers: number
  succeeded: number
  failed: number
  rows_inserted: number
}

export type UsStatusSummary = {
  market: 'US'
  universe: {
    total: number
    active: number
    productionActive: number
    stocks: number
    etfs: number
    mutualFunds: number
    testSymbols: number
    excludedArtifacts: number
  }
  ohlcv: {
    firstDate: string | null
    latestDate: string | null
    tickers: number
    rows: number | null
    rowsApproximate: boolean
  }
  snapshots: {
    latestDate: string | null
    tickers: number
  }
  coverage: {
    /** Raw latest-date coverage (covered / active investable universe). */
    ohlcv: UsCoverageSummary
    snapshots: UsCoverageSummary
    /** Raw vs effective (confirmed permanent exclusions removed) coverage with missing buckets. */
    ohlcvSla?: UsDailyCoverageSla
  }
  contracts: {
    priceBasis: typeof US_ADJUSTED_PRICE_BASIS
    priceFrequency: 'EOD'
    classification: {
      taxonomy: 'SEC_SIC'
      effectiveDating: 'CURRENT_ONLY'
      historicalPitAvailable: false
    }
    fundamentals: {
      source: 'SEC_COMPANYFACTS'
      basis: 'ACTUAL_ONLY'
      companyForecastsAvailable: false
    }
  }
  capabilities: UsRuntimeCapabilities
  latestRun: UsLatestRun | null
}

export type UsRuntimeCapabilities = {
  analytics: { configured: boolean; available: boolean }
  historicalAnalog: { mode: 'PROXY' | 'LOCAL' | 'UNAVAILABLE' }
  earningsCalendar: { source: 'FINNHUB'; configured: boolean }
  scenarioNarratives: { enabled: boolean; configured: boolean }
  dailyMl: { enabled: boolean }
  publicationOverrides: { allowStale: boolean; allowPartial: boolean }
}

export function summarizeUsRuntimeCapabilities(
  environment: NodeJS.ProcessEnv,
  analyticsAvailable: boolean,
): UsRuntimeCapabilities {
  const openAiKey = environment.OPENAI_API_KEY?.trim() ?? ''
  const scenarioEnabled = environment.SCENARIO_PROJECTION_LLM_ENABLED !== '0'
    && environment.OPENAI_ASSISTANT_ENABLED !== '0'
  const proxyConfigured = Boolean(environment.ANALOG_SEARCH_PROXY_URL?.trim())
  const localWorker = environment.ANALOG_SEARCH_WORKER === '1'
  return {
    analytics: {
      configured: Boolean(environment.US_ANALYTICS_DB_PATH?.trim()),
      available: analyticsAvailable,
    },
    historicalAnalog: {
      mode: proxyConfigured ? 'PROXY' : localWorker || analyticsAvailable ? 'LOCAL' : 'UNAVAILABLE',
    },
    earningsCalendar: {
      source: 'FINNHUB',
      configured: Boolean(environment.FINNHUB_API_KEY?.trim()),
    },
    scenarioNarratives: {
      enabled: scenarioEnabled,
      configured: scenarioEnabled && Boolean(openAiKey) && !isPlaceholderOpenAIKey(openAiKey),
    },
    dailyMl: { enabled: environment.US_SKIP_DAILY_ML !== '1' },
    publicationOverrides: {
      allowStale: environment.US_ALLOW_STALE_DAILY_UPDATE === '1',
      allowPartial: environment.US_ALLOW_PARTIAL_DAILY_PUBLICATION === '1',
    },
  }
}

export function summarizeUsCoverage(
  date: string | null,
  eligibleValue: number | null | undefined,
  coveredValue: number | null | undefined,
): UsCoverageSummary {
  const eligible = Math.max(0, Number(eligibleValue ?? 0))
  const covered = Math.max(0, Math.min(eligible, Number(coveredValue ?? 0)))
  if (!date || eligible === 0) {
    return { date, eligible, covered, percent: null, status: 'UNAVAILABLE' }
  }
  return {
    date,
    eligible,
    covered,
    percent: 100 * covered / eligible,
    status: covered >= eligible ? 'COMPLETE' : 'PARTIAL',
  }
}

export async function getUsStatusSummary(): Promise<UsStatusSummary> {
  const [universe, firstDate, latestDate, snapshotLatestDate, latestRun, ohlcvRows] = await Promise.all([
    execGet<UsUniverseSummary>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} THEN 1 ELSE 0 END) AS productionActive,
         SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} AND asset_type = 'Stock' THEN 1 ELSE 0 END) AS stocks,
         SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} AND asset_type = 'ETF' THEN 1 ELSE 0 END) AS etfs,
         SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} AND asset_type = 'Mutual Fund' THEN 1 ELSE 0 END) AS mutualFunds,
         SUM(CASE WHEN active = 1 AND NOT (${usTestSymbolExclusionSql('ticker')}) THEN 1 ELSE 0 END) AS testSymbols,
         SUM(CASE WHEN active = 1 AND ${usTestSymbolExclusionSql('ticker')} AND NOT (${usInvestableSymbolSql('ticker')}) THEN 1 ELSE 0 END) AS excludedArtifacts
       FROM market_universe
       WHERE market = 'US'`,
    ),
    execGet<{ date: string | null }>(
      `SELECT date FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx WHERE market = 'US' ORDER BY date ASC LIMIT 1`,
    ),
    execGet<{ date: string | null }>(
      `SELECT date FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx WHERE market = 'US' ORDER BY date DESC LIMIT 1`,
    ),
    execGet<UsSnapshotDate>(
      `SELECT date AS latestDate
       FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx
       WHERE market = 'US'
       ORDER BY date DESC
       LIMIT 1`,
    ),
    execGet<UsLatestRun>(
      `SELECT job_type, status, started_at, finished_at, total_tickers, succeeded, failed, rows_inserted
       FROM market_data_runs
       WHERE market = 'US'
         AND job_type = 'tiingo_ohlcv'
       ORDER BY started_at DESC
       LIMIT 1`,
    ),
    execGet<{ rows: number | null }>(
      `SELECT SUM(rows_inserted) AS rows FROM market_data_runs WHERE market = 'US' AND job_type = 'tiingo_ohlcv'`,
    ),
  ])

  const snapshotLatest = snapshotLatestDate?.latestDate ?? null
  const [snapshotCount, ohlcvCoverage, snapshotCoverage, ohlcvSla] = await Promise.all([
    snapshotLatest
      ? execGet<UsSnapshotCount>(
        `SELECT COUNT(*) AS tickers
         FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx
         WHERE market = 'US'
           AND date = ?`,
        [snapshotLatest],
      )
      : Promise.resolve(null),
    latestDate?.date
      ? execGet<UsCoverageCount>(
        `SELECT
           COUNT(*) AS eligible,
           SUM(CASE WHEN o.ticker IS NOT NULL THEN 1 ELSE 0 END) AS covered
         FROM market_universe u INDEXED BY market_universe_market_active_idx
         LEFT JOIN market_ohlcv_daily o INDEXED BY market_ohlcv_market_date_ticker_idx
           ON o.market = 'US' AND o.date = ? AND o.ticker = u.ticker
         WHERE u.market = 'US'
           AND u.active = 1
           AND ${usInvestableSymbolSql('u.ticker')}`,
        [latestDate.date],
      )
      : Promise.resolve(null),
    snapshotLatest
      ? execGet<UsCoverageCount>(
        `SELECT
           COUNT(*) AS eligible,
           SUM(CASE WHEN s.ticker IS NOT NULL THEN 1 ELSE 0 END) AS covered
         FROM market_universe u INDEXED BY market_universe_market_active_idx
         INNER JOIN market_ohlcv_daily current INDEXED BY market_ohlcv_market_date_ticker_idx
           ON current.market = 'US' AND current.date = ? AND current.ticker = u.ticker
         LEFT JOIN market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
           ON s.market = 'US' AND s.date = ? AND s.ticker = u.ticker
         WHERE u.market = 'US'
           AND u.active = 1
           AND ${usInvestableSymbolSql('u.ticker')}
           AND EXISTS (
             SELECT 1
             FROM market_ohlcv_daily history INDEXED BY market_ohlcv_market_ticker_date_idx
             WHERE history.market = 'US' AND history.ticker = u.ticker
             ORDER BY history.date DESC
             LIMIT 1 OFFSET 4
           )`,
        [snapshotLatest, snapshotLatest],
      )
      : Promise.resolve(null),
    latestDate?.date
      ? loadUsDailyCoverageSla(latestDate.date).catch(() => null)
      : Promise.resolve(null),
  ])

  return {
    market: 'US',
    universe: {
      total: Number(universe?.total ?? 0),
      active: Number(universe?.active ?? 0),
      productionActive: Number(universe?.productionActive ?? 0),
      stocks: Number(universe?.stocks ?? 0),
      etfs: Number(universe?.etfs ?? 0),
      mutualFunds: Number(universe?.mutualFunds ?? 0),
      testSymbols: Number(universe?.testSymbols ?? 0),
      excludedArtifacts: Number(universe?.excludedArtifacts ?? 0),
    },
    ohlcv: {
      firstDate: firstDate?.date ?? null,
      latestDate: latestDate?.date ?? null,
      tickers: Number(latestRun?.succeeded ?? 0),
      rows: ohlcvRows?.rows == null ? null : Number(ohlcvRows.rows),
      rowsApproximate: true,
    },
    snapshots: {
      latestDate: snapshotLatest,
      tickers: Number(snapshotCount?.tickers ?? 0),
    },
    coverage: {
      ohlcv: summarizeUsCoverage(latestDate?.date ?? null, ohlcvCoverage?.eligible, ohlcvCoverage?.covered),
      snapshots: summarizeUsCoverage(snapshotLatest, snapshotCoverage?.eligible, snapshotCoverage?.covered),
      // Availability table unreadable: keep raw numbers and report every gap as unclassified.
      ohlcvSla: ohlcvSla ?? summarizeUsDailyCoverageSla(
        latestDate?.date ?? null,
        { rawUniverse: ohlcvCoverage?.eligible, covered: ohlcvCoverage?.covered },
        false,
      ),
    },
    contracts: {
      priceBasis: US_ADJUSTED_PRICE_BASIS,
      priceFrequency: 'EOD',
      classification: {
        taxonomy: 'SEC_SIC',
        effectiveDating: 'CURRENT_ONLY',
        historicalPitAvailable: false,
      },
      fundamentals: {
        source: 'SEC_COMPANYFACTS',
        basis: 'ACTUAL_ONLY',
        companyForecastsAvailable: false,
      },
    },
    capabilities: summarizeUsRuntimeCapabilities(process.env, hasUsAnalyticsDb()),
    latestRun: latestRun ?? null,
  }
}
