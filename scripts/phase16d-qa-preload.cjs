const fs = require('node:fs')
const path = require('node:path')
const sqlite = require('node:sqlite')

if (process.env.PHASE16D_SHADOW_QA !== '1') {
  throw new Error('phase16d_qa_preload_requires_shadow_mode')
}
const directory = process.env.PHASE16D_QA_METRICS_DIR
if (!directory?.includes('/stock-dashboard/qa/phase16d-shadow/')) {
  throw new Error('phase16d_qa_metrics_directory_invalid')
}
fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

const startedAt = Date.now()
const metrics = { sqliteQueries: 0, libsqlQueries: 0, edinetRequests: 0,
  jquantsRequests: 0, otherFetches: 0, peakRssBytes: process.memoryUsage().rss }
globalThis.__phase16dQaSqlQuery = (count = 1) => { metrics.libsqlQueries += count }

for (const method of ['get', 'all', 'run', 'iterate']) {
  const original = sqlite.StatementSync.prototype[method]
  sqlite.StatementSync.prototype[method] = function (...args) {
    metrics.sqliteQueries += 1
    return Reflect.apply(original, this, args)
  }
}
const originalFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  const host = new URL(typeof input === 'string' ? input : input.url).hostname
  if (host === 'api.edinet-fsa.go.jp') metrics.edinetRequests += 1
  else if (/jpx|jquants/i.test(host)) metrics.jquantsRequests += 1
  else metrics.otherFetches += 1
  return Reflect.apply(originalFetch, this, [input, init])
}
const sample = setInterval(() => {
  metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss)
}, 1000)
sample.unref()
process.once('exit', () => {
  metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss)
  const record = { at: new Date().toISOString(), pid: process.pid,
    script: process.argv.find((arg) => arg.endsWith('.ts')) ?? process.argv[1] ?? null,
    stage: process.env.PHASE16D_QA_STAGE ?? null, elapsedMs: Date.now() - startedAt,
    ...metrics }
  fs.appendFileSync(path.join(directory, 'process-metrics.ndjson'), `${JSON.stringify(record)}\n`,
    { mode: 0o600 })
})
