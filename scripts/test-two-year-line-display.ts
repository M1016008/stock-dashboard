import assert from 'node:assert/strict'

import {
  TWO_YEAR_LINE_DISPLAY_STORAGE_KEY,
  assignTwoYearLineSlots,
  parseTwoYearLineDisplayPayload,
  readTwoYearLineDisplaySettings,
  resolveTwoYearLineDisplay,
  resolveTwoYearLineDisplays,
  serializeTwoYearLineDisplayPayload,
  updateTwoYearLineSlot,
  writeTwoYearLineDisplaySettings,
} from '../lib/two-year-line-display'

const line = (id: string, endpointStartYear: number, status: 'confirmed' | 'provisional' = 'confirmed') =>
  ({ id, endpointStartYear, status })

// slots: chronological, not status based; deterministic ties
const slots = assignTwoYearLineSlots([line('b', 2024), line('z', 2026, 'provisional'), line('a', 2024)])
assert.equal(slots.get('z'), 'recent')
assert.equal(slots.get('a'), 'previous')
assert.equal(slots.has('b'), false)
assert.equal(assignTwoYearLineSlots([]).size, 0)
assert.equal(assignTwoYearLineSlots([line('x', 2024)]).get('x'), 'recent')

// defaults
assert.deepEqual(resolveTwoYearLineDisplay('confirmed', 'recent', {}), {
  slot: 'recent', style: 'solid', color: '#0f766e', width: 3, dashArray: null,
})
const prov = resolveTwoYearLineDisplay('provisional', 'previous', {})
assert.equal(prov.style, 'dashed')
assert.equal(prov.color, '#b7791f')
assert.equal(prov.width, 2)
assert.equal(prov.dashArray, '8 6')

// overrides keep width by status
let settings = updateTwoYearLineSlot({}, 'recent', { style: 'dotted', color: '#2563EB' })
const over = resolveTwoYearLineDisplay('provisional', 'recent', settings)
assert.equal(over.style, 'dotted')
assert.equal(over.color, '#2563eb')
assert.equal(over.width, 2)
assert.ok(over.dashArray)
assert.equal(resolveTwoYearLineDisplay('provisional', 'previous', settings).style, 'dashed')
const map = resolveTwoYearLineDisplays([line('c', 2026), line('d', 2024, 'provisional')], settings)
assert.equal(map.get('c')?.style, 'dotted')
assert.equal(map.get('d')?.style, 'dashed')

// persistence round trip + reset
const payload = serializeTwoYearLineDisplayPayload(settings)
assert.ok(payload)
assert.deepEqual(parseTwoYearLineDisplayPayload(payload), settings)
assert.equal(serializeTwoYearLineDisplayPayload({}), null)

// invalid payloads fall back safely
for (const bad of [null, '', 'nope', '[]', '{"version":2,"slots":{}}', '{"version":1,"slots":null}']) {
  assert.deepEqual(parseTwoYearLineDisplayPayload(bad), {})
}
assert.deepEqual(
  parseTwoYearLineDisplayPayload('{"version":1,"slots":{"recent":{"style":"wavy","color":"red"},"previous":{"style":"dashed","color":"#12345"},"other":{"style":"solid"}}}'),
  { previous: { style: 'dashed' } },
)

// storage helpers
const store = new Map<string, string>()
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
}
writeTwoYearLineDisplaySettings(storage, settings)
assert.ok(store.has(TWO_YEAR_LINE_DISPLAY_STORAGE_KEY))
assert.deepEqual(readTwoYearLineDisplaySettings(storage), settings)
writeTwoYearLineDisplaySettings(storage, {})
assert.equal(store.size, 0)
assert.deepEqual(readTwoYearLineDisplaySettings(null), {})
assert.deepEqual(readTwoYearLineDisplaySettings({ getItem: () => { throw new Error('denied') } }), {})
writeTwoYearLineDisplaySettings({ setItem: () => { throw new Error('quota') }, removeItem: () => {} }, settings)

// reset: single confirmed line in recent slot returns to teal solid
settings = {}
assert.deepEqual(
  resolveTwoYearLineDisplays([line('only', 2026)], settings).get('only'),
  { slot: 'recent', style: 'solid', color: '#0f766e', width: 3, dashArray: null },
)

console.log('two-year line display tests passed')
