import { evaluateTradeScenario } from '../lib/trade-scenarios/scoring'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const bullish = evaluateTradeScenario({
  direction: 'bullish',
  anchorPrice: 100,
  horizonDays: 5,
  targetPrice: 108,
  stopLossPrice: 95,
  futureRows: [
    { date: '2026-01-02', high: 103, low: 99, close: 102 },
    { date: '2026-01-03', high: 109, low: 101, close: 108 },
  ],
})
assert(bullish.status === 'target_hit', 'bullish target should be hit')
assert(bullish.targetHitDay === 2, 'bullish target day should be 2')

const bearish = evaluateTradeScenario({
  direction: 'bearish',
  anchorPrice: 100,
  horizonDays: 5,
  targetPrice: 92,
  stopLossPrice: 105,
  futureRows: [
    { date: '2026-01-02', high: 101, low: 97, close: 98 },
    { date: '2026-01-03', high: 99, low: 91, close: 93 },
  ],
})
assert(bearish.status === 'target_hit', 'bearish target should be hit')
assert(bearish.tone === 'down', 'bearish target tone should be down')

const conservative = evaluateTradeScenario({
  direction: 'bullish',
  anchorPrice: 100,
  horizonDays: 5,
  targetPrice: 108,
  stopLossPrice: 95,
  futureRows: [
    { date: '2026-01-02', high: 110, low: 94, close: 101 },
  ],
})
assert(conservative.status === 'stop_hit', 'same-day target and stop should choose conservative stop')

const watch = evaluateTradeScenario({
  direction: 'watch',
  anchorPrice: 100,
  horizonDays: 2,
  targetPrice: null,
  stopLossPrice: null,
  futureRows: [
    { date: '2026-01-02', high: 101, low: 99, close: 100.2 },
    { date: '2026-01-03', high: 102, low: 98.5, close: 100.1 },
  ],
})
assert(watch.status === 'watch_ok', 'quiet watch scenario should be ok')

console.log('trade-scenario tests passed')
