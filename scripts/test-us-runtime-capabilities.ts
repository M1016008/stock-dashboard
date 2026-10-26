import assert from 'node:assert/strict'
import { summarizeUsRuntimeCapabilities } from '@/lib/us-status'

function fixtureEnv(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values }
}

const unavailable = summarizeUsRuntimeCapabilities(fixtureEnv(), false)
assert.deepEqual(unavailable, {
  analytics: { configured: false, available: false },
  historicalAnalog: { mode: 'UNAVAILABLE' },
  earningsCalendar: { source: 'FINNHUB', configured: false },
  scenarioNarratives: { enabled: true, configured: false },
  dailyMl: { enabled: true },
  publicationOverrides: { allowStale: false, allowPartial: false },
})

const configured = summarizeUsRuntimeCapabilities(fixtureEnv({
  US_ANALYTICS_DB_PATH: '/fixture/us.db',
  ANALOG_SEARCH_PROXY_URL: 'http://127.0.0.1:3105',
  FINNHUB_API_KEY: 'configured-but-never-returned',
  OPENAI_API_KEY: 'configured-but-never-returned',
  US_SKIP_DAILY_ML: '1',
  US_ALLOW_STALE_DAILY_UPDATE: '1',
  US_ALLOW_PARTIAL_DAILY_PUBLICATION: '1',
}), true)
assert.deepEqual(configured, {
  analytics: { configured: true, available: true },
  historicalAnalog: { mode: 'PROXY' },
  earningsCalendar: { source: 'FINNHUB', configured: true },
  scenarioNarratives: { enabled: true, configured: true },
  dailyMl: { enabled: false },
  publicationOverrides: { allowStale: true, allowPartial: true },
})

const disabled = summarizeUsRuntimeCapabilities(fixtureEnv({
  OPENAI_ASSISTANT_ENABLED: '0',
  OPENAI_API_KEY: 'secret-must-not-be-returned',
  ANALOG_SEARCH_WORKER: '1',
}), true)
assert.equal(disabled.scenarioNarratives.enabled, false)
assert.equal(disabled.scenarioNarratives.configured, false)
assert.equal(disabled.historicalAnalog.mode, 'LOCAL')
assert.doesNotMatch(JSON.stringify(disabled), /secret-must-not-be-returned/)

const placeholder = summarizeUsRuntimeCapabilities(fixtureEnv({ OPENAI_API_KEY: 'sk-xxx-example' }), false)
assert.equal(placeholder.scenarioNarratives.configured, false)

console.log('US runtime capability contract tests: PASS')
