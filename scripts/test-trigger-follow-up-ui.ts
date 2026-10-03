import assert from 'node:assert/strict'
import fs from 'node:fs'
import { formatPathReturn, horizonDisplay, pathMilestones } from '@/components/trigger-discovery/TriggerFollowUpDrawer'
import type { TriggerPathHorizonResult, TriggerPathProfile } from '@/lib/trigger-path-contract'

const drawer = fs.readFileSync('components/trigger-discovery/TriggerFollowUpDrawer.tsx', 'utf8')
const workspace = fs.readFileSync('components/trigger-discovery/HistoricalScanWorkspace.tsx', 'utf8')
const route = fs.readFileSync('app/api/trigger-discovery/historical-scan/jobs/[jobId]/events/[eventKey]/follow-up/route.ts', 'utf8')

assert.ok(workspace.includes('event.eventKey'), 'Event row must use the saved event key')
assert.ok(workspace.includes('setFollowUpEvent(event)'), 'Event action must open the drawer')
assert.ok(workspace.includes('その後を見る'), 'Action must have a visible label')
assert.ok(drawer.includes('role="dialog"') && drawer.includes('aria-modal="true"'), 'Drawer must be an accessible dialog')
assert.ok(drawer.includes('その後の値動きを確認しています'), 'Drawer must open before the request resolves')
assert.ok(drawer.includes('new AbortController()') && drawer.includes('sequence.current'), 'Stale event requests must not overwrite the active event')
assert.ok(drawer.includes('controller.abort()'), 'Closing the drawer must abort its request')
assert.ok(drawer.includes('result.status === 410') && drawer.includes('EXPIRED_MESSAGE'), 'Expired artifacts must have a user-facing error')
assert.ok(drawer.includes('max-w-[680px]') && drawer.includes('w-full'), 'Desktop and mobile drawer widths must differ responsively')
assert.ok(drawer.includes('MeasuredChartFrame') && drawer.includes('ComposedChart') && drawer.includes('zoneBand'), 'Chart must show the saved path and dynamic zone')
assert.ok(drawer.includes('pathMilestones(profile, anchorLabel, response.event.priceDate)'), 'Timeline must follow the path profile and saved price date')
assert.ok(drawer.includes('x={response.event.priceDate}'), 'Anchor marker must use the saved price date')
assert.ok(drawer.includes("event.snapshotBasis === 'PREVIOUS' ? '前回候補値' : 'Hit'"), 'Exited events must label their previous snapshot anchor')
assert.ok(route.includes('getTriggerPathFollowUp'), 'UI must use the Phase 14A read-only API')

const horizon: TriggerPathHorizonResult = { horizonSessions: 20, availability: false, endDate: null, returnFromHit: null, path: null }
assert.deepEqual(horizonDisplay(horizon, 10), { status: '未確定', value: '未確定', remaining: 10 })
assert.deepEqual(horizonDisplay(horizon, 20), { status: 'N/A', value: 'N/A', remaining: null })
assert.deepEqual(horizonDisplay(horizon, 25), { status: 'N/A', value: 'N/A', remaining: null })
assert.deepEqual(horizonDisplay({ ...horizon, availability: true, returnFromHit: 0.048, path: {} as TriggerPathHorizonResult['path'] }, 20), { status: '確定', value: '+4.8%', remaining: null })
assert.equal(formatPathReturn(-0.072), '-7.2%')
assert.equal(formatPathReturn(null), 'N/A')

const profile = {
  eventDate: '2025-09-04', deepestDate: '2025-09-08', firstZoneLowerReclaimDate: '2025-09-12',
  firstZoneUpperReclaimDate: '2025-09-17', latestDate: '2025-09-18',
} as TriggerPathProfile
assert.deepEqual(pathMilestones(profile).map((entry) => entry.label), ['Hit', '最深部', '初回Zone回復', '初回上限回復', '最新'])
assert.deepEqual(pathMilestones(profile, '前回候補値').map((entry) => entry.label), ['前回候補値', '最深部', '初回Zone回復', '初回上限回復', '最新'])
assert.deepEqual(pathMilestones(profile, '前回候補値', '2025-09-03').map((entry) => entry.date), ['2025-09-03', '2025-09-08', '2025-09-12', '2025-09-17', '2025-09-18'])
assert.deepEqual(pathMilestones({ ...profile, deepestDate: null, firstZoneLowerReclaimDate: null, firstZoneUpperReclaimDate: null }).map((entry) => entry.label), ['Hit', '最新'])
console.log('Trigger Follow-up UI contract: event identity, drawer loading/race/expired, chart, horizons, timeline PASS')
