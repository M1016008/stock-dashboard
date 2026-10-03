import assert from 'node:assert/strict'
import { parseMacMemoryHeadroom } from '@/lib/system/memory-guard'

const pageSize = 16_384
const snapshot = parseMacMemoryHeadroom(`
Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free:                               10000.
Pages active:                            20000.
Pages inactive:                         300000.
Pages speculative:                       20000.
Pages throttled:                              0.
Pages purgeable:                          5000.
Pages occupied by compressor:           100000.
`, 'System-wide memory free percentage: 58%')

const pagesToMb = (pages: number) => pages * pageSize / (1024 * 1024)
assert.equal(snapshot.immediateAvailableMb, pagesToMb(35_000))
assert.equal(snapshot.inactiveMb, pagesToMb(300_000))
assert.equal(snapshot.availableMb, pagesToMb(335_000))
assert.equal(snapshot.compressorMb, pagesToMb(100_000))
assert.equal(snapshot.freePercent, 58)
assert.equal(snapshot.throttledPages, 0)
assert.ok(snapshot.availableMb > 5_000, 'reclaimable inactive pages should satisfy a 5GB capacity guard')

const withoutPressure = parseMacMemoryHeadroom(`
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 1.
Pages inactive: 2.
Pages speculative: 3.
Pages purgeable: 4.
Pages occupied by compressor: 5.
Pages throttled: 6.
`)
assert.equal(withoutPressure.availableMb, 10 * 4096 / (1024 * 1024))
assert.equal(withoutPressure.freePercent, null)
assert.equal(withoutPressure.throttledPages, 6)

console.log('Memory guard reclaimable-capacity tests passed')
