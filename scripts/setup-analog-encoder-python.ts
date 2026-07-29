import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const venvPath = path.join(process.cwd(), '.venv-analog-encoder')
const python = process.env.ANALOG_ENCODER_BOOTSTRAP_PYTHON?.trim() || 'python3'
const venvPython = path.join(venvPath, 'bin', 'python3')
const requirements = path.join(process.cwd(), 'requirements', 'analog-encoder.txt')

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    },
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`)
  }
}

if (!fs.existsSync(venvPython)) {
  run(python, ['-m', 'venv', venvPath])
}
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])
run(venvPython, ['-m', 'pip', 'install', '-r', requirements])
run(venvPython, [
  path.join(process.cwd(), 'scripts', 'train-analog-state-encoder.py'),
  '--self-test',
])
console.log(`Analog encoder Python environment is ready: ${venvPython}`)
