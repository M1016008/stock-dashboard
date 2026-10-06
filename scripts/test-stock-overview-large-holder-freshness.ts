import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  shouldRevalidateStockLargeHolders,
  stockLargeHolderCertifiedState,
  stockLargeHolderFailureState,
} from '@/lib/large-holders/stock-overview-availability'

assert.equal(stockLargeHolderFailureState('certified_snapshot_stale'), 'STALE')
assert.equal(stockLargeHolderFailureState('certified_snapshot_stale_review'), 'STALE')
assert.equal(stockLargeHolderFailureState('certified_snapshot_not_configured'), 'NOT_CONFIGURED')
assert.equal(stockLargeHolderFailureState('certified_snapshot_missing'), 'NO_DATA')
assert.equal(stockLargeHolderFailureState('certified_snapshot_pointer_unavailable'), 'NO_DATA')
assert.equal(stockLargeHolderFailureState('certified_snapshot_pointer_invalid'), 'ERROR')
assert.equal(stockLargeHolderFailureState('snapshot_digest_mismatch'), 'ERROR')
assert.equal(stockLargeHolderFailureState('network_error'), 'ERROR')

assert.equal(stockLargeHolderCertifiedState('VALIDATED'), 'CURRENT')
assert.equal(stockLargeHolderCertifiedState('VALIDATED_WITH_QUARANTINE'), 'CURRENT')
assert.equal(shouldRevalidateStockLargeHolders('STALE'), true)
assert.equal(shouldRevalidateStockLargeHolders('CURRENT'), false)
assert.equal(shouldRevalidateStockLargeHolders('NOT_CONFIGURED'), false)

const component = readFileSync('components/large-holders/StockLargeHolders.tsx', 'utf8')
assert.ok(!component.includes('marketDate'), 'Overview must not calculate independent market-date freshness')
assert.ok(!component.includes('最新データの再集計が必要です。'),
  'Overview must not expose an internal recomputation instruction')
assert.ok(component.includes('VALIDATED_WITH_QUARANTINE'),
  'validated quarantine must be represented as a current certified snapshot')
assert.ok(component.includes('shouldRevalidateStockLargeHolders'),
  'stale canonical state must revalidate without a page remount')
assert.ok(component.includes("addEventListener('focus'"),
  'focus must revalidate a stale canonical state')
assert.ok(component.includes("visibilitychange"),
  'visibility restoration must revalidate a stale canonical state')

console.log('stock Overview Large Holder canonical freshness regression: PASS')
