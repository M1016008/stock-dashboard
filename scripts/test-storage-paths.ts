import assert from 'node:assert/strict'
import path from 'node:path'
import {
  CURRENT_STORAGE_ROOT,
  LEGACY_STORAGE_ROOT,
  resolveConfiguredStoragePath,
} from '@/lib/storage-paths'

const legacy = path.join(LEGACY_STORAGE_ROOT, 'stock-dashboard', 'stockboard.db')
const current = path.join(CURRENT_STORAGE_ROOT, 'stock-dashboard', 'stockboard.db')

assert.equal(resolveConfiguredStoragePath(current, (candidate) => candidate === current), current)
assert.equal(resolveConfiguredStoragePath(legacy, (candidate) => candidate === current), current)
assert.equal(resolveConfiguredStoragePath(legacy, () => false), legacy)
assert.equal(resolveConfiguredStoragePath('/tmp/custom.db', () => false), '/tmp/custom.db')

console.log('storage path compatibility tests passed')
