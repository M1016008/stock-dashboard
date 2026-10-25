import type { BenchScenario } from '../lib/scenario'

/** Pipeline self-check: proves fixture build, prepare, interleaved cold/warm sampling and equivalence diffing. */
export const scenarios: BenchScenario[] = [
  {
    id: 'smoke/search-name-substring',
    title: 'Pipeline self-check: GET /api/search?q=… over a synthetic ticker universe',
    priority: 'B',
    market: 'JP',
    fixture: { id: 'smoke', params: { tickers: 2_000 } },
    async request(context) {
      return context.callRoute('app/api/search/route.ts', 'http://local.test/api/search?q=Smoke%20Company%2012', { key: 'q12' })
    },
    describe(body) {
      const rows = Array.isArray(body) ? body as Array<{ ticker?: string }> : []
      return { count: rows.length, first: rows[0]?.ticker ?? null }
    },
  },
]
