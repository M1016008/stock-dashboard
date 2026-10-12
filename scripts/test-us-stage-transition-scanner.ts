import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync('app/us/analysis/transitions/page.tsx', 'utf8')
const route = fs.readFileSync('app/api/us/hex/transitions/route.ts', 'utf8')
const scanner = fs.readFileSync('components/hex/StageTransitionScanner.tsx', 'utf8')
const executor = fs.readFileSync('lib/server/us-stage-transition-scanner.ts', 'utf8')

assert.match(page, /firstParam\(sp\.view\) === 'scanner'/, 'US transitions must expose a scanner view')
assert.match(page, /<StageTransitionScanner[^>]+market="US"/, 'US scanner must select US presentation and transport')
assert.match(page, /\/us\/analysis\/transitions\?view=scanner/, 'US local navigation must link to the scanner')

assert.match(route, /export async function GET/, 'US transition scanner must remain read-only GET')
assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, 'US transition scanner must not expose mutations')
assert.match(route, /value == null \|\| value\.trim\(\) === ''/, 'Omitted pagination must use the documented defaults')
assert.match(route, /universeFilter: null/, 'JP-only universe filters must not leak into the US query')
assert.match(route, /usStageTransitionExecutor/, 'US route must use the isolated US analytics database')
assert.match(route, /CURRENT_US_TICKER_UNIVERSE/, 'US classification basis must be explicit')
assert.match(route, /Cache-Control': 'no-store'/, 'PIT scanner results must not use a stale shared cache')

assert.match(executor, /execUsAnalyticsAll/, 'US executor must use US analytics reads')
assert.match(executor, /execUsAnalyticsGet/, 'US executor must use US analytics point reads')
assert.doesNotMatch(executor, /@\/lib\/db\/client/, 'US executor must never fall back to the JP database')

assert.match(scanner, /apiPath: '\/api\/hex\/transitions'/, 'JP API transport must remain the default')
assert.match(scanner, /apiPath: '\/api\/us\/hex\/transitions'/, 'US API transport must be same-origin and isolated')
assert.match(scanner, /stockHrefPrefix: '\/us\/stock'/, 'US rows must drill down to US stock detail')
assert.match(scanner, /industryLabel: 'Industry'/, 'US taxonomy must not be presented as JP 33-sector data')
assert.match(scanner, /marketLabel: 'Exchange'/, 'US exchange metadata must not be presented as JP market segments')
assert.match(scanner, /priceLabel: '株価（USD）'/, 'US prices must disclose USD units')
assert.match(scanner, /tickerSortLabel: 'ティッカー'/, 'US sort controls must use ticker terminology')
assert.match(scanner, /priceFractionDigits: \{ min: 2, max: 2 \}/, 'US results must retain cent precision')
assert.match(scanner, /現在の米国株ティッカーユニバースの分類/, 'Current-only US classification labels must be disclosed')
assert.doesNotMatch(scanner, /priceLabel\.includes\('USD'\)/, 'Currency behavior must use explicit market configuration')
assert.doesNotMatch(scanner, /https?:\/\/(localhost|127\.0\.0\.1)/, 'Browser reads must remain same-origin')

console.log('US stage transition scanner contract tests passed')
