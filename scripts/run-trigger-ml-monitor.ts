import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const python = process.env.TRIGGER_ML_RESEARCH_PYTHON?.trim()
  || path.join(os.homedir(), 'Library/Application Support/StockBoard/trigger-ml-research-venv/bin/python')
const db = process.env.STOCKBOARD_DB_PATH?.trim()
if (!existsSync(python) || !db || !existsSync(db)) {
  throw new Error('frozen_monitor_python_or_db_unavailable')
}

const venvLib = path.resolve(python, '../../lib')
const result = spawnSync(python, ['scripts/trigger_ml_phase15f_ops.py', ...process.argv.slice(2)], {
  cwd: process.cwd(), stdio: 'inherit',
  env: { ...process.env, STOCKBOARD_DB_PATH: db,
    DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH || venvLib,
    USE_LOCAL_DB: '1' },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
