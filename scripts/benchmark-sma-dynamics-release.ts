import { performance } from 'node:perf_hooks'
import { computeSmaLab } from '@/lib/sma-dynamics-lab'
import { SMA_LAB_TIMEFRAMES, sessionsBetween, smaLabCalendar, type SmaLabRawRow, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'

function history(market: SmaDynamicsMarket): SmaLabRawRow[] {
  return sessionsBetween(smaLabCalendar(market), '2000-01-03', '2026-10-23').map((date, index) => {
    const close = Math.round((100 + index * 0.025 + Math.sin(index / 17) * 8) * 100) / 100
    return { date, open: close - 0.4, high: close + 1.2, low: close - 1.4, close, volume: 100_000 + index % 10_000 }
  })
}

function percentile(values: number[], quantile: number): number {
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * quantile))]
}

for (const market of ['JP', 'US'] as const) {
  const rows = history(market)
  const asOf = String(rows.at(-1)!.date)
  const payloadBytes = Buffer.byteLength(JSON.stringify({ ticker: market === 'JP' ? '7203' : 'AAPL', history: rows }))
  const run = () => {
    for (const timeframe of SMA_LAB_TIMEFRAMES) {
      const result = computeSmaLab({ rows, market, analysisDate: asOf, timeframe: timeframe.id as SmaLabTimeframeId, horizon: 3 })
      if (result.status !== 'available') throw new Error(`${market}:${timeframe.id}:${result.reason}`)
    }
  }
  run()
  const rssBefore = process.memoryUsage().rss
  const samples: number[] = []
  let peakRss = rssBefore
  for (let index = 0; index < 12; index += 1) {
    const started = performance.now()
    run()
    samples.push(performance.now() - started)
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  console.log(JSON.stringify({
    market,
    rows: rows.length,
    payloadBytes,
    allTimeframes: SMA_LAB_TIMEFRAMES.length,
    runs: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    peakRssDeltaBytes: peakRss - rssBefore,
  }))
}
