// scripts/build-historical-universe.ts
//
// OHLCV に一度でも現れた全銘柄をヒストリカルユニバースとして固定する。
// ticker_universe が現行マスタ寄りでも、廃止済み/過去のみ銘柄を ML 監査対象から落とさないための台帳。

import { execAll, execGet, execRun } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'

type SummaryRow = {
  latest_ohlcv_date: string | null
  ohlcv_ticker_count: number
  latest_member_count: number
  historical_only_count: number
  missing_ticker_universe_count: number
  ml_feature_complete_count: number
  ml_feature_incomplete_count: number
  ohlcv_row_count: number
  ml_feature_row_count: number
}

type SampleRow = {
  ticker: string
  name: string | null
  first_trade_date: string
  last_trade_date: string
  ohlcv_rows: number
  ml_physics_v2_rows: number
}

function asNumber(value: unknown): number {
  return Number(value ?? 0)
}

async function main() {
  const runStartedAt = Math.floor(Date.now() / 1000)
  await execRun(`
    INSERT INTO batch_runs (job_type, started_at, status)
    VALUES ('historical_universe', unixepoch(), 'running')
  `)
  const run = await execGet<{ id: number }>(`SELECT last_insert_rowid() AS id`)
  const runId = Number(run?.id ?? 0)

  try {
    const latest = await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM ohlcv_daily`)
    const latestDate = latest?.date ?? null
    if (!latestDate) throw new Error('ohlcv_daily is empty; historical universe cannot be built')

    console.log(`historical universe: latest_ohlcv_date=${latestDate}`)

    await execRun(`DROP TABLE IF EXISTS temp.hist_ohlcv`)
    await execRun(`DROP TABLE IF EXISTS temp.hist_v2`)
    await execRun(`
      CREATE TEMP TABLE hist_ohlcv AS
      SELECT ticker, MIN(date) AS first_trade_date, MAX(date) AS last_trade_date, COUNT(*) AS ohlcv_rows
      FROM ohlcv_daily
      GROUP BY ticker
    `)
    await execRun(`CREATE INDEX hist_ohlcv_ticker_idx ON hist_ohlcv(ticker)`)
    await execRun(`
      CREATE TEMP TABLE hist_v2 AS
      SELECT ticker, COUNT(*) AS ml_physics_v2_rows
      FROM ml_feature_vectors_v2
      WHERE feature_set = ?
      GROUP BY ticker
    `, [ML_PHYSICS_FEATURE_SET])
    await execRun(`CREATE INDEX hist_v2_ticker_idx ON hist_v2(ticker)`)

    await execRun(`DELETE FROM historical_universe`)
    await execRun(
      `
      INSERT INTO historical_universe (
        ticker,
        name,
        first_trade_date,
        last_trade_date,
        trading_days,
        latest_ohlcv_date,
        is_latest_member,
        status,
        missing_from_ticker_universe,
        market_segment,
        sector17_code,
        sector17_name,
        sector33_code,
        sector33_name,
        margin_type,
        ohlcv_rows,
        ml_physics_v2_rows,
        has_ml_physics_v2,
        source,
        payload_json,
        computed_at
      )
      SELECT
        o.ticker,
        u.name,
        o.first_trade_date,
        o.last_trade_date,
        o.ohlcv_rows,
        ?,
        CASE WHEN o.last_trade_date = ? THEN 1 ELSE 0 END,
        CASE WHEN o.last_trade_date = ? THEN 'current' ELSE 'historical_only' END,
        CASE WHEN u.ticker IS NULL THEN 1 ELSE 0 END,
        u.market_segment,
        u.sector17_code,
        u.sector17_name,
        u.sector33_code,
        u.sector33_name,
        u.margin_type,
        o.ohlcv_rows,
        COALESCE(v.ml_physics_v2_rows, 0),
        CASE WHEN COALESCE(v.ml_physics_v2_rows, 0) = o.ohlcv_rows THEN 1 ELSE 0 END,
        'ohlcv_daily',
        json_object(
          'latestOhlcvDate', ?,
          'currentByLatestOhlcv', CASE WHEN o.last_trade_date = ? THEN 1 ELSE 0 END,
          'featureSet', ?
        ),
        unixepoch()
      FROM hist_ohlcv o
      LEFT JOIN ticker_universe u ON u.ticker = o.ticker
      LEFT JOIN hist_v2 v ON v.ticker = o.ticker
      ORDER BY o.ticker
      `,
      [latestDate, latestDate, latestDate, latestDate, latestDate, ML_PHYSICS_FEATURE_SET],
    )

    const summary = await execGet<SummaryRow>(
      `
      SELECT
        MAX(latest_ohlcv_date) AS latest_ohlcv_date,
        COUNT(*) AS ohlcv_ticker_count,
        SUM(CASE WHEN is_latest_member = 1 THEN 1 ELSE 0 END) AS latest_member_count,
        SUM(CASE WHEN is_latest_member = 0 THEN 1 ELSE 0 END) AS historical_only_count,
        SUM(missing_from_ticker_universe) AS missing_ticker_universe_count,
        SUM(has_ml_physics_v2) AS ml_feature_complete_count,
        SUM(CASE WHEN has_ml_physics_v2 = 0 THEN 1 ELSE 0 END) AS ml_feature_incomplete_count,
        SUM(ohlcv_rows) AS ohlcv_row_count,
        SUM(ml_physics_v2_rows) AS ml_feature_row_count
      FROM historical_universe
      `,
    )
    if (!summary) throw new Error('historical_universe summary is empty')

    const incomplete = await execAll<SampleRow>(
      `
      SELECT ticker, name, first_trade_date, last_trade_date, ohlcv_rows, ml_physics_v2_rows
      FROM historical_universe
      WHERE has_ml_physics_v2 = 0
      ORDER BY last_trade_date DESC, ticker
      LIMIT 20
      `,
    )
    const status = asNumber(summary.ml_feature_incomplete_count) === 0 ? 'ok' : 'incomplete_ml_features'
    const payload = {
      featureSet: ML_PHYSICS_FEATURE_SET,
      incompleteSamples: incomplete,
    }

    await execRun(
      `
      INSERT INTO historical_universe_audits (
        run_started_at,
        latest_ohlcv_date,
        ohlcv_ticker_count,
        latest_member_count,
        historical_only_count,
        missing_ticker_universe_count,
        ml_feature_complete_count,
        ml_feature_incomplete_count,
        ohlcv_row_count,
        ml_feature_row_count,
        status,
        payload_json,
        computed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      [
        runStartedAt,
        summary.latest_ohlcv_date,
        asNumber(summary.ohlcv_ticker_count),
        asNumber(summary.latest_member_count),
        asNumber(summary.historical_only_count),
        asNumber(summary.missing_ticker_universe_count),
        asNumber(summary.ml_feature_complete_count),
        asNumber(summary.ml_feature_incomplete_count),
        asNumber(summary.ohlcv_row_count),
        asNumber(summary.ml_feature_row_count),
        status,
        JSON.stringify(payload),
      ],
    )

    await execRun(
      `
      UPDATE batch_runs
      SET finished_at = unixepoch(),
          status = ?,
          total_tickers = ?,
          succeeded = ?,
          failed = ?,
          rows_inserted = ?
      WHERE id = ?
      `,
      [
        status === 'ok' ? 'success' : 'warning',
        asNumber(summary.ohlcv_ticker_count),
        asNumber(summary.ml_feature_complete_count),
        asNumber(summary.ml_feature_incomplete_count),
        asNumber(summary.ohlcv_ticker_count),
        runId,
      ],
    )

    console.log(
      [
        `historical universe complete: status=${status}`,
        `tickers=${asNumber(summary.ohlcv_ticker_count).toLocaleString()}`,
        `current=${asNumber(summary.latest_member_count).toLocaleString()}`,
        `historical_only=${asNumber(summary.historical_only_count).toLocaleString()}`,
        `missing_universe=${asNumber(summary.missing_ticker_universe_count).toLocaleString()}`,
        `ml_complete=${asNumber(summary.ml_feature_complete_count).toLocaleString()}`,
        `ml_incomplete=${asNumber(summary.ml_feature_incomplete_count).toLocaleString()}`,
        `ohlcv_rows=${asNumber(summary.ohlcv_row_count).toLocaleString()}`,
        `ml_rows=${asNumber(summary.ml_feature_row_count).toLocaleString()}`,
      ].join(', '),
    )
    if (incomplete.length > 0) {
      console.log('historical universe incomplete samples:', JSON.stringify(incomplete.slice(0, 5)))
    }
  } catch (error) {
    if (runId) {
      await execRun(
        `
      UPDATE batch_runs
        SET finished_at = unixepoch(),
            status = 'failed',
            error_summary = ?
        WHERE id = ?
        `,
        [(error as Error).message, runId],
      )
    }
    throw error
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
