import { spawn } from 'node:child_process'

const allowedScript = 'scripts/refresh-after-ohlcv.ts'
const script = process.argv[2]
if (script !== allowedScript || typeof process.send !== 'function') {
  throw new Error('jp_ohlcv_registered_child_contract_invalid')
}

const startTimeout = setTimeout(() => {
  console.error('jp_ohlcv_registered_child_start_timeout')
  process.exit(124)
}, 60_000)

process.once('message', (message) => {
  if (!message || (message as { type?: unknown }).type !== 'START') {
    console.error('jp_ohlcv_registered_child_start_message_invalid')
    process.exit(125)
  }
  clearTimeout(startTimeout)
  const child = spawn('npx', ['tsx', '--env-file=.env.local', script], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, USE_LOCAL_DB: '1' },
  })
  child.once('error', (error) => {
    console.error(error)
    process.exit(126)
  })
  child.once('close', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 127)
  })
})
