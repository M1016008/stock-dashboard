import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  resolveMaTrajectoryArtifactDirectory,
  resolveMaTrajectorySourceDbPath,
} from '@/lib/ma-trajectory/paths'
import type { MaTrajectoryMarket } from '@/lib/ma-trajectory/core'

function marketFromArgs(): MaTrajectoryMarket {
  return process.argv[2]?.trim().toUpperCase() === 'US' ? 'US' : 'JP'
}

async function main(): Promise<void> {
  const market = marketFromArgs()
  const python = path.join(process.cwd(), '.venv-analog-encoder', 'bin', 'python3')
  const analyzer = path.join(process.cwd(), 'scripts', 'analyze-ma-pair-outcomes.py')
  if (!fs.existsSync(python)) throw new Error('Run `npm run setup:analog-encoder` first.')
  const args = [
    analyzer,
    '--market', market,
    '--source-db', resolveMaTrajectorySourceDbPath(market),
    '--output-dir', resolveMaTrajectoryArtifactDirectory(market),
    '--horizon', process.env.MA_PAIR_ANALYSIS_HORIZON?.trim() || '60',
    '--max-tickers', process.env.MA_PAIR_ANALYSIS_MAX_TICKERS?.trim() || '0',
  ]
  const command = process.platform === 'darwin' && fs.existsSync('/usr/bin/taskpolicy')
    ? '/usr/bin/taskpolicy'
    : '/usr/bin/nice'
  const commandArgs = command.endsWith('taskpolicy')
    ? ['-b', '/usr/bin/nice', '-n', '15', python, ...args]
    : ['-n', '15', python, ...args]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENBLAS_NUM_THREADS: '1',
        OMP_NUM_THREADS: '1',
        VECLIB_MAXIMUM_THREADS: '1',
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`MA pair analysis failed: code=${code ?? 'null'} signal=${signal ?? 'none'}`))
    })
  })
}

main().catch((error) => {
  console.error('[ma-pair-analysis] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
