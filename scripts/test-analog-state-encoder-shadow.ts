import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), file), 'utf8')
}

const trainer = read('scripts/train-analog-state-encoder.py')
assert.match(trainer, /class MultiFrameEncoder/)
assert.match(trainer, /"daily": slice\(0, 41\)/)
assert.match(trainer, /"weekly": slice\(41, 49\)/)
assert.match(trainer, /"monthly": slice\(49, 57\)/)
assert.match(trainer, /"yearly": slice\(57, 65\)/)
assert.match(trainer, /pairedMaeDifference95Ci/)
assert.match(trainer, /noMaterialHorizonRegression/)
assert.match(trainer, /action": "shadow_only_even_when_passed"/)
assert.match(trainer, /productionRankingChanged": False/)
assert.match(trainer, /CREATE TABLE IF NOT EXISTS analog_encoder_shadow_rankings/)
assert.doesNotMatch(trainer, /UPDATE\s+serving_current_similars/i)
assert.doesNotMatch(trainer, /INSERT\s+INTO\s+serving_current_similars/i)

const runner = read('scripts/run-analog-state-encoder-shadow.ts')
assert.match(runner, /US_ADJUSTED_PRICE_BASIS/)
assert.match(runner, /analog_index_price_basis/)
assert.match(runner, /indexMeta\.sourceDate !== currentSourceDate/)
assert.match(runner, /process\.exitCode = 75/)
assert.match(runner, /minFreePercent/)
assert.match(runner, /minAvailableMb/)
assert.match(runner, /OPENBLAS_NUM_THREADS/)
assert.match(runner, /productionRankingChanged: false/)

const route = read('app/api/ml/historical-analogs/route.ts')
assert.doesNotMatch(route, /analog[_-]encoder/i)

const packageJson = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>
}
assert.match(packageJson.scripts['setup:analog-encoder'], /setup-analog-encoder-python/)
assert.match(packageJson.scripts['batch:analog-encoder-shadow:jp'], /shadow\.ts jp/)
assert.match(packageJson.scripts['batch:analog-encoder-shadow:us'], /shadow\.ts us/)

console.log('Analog state encoder shadow tests passed')
