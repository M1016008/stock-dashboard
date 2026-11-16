// Fetches the auxiliary J-Quants data for the short-side ML and studies E/F (PLAN_SHORT_TRANSITION_ML_20261116.md, step 2):
// regulation (margin-alert), short-sale reports, earnings disclosures and scheduled dates, TOPIX and the exchange calendar.
// Margin balances and sector short ratios are left for later (owner decision, 2026-11-16).
// Default is observe (no API call). Writing needs --confirm=WRITE_APPROVED_RESEARCH_AUX_FETCH.
//   --out=<new directory under the research root> --from=YYYY-MM-DD --to=YYYY-MM-DD (<= 2022-12-30)
//   [--resume] [--pause-ms=1000]   (all six datasets, always; a stopped run is finished with --resume)
// Run with: tsx --env-file=<.env.local> scripts/fetch-jp-research-aux.ts ... (the API key is never printed)
import path from 'node:path'
import { fetchJQuantsPagesStrict } from '@/lib/jquants'
import { AUX_DATASETS, AUX_DB_NAME, runAuxFetch } from '@/lib/research/jp-research-aux-fetch'
import { assertOutput, assertRange, weekdays } from '@/lib/research/jp-research-refetch'
import { SIX_STAGE_REAL_RESEARCH_ROOT } from '@/lib/research/six-stage-real-data-contract'

const ROOT = path.join(path.dirname(SIX_STAGE_REAL_RESEARCH_ROOT), 'jp-refetch-with-delisted')
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
for (const arg of process.argv.slice(2)) {
  if (!['out', 'from', 'to', 'resume', 'pause-ms', 'confirm'].includes(/^--([a-z-]+)/.exec(arg)?.[1] ?? '')) {
    throw new Error(`UNKNOWN_ARGUMENT:${arg}`)
  }
}

async function main(): Promise<void> {
  const from = option('from') ?? ''
  const to = option('to') ?? ''
  assertRange(from, to)
  const datasets = Object.keys(AUX_DATASETS)
  const resume = process.argv.includes('--resume')
  const directory = assertOutput(option('out') ?? '', ROOT, resume, AUX_DB_NAME)
  const pauseMs = Number(option('pause-ms') ?? 1_000)
  if (!Number.isSafeInteger(pauseMs) || pauseMs < 0) throw new Error('PAUSE_MS_INVALID')
  const calls = datasets.reduce((sum, name) => sum + (AUX_DATASETS[name].by === 'date' ? weekdays(from, to).length : 1), 0)
  if (option('confirm') !== 'WRITE_APPROVED_RESEARCH_AUX_FETCH') {
    console.log(JSON.stringify({ mode: 'observe', root: ROOT, directory, from, to, resume, datasets, calls, pauseMs }, null, 2))
    return
  }
  const { manifestPath, manifest } = await runAuxFetch({ directory, resume, from, to, datasets, pauseMs, source: fetchJQuantsPagesStrict })
  console.log(JSON.stringify({ mode: 'execute', manifestPath, manifest }, null, 2))
}

main().catch((error: unknown) => {
  console.error(`[aux] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
