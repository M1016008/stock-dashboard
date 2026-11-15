// Re-fetches JP daily bars including stocks delisted later, for the research data (PREREG_START_TIMING_20261116.md).
// Default is observe (no API call). Writing needs --confirm=WRITE_APPROVED_RESEARCH_REFETCH.
//   --out=<new directory under the research root> --from=YYYY-MM-DD --to=YYYY-MM-DD (<= 2022-12-30)
//   [--resume] [--pause-ms=1000]   (J-Quants Standard allows 120 requests/minute; one date takes about 3 s)
// Run with: tsx --env-file=<.env.local> scripts/fetch-jp-research-daily-bars.ts ... (the API key is never printed)
import path from 'node:path'
import { fetchJQuantsDailyBarsRawByDate, fetchJQuantsListedInfo } from '@/lib/jquants'
import { assertOutput, assertRange, runRefetch, weekdays } from '@/lib/research/jp-research-refetch'
import { SIX_STAGE_REAL_RESEARCH_ROOT } from '@/lib/research/six-stage-real-data-contract'

const ROOT = path.join(path.dirname(SIX_STAGE_REAL_RESEARCH_ROOT), 'jp-refetch-with-delisted')
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const known = ['out', 'from', 'to', 'resume', 'pause-ms', 'confirm']
for (const arg of process.argv.slice(2)) {
  if (!known.includes(/^--([a-z-]+)/.exec(arg)?.[1] ?? '')) throw new Error(`UNKNOWN_ARGUMENT:${arg}`)
}

async function main(): Promise<void> {
  const from = option('from') ?? ''
  const to = option('to') ?? ''
  assertRange(from, to)
  const resume = process.argv.includes('--resume')
  const directory = assertOutput(option('out') ?? '', ROOT, resume)
  const pauseMs = Number(option('pause-ms') ?? 1_000)
  if (!Number.isSafeInteger(pauseMs) || pauseMs < 0) throw new Error('PAUSE_MS_INVALID')
  if (option('confirm') !== 'WRITE_APPROVED_RESEARCH_REFETCH') {
    console.log(JSON.stringify({ mode: 'observe', root: ROOT, directory, from, to, resume, weekdays: weekdays(from, to).length, pauseMs }, null, 2))
    return
  }
  const { manifestPath, manifest } = await runRefetch({ directory, resume, from, to, pauseMs,
    source: { bars: fetchJQuantsDailyBarsRawByDate, listings: (date) => fetchJQuantsListedInfo(undefined, date) } })
  console.log(JSON.stringify({ mode: 'execute', manifestPath, manifest }, null, 2))
}

main().catch((error: unknown) => {
  console.error(`[refetch] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
