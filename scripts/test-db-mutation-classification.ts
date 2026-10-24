import assert from 'node:assert/strict'
import { sqlStatementMayMutate } from '@/lib/db/sql-mutation'

for (const sql of [
  'SELECT * FROM prices',
  '-- comment with DELETE\nSELECT 1',
  '/* UPDATE hidden in comment */ VALUES (1), (2)',
  "WITH source AS (SELECT 'DELETE FROM prices' AS note) SELECT * FROM source",
  'WITH RECURSIVE seq(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM seq WHERE n < 3) SELECT * FROM seq',
  'EXPLAIN INSERT INTO prices VALUES (1)',
  'PRAGMA table_info(prices)',
]) {
  assert.equal(sqlStatementMayMutate(sql), false, `expected read-only SQL: ${sql}`)
}

for (const sql of [
  'INSERT INTO prices VALUES (1)',
  'WITH source AS (SELECT 1) UPDATE prices SET close = 1',
  'WITH source AS (SELECT 1) DELETE FROM prices',
  'WITH source AS (SELECT 1) REPLACE INTO prices VALUES (1)',
  'PRAGMA user_version = 2',
  'PRAGMA journal_mode',
  'VACUUM',
  '',
]) {
  assert.equal(sqlStatementMayMutate(sql), true, `expected mutating or unknown SQL: ${sql}`)
}

console.log('DB mutation classification test passed')
