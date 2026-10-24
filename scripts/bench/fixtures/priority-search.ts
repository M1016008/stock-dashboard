import { createRequire } from 'node:module'

/** Shared, deterministic fixture for the priority search-route matrix. */
export const version = 4

type Statement = { run(...values: Array<string | number | null>): unknown }
type Row = Record<string, unknown>
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): Statement & { all(...values: unknown[]): Row[] }
  close(): void
}

const columnCache = new WeakMap<object, Map<string, Set<string>>>()
const insertCache = new WeakMap<object, Map<string, Statement>>()

function isoDay(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 5))
  let remaining = index
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1)
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining -= 1
  }
  return date.toISOString().slice(0, 10)
}

function twoYearPatternRows(index: number): Array<{
  date: string
  open: number
  high: number
  low: number
  close: number
}> {
  const anchors = index % 2 === 0
    ? [
        ['2018-01-03', 110, 110], ['2019-12-30', 110, 90],
        ['2020-01-03', 90, 90], ['2021-12-30', 90, 105],
        ['2022-01-03', 105, 105], ['2023-12-29', 105, 120],
        ['2024-01-04', 120, 120], ['2025-12-30', 120, 140],
      ]
    : [
        ['2018-01-03', 80, 80], ['2019-12-30', 80, 100],
        ['2020-01-03', 120, 120], ['2021-12-30', 120, 95],
        ['2022-01-03', 95, 95], ['2023-12-29', 95, 110],
        ['2024-01-04', 110, 110], ['2025-12-30', 110, 130],
      ]
  const scale = 1 + index * 0.0001
  return anchors.map(([date, open, close]) => {
    const scaledOpen = Number(open) * scale
    const scaledClose = Number(close) * scale
    return {
      date: String(date),
      open: scaledOpen,
      high: Math.max(scaledOpen, scaledClose) * 1.01,
      low: Math.min(scaledOpen, scaledClose) * 0.99,
      close: scaledClose,
    }
  })
}

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  let databaseCache = columnCache.get(db as object)
  if (!databaseCache) {
    databaseCache = new Map()
    columnCache.set(db as object, databaseCache)
  }
  const cached = databaseCache.get(table)
  if (cached) return cached
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)))
  databaseCache.set(table, columns)
  return columns
}

function insertFromRecord(db: SqliteDatabase, table: string, values: Record<string, string | number | null>): void {
  const available = tableColumns(db, table)
  const entries = Object.entries(values).filter(([key]) => available.has(key))
  if (entries.length === 0) throw new Error(`fixture table ${table} has no compatible columns`)
  let databaseCache = insertCache.get(db as object)
  if (!databaseCache) {
    databaseCache = new Map()
    insertCache.set(db as object, databaseCache)
  }
  const cacheKey = `${table}:${entries.map(([key]) => key).join(',')}`
  let statement = databaseCache.get(cacheKey)
  if (!statement) {
    statement = db.prepare(
      `INSERT OR REPLACE INTO ${table} (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`,
    )
    databaseCache.set(cacheKey, statement)
  }
  statement.run(...entries.map(([, value]) => value))
}

export async function build(options: {
  dbPath: string
  params: Record<string, number | string | boolean>
  log(message: string): void
}): Promise<void> {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteDatabase
  }
  const tickers = Math.max(20, Math.floor(Number(options.params.tickers ?? 600)))
  const sessions = Math.max(30, Math.floor(Number(options.params.sessions ?? 90)))
  const usTickers = Math.max(20, Math.floor(Number(options.params.usTickers ?? tickers)))
  const db = new DatabaseSync(options.dbPath)
  const dates = Array.from({ length: sessions }, (_, index) => isoDay(index))
  const latest = dates.at(-1)!
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; BEGIN')
    for (let index = 0; index < tickers; index += 1) {
      const ticker = String(1000 + index)
      insertFromRecord(db, 'ticker_universe', {
        ticker, name: `Synthetic JP ${ticker}`, active: 1,
        sector17_name: `Sector ${index % 5}`, sector33_name: `Industry ${index % 11}`,
        market_segment: index % 3 === 0 ? 'プライム' : index % 3 === 1 ? 'スタンダード' : 'グロース',
        margin_type: index % 2 === 0 ? '貸借' : '信用', shares_outstanding: 1_000_000 + index * 100,
      })
      insertFromRecord(db, 'historical_universe', {
        ticker, name: `Synthetic JP ${ticker}`, first_trade_date: dates[0], last_trade_date: latest,
        latest_ohlcv_date: latest, trading_days: sessions, is_latest_member: 1,
        status: 'listed', market_segment: 'プライム', sector17_name: `Sector ${index % 5}`,
        sector33_name: `Industry ${index % 11}`, margin_type: '貸借',
      })
      insertFromRecord(db, 'stock_classification', {
        ticker, major_category: `Major ${index % 7}`, sub_industry: `Sub ${index % 23}`, updated_at: 100 + index,
      })
      for (const row of twoYearPatternRows(index)) {
        insertFromRecord(db, 'ohlcv_daily', {
          ticker, ...row, volume: 100_000 + index * 50,
        })
      }
      for (let day = 0; day < dates.length; day += 1) {
        const close = 80 + index * 0.07 + day * (0.08 + (index % 7) * 0.002) + Math.sin((day + index) / 9)
        insertFromRecord(db, 'ohlcv_daily', {
          ticker, date: dates[day], open: close * 0.998, high: close * 1.012,
          low: close * 0.988, close, volume: 100_000 + index * 50 + day * 10,
        })
      }
      for (const [offset, code] of [[2, '111111'], [1, '211111'], [0, index % 2 === 0 ? '111111' : '311111']] as const) {
        const date = dates[dates.length - 1 - offset]
        insertFromRecord(db, 'daily_snapshots', {
          ticker, date, daily_a_stage: Number(code[0]), daily_b_stage: Number(code[1]),
          weekly_a_stage: Number(code[2]), weekly_b_stage: Number(code[3]),
          monthly_a_stage: Number(code[4]), monthly_b_stage: Number(code[5]),
          ma_5: 110 + index * 0.01, ma_25: 108 + index * 0.01, ma_75: 104 + index * 0.01,
          ma_200: 95 + index * 0.01, ma_200_prev: 94.9 + index * 0.01,
          ma_200_observations: 200, prev_close: 100, close_5d: 98, close_20d: 95,
          close_60d: 90, close_120d: 85, avg_volume_20: 100_000 + index * 50,
        })
      }
      insertFromRecord(db, 'physical_momentum_metrics', {
        market: 'JP', symbol: ticker, date: latest, acceleration: (index % 9) - 4,
        force: (index % 7) - 3, physical_momentum_score: (index % 21) - 10,
        physical_force_score: (index % 17) - 8, physical_energy_score: index % 13,
      })
      for (let day = 0; day < dates.length; day += 5) {
        insertFromRecord(db, 'physical_momentum_metrics', {
          market: 'JP', symbol: ticker, date: dates[day], acceleration: (index % 9) - 4,
          force: (index % 7) - 3, physical_momentum_score: (index % 21) - 10,
          physical_force_score: (index % 17) - 8, physical_energy_score: index % 13,
          updated_at: 1_000 + day,
        })
        insertFromRecord(db, 'weekly_margin_interest', {
          ticker, date: dates[day], long_margin: 1_000 + index + day,
          short_margin: 500 + index + day, long_change: day % 9, short_change: day % 7,
          imported_at: 2_000 + day,
        })
      }
      for (let period = 0; period < 8; period += 1) {
        const periodEnd = dates[Math.max(0, dates.length - 1 - period * 20)]
        insertFromRecord(db, 'calculated_financial_metrics', {
          value_id: `${ticker}:metric:${period}`, ticker, as_of: periodEnd,
          period_start: dates[Math.max(0, dates.length - 20 - period * 20)], period_end: periodEnd,
          metric: 'operating_margin', value: 5 + (index % 20) + period / 10, unit: 'percent',
          consolidation_scope: 'consolidated', accounting_standard: 'JGAAP',
          definition_version: 'fixture-v1', derivation_method: 'fixture', input_fact_ids_json: '[]',
          computed_at: 3_000 + period,
        })
        for (const metric of ['revenue', 'operating_profit', 'net_income', 'eps_basic', 'dps', 'equity']) {
          insertFromRecord(db, 'normalized_financial_facts', {
            fact_id: `${ticker}:fact:${period}:${metric}`, event_id: `${ticker}:event:${period}`,
            ticker, published_at: `${periodEnd}T06:00:00+09:00`, period_end: periodEnd,
            target_fiscal_year: 2026 - period, period_kind: 'FY', accumulation_kind: 'annual',
            value_kind: 'actual', metric, value: 10_000 + index * 10 + period,
            unit: metric === 'eps_basic' || metric === 'dps' ? 'JPY/share' : 'JPY',
            consolidation_scope: 'consolidated', accounting_standard: 'JGAAP', correction_status: 'original',
            source: 'fixture', disclosure_id: `${ticker}:disclosure:${period}`, imported_at: 4_000 + period,
          })
        }
        for (const metric of ['revenue', 'operating_profit', 'eps_basic']) {
          insertFromRecord(db, 'financial_forecast_snapshots', {
            snapshot_id: `${ticker}:forecast:${period}:${metric}`, event_id: `${ticker}:forecast-event:${period}`,
            ticker, published_at: `${periodEnd}T06:00:00+09:00`, target_fiscal_year: 2027 - period,
            target_period_end: periodEnd, forecast_scope: 'full_year', forecast_period: 'FY', metric,
            value: 11_000 + index * 10 + period, unit: metric === 'eps_basic' ? 'JPY/share' : 'JPY',
            consolidation_scope: 'consolidated', accounting_standard: 'JGAAP', source: 'fixture',
            source_field: metric, disclosure_id: `${ticker}:forecast-disclosure:${period}`, imported_at: 5_000 + period,
          })
        }
      }
      insertFromRecord(db, 'valuation_daily_serving', {
        ticker, valuation_date: latest, price_date: latest, price: 100 + index * 0.1,
        basis_id: 'synthetic-v1', per: 8 + (index % 25), forward_per: 7 + (index % 20),
        pbr: 0.6 + (index % 12) / 10, psr: 0.5 + (index % 8) / 10,
        fcf_yield: 2 + (index % 8), ev_ebitda: 3 + (index % 12), net_debt: index * 1000,
        dividend_yield: 1 + (index % 5), roe: 5 + (index % 20), revenue_growth: (index % 30) - 5,
        enterprise_value: 2_000_000 + index * 1000, ebitda: 100_000 + index * 100,
      })
    }

    for (let day = 0; day < dates.length; day += 1) {
      for (let sector = 0; sector < 11; sector += 1) {
        insertFromRecord(db, 'sector_structure_daily', {
          taxonomy: '33', group_key: `Industry ${sector}`, group_name: `Industry ${sector}`,
          date: dates[day], n_stocks: Math.ceil(tickers / 11), valid_stage_count: Math.ceil(tickers / 11),
          strength_score: sector - 5, transition_change_score: (sector % 5) - 2,
          propagation_direction: 'neutral', propagation_phase: 0, propagation_label: 'neutral',
          improving_count: sector, deteriorating_count: 10 - sector, stable_count: tickers,
          axis_json: '{}', composition_json: '{}', computed_at: 6_000 + day,
        })
      }
    }

    for (let index = 0; index < usTickers; index += 1) {
      const ticker = `S${String(index + 1).padStart(5, '0')}`
      insertFromRecord(db, 'market_universe', {
        market: 'US', ticker, name: `Synthetic US ${ticker}`, active: 1, exchange: index % 2 ? 'NYSE' : 'NASDAQ',
        currency: 'USD', asset_type: 'Stock', sector: `Sector ${index % 6}`, industry: `Industry ${index % 13}`,
        start_date: dates[0], shares_outstanding: 1_000_000 + index * 100, source: 'fixture',
      })
      for (const row of twoYearPatternRows(index)) {
        insertFromRecord(db, 'market_ohlcv_daily', {
          market: 'US', ticker, ...row, volume: 200_000 + index * 100,
          adj_open: row.open, adj_high: row.high, adj_low: row.low,
          adj_close: row.close, adj_volume: 200_000 + index * 100, source: 'fixture',
        })
      }
      for (let day = 0; day < dates.length; day += 1) {
        const close = 50 + index * 0.04 + day * 0.06 + Math.sin((day + index) / 11)
        insertFromRecord(db, 'market_ohlcv_daily', {
          market: 'US', ticker, date: dates[day], open: close * 0.998, high: close * 1.012,
          low: close * 0.988, close, volume: 200_000 + index * 100,
          adj_open: close * 0.998, adj_high: close * 1.012, adj_low: close * 0.988,
          adj_close: close, adj_volume: 200_000 + index * 100, source: 'fixture',
        })
      }
      for (const [offset, code] of [[2, '111111'], [1, '211111'], [0, index % 2 === 0 ? '111111' : '311111']] as const) {
        insertFromRecord(db, 'market_daily_snapshots', {
          market: 'US', ticker, date: dates[dates.length - 1 - offset],
          daily_a_stage: Number(code[0]), daily_b_stage: Number(code[1]),
          weekly_a_stage: Number(code[2]), weekly_b_stage: Number(code[3]),
          monthly_a_stage: Number(code[4]), monthly_b_stage: Number(code[5]),
          prev_close: 50, close_5d: 49, close_20d: 47, close_60d: 44, close_120d: 40,
          avg_volume_20: 200_000, ma_200: 42, ma_200_prev: 41.9, ma_200_observations: 200,
        })
      }
      insertFromRecord(db, 'physical_momentum_metrics', {
        market: 'US', symbol: ticker, date: latest, acceleration: (index % 9) - 4,
        force: (index % 7) - 3, physical_momentum_score: (index % 21) - 10,
        physical_force_score: (index % 17) - 8, physical_energy_score: index % 13,
      })
    }

    // Complete benchmark calendars keep native 2D/3D buckets aligned, while
    // sparse pre-2026 anchors provide the completed 24-month blocks.
    const benchmarkRows = [
      ...twoYearPatternRows(0),
      ...dates.map((date, index) => ({
        date,
        open: 140 + index * 0.02,
        high: 141 + index * 0.02,
        low: 139 + index * 0.02,
        close: 140.5 + index * 0.02,
      })),
      { date: '2027-12-30', open: 151, high: 152, low: 150, close: 151.5 },
    ]
    for (const row of benchmarkRows) {
      insertFromRecord(db, 'ohlcv_daily', { ticker: '1306', ...row, volume: 1_000_000 })
      insertFromRecord(db, 'market_ohlcv_daily', {
        market: 'US', ticker: 'SPY', ...row, volume: 1_000_000,
        adj_open: row.open, adj_high: row.high, adj_low: row.low,
        adj_close: row.close, adj_volume: 1_000_000, source: 'fixture',
      })
    }
    insertFromRecord(db, 'ticker_universe', { ticker: '1306', name: 'Synthetic Benchmark', active: 1 })
    insertFromRecord(db, 'market_universe', {
      market: 'US', ticker: 'SPY', name: 'Synthetic Benchmark', active: 1, exchange: 'NYSE', currency: 'USD',
      asset_type: 'ETF', start_date: '2018-01-03', shares_outstanding: 1_000_000, source: 'fixture',
    })
    insertFromRecord(db, 'batch_runs', { job_type: 'ohlcv_fetch:jquants', started_at: 1, finished_at: 2, status: 'success' })
    insertFromRecord(db, 'market_data_runs', { market: 'US', job_type: 'tiingo_ohlcv', status: 'success', started_at: 1, finished_at: 2 })
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
    throw error
  } finally {
    db.close()
  }
  options.log(`priority fixture: JP=${tickers}, US=${usTickers}, sessions=${sessions}, latest=${latest}`)
}
