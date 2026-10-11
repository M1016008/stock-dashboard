import fs from 'node:fs'
import path from 'node:path'

type Feature = Record<string, string>
type Board = { schemaVersion: number; updatedAt: string; features: Feature[] }

const root = process.cwd()
const boardPath = path.join(root, 'docs/us-stockboard-parity-board.json')
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8')) as Board
const required = [
  'wave', 'feature', 'jp', 'us', 'functional', 'visual', 'data', 'historical',
  'responsive', 'performance', 'claude', 'codexQa', 'git', 'production', 'remaining',
]
const allowedParity = new Set([
  'IMPLEMENTED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE', 'BLOCKED', 'UNVERIFIED', 'IN_PROGRESS',
])

if (board.schemaVersion !== 1) throw new Error(`Unsupported board schema: ${board.schemaVersion}`)
if (!/^\d{4}-\d{2}-\d{2}$/.test(board.updatedAt)) throw new Error('Board updatedAt must be YYYY-MM-DD')
if (!Array.isArray(board.features) || board.features.length === 0) throw new Error('Parity board is empty')

const names = new Set<string>()
for (const [index, feature] of board.features.entries()) {
  for (const key of required) {
    if (typeof feature[key] !== 'string' || !feature[key].trim()) {
      throw new Error(`Feature ${index + 1} is missing ${key}`)
    }
  }
  if (names.has(feature.feature)) throw new Error(`Duplicate feature: ${feature.feature}`)
  names.add(feature.feature)
  for (const key of ['jp', 'us', 'functional', 'visual', 'data', 'historical', 'responsive', 'performance']) {
    if (!allowedParity.has(feature[key])) throw new Error(`${feature.feature}: invalid ${key}=${feature[key]}`)
  }
}

const counts = new Map<string, number>()
for (const feature of board.features) counts.set(feature.us, (counts.get(feature.us) ?? 0) + 1)
const unresolved = board.features.filter((feature) => (
  feature.us !== 'IMPLEMENTED' && feature.us !== 'NOT_APPLICABLE'
))

console.log('US STOCKBOARD PARITY BOARD')
console.log(`Updated: ${board.updatedAt}`)
console.log(`Features: ${board.features.length}`)
for (const status of ['IMPLEMENTED', 'PARTIAL', 'MISSING', 'BLOCKED', 'UNVERIFIED', 'NOT_APPLICABLE']) {
  console.log(`${status}: ${counts.get(status) ?? 0}`)
}
console.log(`Remaining: ${unresolved.length}`)
for (const wave of ['W0', 'W1', 'W2', 'W3', 'W4', 'W5']) {
  const rows = board.features.filter((feature) => feature.wave === wave)
  if (!rows.length) continue
  const pending = rows.filter((feature) => feature.us !== 'IMPLEMENTED' && feature.us !== 'NOT_APPLICABLE')
  console.log(`${wave}: ${rows.length - pending.length}/${rows.length} closed`)
}
