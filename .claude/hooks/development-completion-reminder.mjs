import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

let input
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
} catch {
  console.error('StockBoard completion gate blocked: Claude hook input was not valid JSON.')
  process.exit(2)
}

const event = input.hook_event_name
if (event !== 'Stop' && event !== 'TaskCompleted') {
  console.error(`StockBoard completion gate blocked: unsupported Claude hook event ${String(event)}.`)
  process.exit(2)
}

const completionMarker = '[stockboard-development-complete]'
if (event === 'Stop' && !String(input.last_assistant_message || '').toLowerCase().includes(completionMarker)) {
  // Stop fires after every ordinary response. Only an explicit completion claim is gated.
  process.exit(0)
}

const project = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd())
const runner = path.join(project, 'node_modules', '.bin', 'tsx')
const workflow = path.join(project, 'scripts', 'development-workflow.ts')

if (!fs.existsSync(runner) || !fs.existsSync(workflow)) {
  console.error('StockBoard completion gate blocked: dependencies or workflow CLI are unavailable; run npm ci and review docs/development-completion-workflow.md.')
  process.exit(2)
}

const result = spawnSync(runner, [workflow, 'hook', `--path=${project}`, `--event=${event}`], {
  cwd: project,
  encoding: 'utf8',
  timeout: 25_000,
})

if (result.status === 0 && !result.error) process.exit(0)
if (result.stderr) process.stderr.write(result.stderr)
else if (result.stdout) process.stderr.write(result.stdout)
else if (result.error) process.stderr.write(`StockBoard completion gate could not run: ${result.error.message}\n`)
else process.stderr.write(`StockBoard completion gate failed with status ${String(result.status)}.\n`)

// Exit 2 is the documented blocking signal for both Stop and TaskCompleted.
process.exit(2)
