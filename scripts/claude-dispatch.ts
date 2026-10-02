import { dispatchClaudeCode, type ClaudeTaskId } from '@/lib/server/claude-code-dispatcher'

// Codex 用 stdin/stdout wrapper。長い prompt を argv に入れず、stdout は JSON だけにする。
// 入力: { "task": "page_review", "input": { ... } }

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  let request: { task?: unknown; input?: unknown }
  try {
    request = JSON.parse(await readStdin()) as { task?: unknown; input?: unknown }
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, task: '', errorCode: 'INVALID_INPUT', errorMessage: 'stdin must be one JSON object' })}\n`)
    process.exitCode = 1
    return
  }
  if (typeof request.task !== 'string') {
    process.stdout.write(`${JSON.stringify({ ok: false, task: '', errorCode: 'INVALID_INPUT', errorMessage: 'task must be a string' })}\n`)
    process.exitCode = 1
    return
  }
  const result = await dispatchClaudeCode({ task: request.task as ClaudeTaskId, input: request.input })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, task: '', errorCode: 'ADAPTER_THREW', errorMessage: 'dispatcher failed' })}\n`)
  process.exitCode = 1
})
