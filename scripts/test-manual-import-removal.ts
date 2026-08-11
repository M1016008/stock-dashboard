import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const stockDetail = fs.readFileSync(path.join(root, 'app/stock/[ticker]/StockDetailClient.tsx'), 'utf8')
const manualOhlcv = fs.readFileSync(path.join(root, 'lib/manual-ohlcv.ts'), 'utf8')
const quoteRoute = fs.readFileSync(path.join(root, 'app/api/quote/[ticker]/route.ts'), 'utf8')
const historyRoute = fs.readFileSync(path.join(root, 'app/api/history/[ticker]/route.ts'), 'utf8')
const importRoute = path.join(root, 'app/api/manual-ohlcv/[ticker]/route.ts')
const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
  exclude?: string[]
}

assert.equal(fs.existsSync(importRoute), false, 'The manual OHLCV import API must not be exposed.')
assert.doesNotMatch(stockDetail, /ManualOhlcvImportCard|手動OHLCV補完|\/api\/manual-ohlcv/)
assert.doesNotMatch(manualOhlcv, /parseManualOhlcvCsv|upsertManualOhlcvRows|INSERT INTO manual_ohlcv_daily/)

assert.match(quoteRoute, /loadManualLatestOhlcvRows/)
assert.match(historyRoute, /loadManualOhlcvRows/)
assert.match(
  manualOhlcv,
  /export async function loadManualOhlcvRows/,
  'Legacy imported rows must remain readable so removing the importer does not remove existing prices.',
)
assert.ok(
  tsconfig.exclude?.includes('.next-live'),
  'The active build output must be excluded so removed routes cannot survive through stale generated types.',
)

console.log('manual OHLCV import removal tests passed')
