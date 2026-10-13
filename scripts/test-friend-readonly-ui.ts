import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  isFriendReadonlyRequestAllowed,
  isFriendReadonlyJsonPostPath,
} from '@/lib/friend-readonly-policy'

assert.equal(isFriendReadonlyRequestAllowed('GET', '/stock/6098'), true)
assert.equal(isFriendReadonlyRequestAllowed('POST', '/api/integrated-screener'), true)
assert.equal(isFriendReadonlyRequestAllowed('POST', '/api/trigger-discovery/search'), true)
assert.equal(isFriendReadonlyRequestAllowed('POST', '/api/us/trigger-discovery/search'), true)
assert.equal(isFriendReadonlyRequestAllowed('POST', '/api/us/trigger-discovery/mini-charts'), true)
assert.equal(isFriendReadonlyRequestAllowed('POST', '/api/us/trigger-discovery/saved'), false)
assert.equal(isFriendReadonlyRequestAllowed('POST', '/api/assistant/chat'), false)
assert.equal(isFriendReadonlyRequestAllowed('POST', '/api/trade/scenarios'), false)
assert.equal(isFriendReadonlyRequestAllowed('PATCH', '/api/custom-charts/example'), false)
assert.equal(isFriendReadonlyRequestAllowed('GET', '/admin/db'), false)
assert.equal(isFriendReadonlyRequestAllowed('GET', '/large-holders/admin/entities'), false)
assert.equal(isFriendReadonlyJsonPostPath('/api/integrated-screener/interpret'), false)

const layout = fs.readFileSync('app/layout.tsx', 'utf8')
const boundary = fs.readFileSync('components/layout/FriendReadonlyAccessBoundary.tsx', 'utf8')
const scenarioRoute = fs.readFileSync('app/api/stock-scenario-projections/[ticker]/route.ts', 'utf8')
const backtestRoute = fs.readFileSync('app/api/backtest/detail/route.ts', 'utf8')
const usTriggerClient = fs.readFileSync('app/us/trigger-discovery/UsTriggerDiscoveryClient.tsx', 'utf8')

assert.match(layout, /x-stockboard-access-mode/)
assert.match(layout, /FriendReadonlyAccessBoundary/)
assert.match(layout, /!friendReadonly && <AssistantDrawer/)
assert.match(boundary, /閲覧専用/)
assert.match(boundary, /window\.fetch/)
assert.match(scenarioRoute, /const llmEnabled = !friendReadonly/)
assert.match(backtestRoute, /friendReadonly\s*\? fallbackComment/)
assert.match(usTriggerClient, /fetch\('\/api\/us\/trigger-discovery\/search'/)
assert.match(usTriggerClient, /fetch\('\/api\/us\/trigger-discovery\/mini-charts'/)

console.log('friend read-only UI: PASS (mode visible, read transports usable, writes and AI sends blocked)')
