// Quality gate for the JP re-fetch (QUALITY_GATE_JP_20261116.md). Reads the finished run and the Discovery source (immutable),
// writes report.json into a new directory under the re-fetch root, and exits 1 if any stop criterion is met.
//   --run=<finished run directory> --out=<new directory under the re-fetch root>
import fs from 'node:fs'
import path from 'node:path'
import { GATE, runQuality } from '@/lib/research/jp-refetch-quality'
import { DISCOVERY_END } from '@/lib/research/jp-research-refetch'
import { SIX_STAGE_REAL_RESEARCH_ROOT } from '@/lib/research/six-stage-real-data-contract'
import { SPLIT_EXCLUDED } from './analyze-six-stage-transitions-prereg'

const ROOT = path.join(path.dirname(SIX_STAGE_REAL_RESEARCH_ROOT), 'jp-refetch-with-delisted')
const DISCOVERY = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'six-stage-discovery-source-export-20261025T211500JST-v2-r2.incomplete', 'jp-discovery-ohlcv.sqlite')
const DISCOVERY_SHA256 = '63b33fe999eb30d0b499b3e5668ad0aab60f7004c212b805fba4e59cae72c5c8'
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''

function main(): void {
  const run = option('run')
  const out = option('out')
  for (const dir of [run, out]) if (!path.isAbsolute(dir) || path.dirname(dir) !== ROOT) throw new Error(`MUST_BE_UNDER:${ROOT}`)
  if (!fs.existsSync(path.join(run, 'manifest.json'))) throw new Error('RUN_NOT_FINISHED')
  fs.mkdirSync(out, { mode: 0o700 })   // fails if it exists
  // The planned Discovery range (J-Quants Standard reached back to 2016-11-16 on the day of the re-fetch).
  const { report, stops } = runQuality({ refetchDirectory: run, range: { from: '2016-11-16', to: DISCOVERY_END }, discoveryPath: DISCOVERY, discoverySha256: DISCOVERY_SHA256, excludedTickers: SPLIT_EXCLUDED })
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify({ run, checkedAt: new Date().toISOString(), ...report }, null, 2)}\n`, { flag: 'wx', mode: 0o444 })
  console.log(JSON.stringify({ stops, gate: GATE, report: path.join(out, 'report.json') }, null, 2))
  if (stops.length) process.exitCode = 1
}

main()
