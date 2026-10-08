import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync('app/hex-stage/page.tsx', 'utf8')
const scanner = fs.readFileSync('components/hex/StageTransitionScanner.tsx', 'utf8')
const route = fs.readFileSync('app/api/hex/transitions/route.ts', 'utf8')

assert.match(page, /view === 'scanner'/, 'Market 6 Stage must render the scanner as a normal page view')
assert.match(page, />遷移スキャナー</, 'Market 6 Stage local navigation must expose the scanner')
assert.match(page, /<StageTransitionScanner/, 'The scanner component must be mounted in the production render tree')

assert.match(scanner, /fetch\(`\/api\/hex\/transitions\?\$\{queryString\}`/, 'Scanner reads must stay same-origin')
assert.doesNotMatch(scanner, /https?:\/\/(localhost|127\.0\.0\.1)/, 'Browser code must not hard-code a local origin')
assert.match(scanner, /function ResultSkeleton/, 'Loading state must remain explicit')
assert.match(scanner, /条件に一致する遷移はありません/, 'Empty search results must have a dedicated state')
assert.match(scanner, /遷移銘柄の検索に失敗しました/, 'Provider/query errors must have a dedicated state')
assert.match(scanner, /PAGE_SIZES = \[25, 50, 100\]/, 'Pagination sizes must remain 25, 50, and 100')
assert.match(scanner, /33業種/, 'Industry filtering must remain available')
assert.match(scanner, /20日平均出来高/, 'Average-volume filtering must remain available')
assert.match(scanner, /20日平均売買代金/, 'Average-turnover filtering must remain available')

assert.match(route, /export async function GET/, 'Transition search must use a read-only GET route')
assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, 'Transition search must not expose a mutation method')
assert.match(route, /Cache-Control': 'no-store'/, 'Live transition responses must not be served from a stale shared cache')

console.log('stage transition scanner UI contract tests passed')
