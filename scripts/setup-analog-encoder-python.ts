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

function canImportLightgbm(): boolean {
  return spawnSync(venvPython, ['-c', 'import lightgbm'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: process.env,
  }).status === 0
}

if (!fs.existsSync(venvPython)) {
  run(python, ['-m', 'venv', venvPath])
}
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])
run(venvPython, ['-m', 'pip', 'install', '-r', requirements])
if (!canImportLightgbm() && process.platform === 'darwin') {
  console.log('LightGBM wheel requires libomp; rebuilding a low-memory macOS variant without OpenMP.')
  run(venvPython, ['-m', 'pip', 'install', 'cmake', 'ninja'])
  run(venvPython, ['-m', 'pip', 'uninstall', '-y', 'lightgbm'])
  run(venvPython, [
    '-m',
    'pip',
    'install',
    '--no-binary=lightgbm',
    '--config-settings=cmake.define.USE_OPENMP=OFF',
    'lightgbm>=4,<5',
  ])
}
if (!canImportLightgbm()) {
  throw new Error('LightGBM could not be imported after environment setup')
}
run(venvPython, [
  path.join(process.cwd(), 'scripts', 'train-analog-state-encoder.py'),
  '--self-test',
])
console.log(`Analog encoder Python environment is ready: ${venvPython}`)
