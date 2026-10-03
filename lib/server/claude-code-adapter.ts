import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import os from 'node:os'

// Claude Code CLI を Pro subscription (claude.ai OAuth) 経路でのみ呼び出す server-side adapter。
// - API key / Console 課金 / Bedrock / Vertex / Foundry へは fallback しない
// - OAuth token を読まない・コピーしない (認証は CLI 自身が Keychain から行う)
// - Claude にはツールを一切与えない (Narrative 生成専用)

export const CLAUDE_CLI_PATH = '/Users/yoshio/.local/bin/claude'
export const CLAUDE_CODE_PROVIDER = 'claude-code-subscription' as const
export const CLAUDE_CODE_MODEL = 'sonnet' as const
export type ClaudeCodeModel = 'sonnet' | 'opus'

const DEFAULT_TIMEOUT_MS = 120_000
const AUTH_TIMEOUT_MS = 15_000
const KILL_GRACE_MS = 5_000
const MAX_PROMPT_BYTES = 100_000
const MAX_STDOUT_BYTES = 2_000_000
const MAX_STDERR_BYTES = 64_000
const ERROR_SNIPPET_CHARS = 200

// 子プロセスへ渡す環境変数の allowlist。ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN /
// CLAUDE_CODE_USE_* 等は継承させない (API 課金経路・3P provider への切替を防ぐ)。
const ENV_ALLOWLIST = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR'] as const

export type ClaudeCodeErrorCode =
  | 'INVALID_REQUEST'
  | 'CLI_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'AUTH_EXPIRED'
  | 'NOT_SUBSCRIPTION'
  | 'TIMEOUT'
  | 'NON_ZERO_EXIT'
  | 'INVALID_JSON'
  | 'CLI_ERROR'
  | 'PROVIDER_MISMATCH'
  | 'STRUCTURED_OUTPUT_MISSING'
  | 'EMPTY_RESULT'

export type ClaudeCodeResult =
  | {
    ok: true
    text: string
    structuredOutput: unknown
    provider: typeof CLAUDE_CODE_PROVIDER
    model: string | null
    durationMs: number
  }
  | { ok: false; errorCode: ClaudeCodeErrorCode; errorMessage: string }

export type ClaudeCodeRequest = {
  prompt: string
  systemPrompt: string
  jsonSchema?: Record<string, unknown>
  timeoutMs?: number
  model?: ClaudeCodeModel
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export type ClaudeCodeAdapterDeps = {
  spawn?: SpawnFn
  cliPath?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

type ProcessOutcome =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'spawn_error'; code: string | null }
  | { kind: 'timeout' }

type AuthCheck = { ok: true; subscriptionType: string } | { ok: false; errorCode: ClaudeCodeErrorCode; errorMessage: string }

const ERROR_MESSAGES: Record<ClaudeCodeErrorCode, string> = {
  INVALID_REQUEST: 'Claude Code request is invalid',
  CLI_NOT_FOUND: 'Claude Code CLI was not found',
  SPAWN_FAILED: 'Claude Code CLI could not be started',
  AUTH_EXPIRED: 'Claude Code login is missing or expired; run `claude` and /login with the Pro subscription',
  NOT_SUBSCRIPTION: 'Claude Code is not authenticated via claude.ai subscription; refusing to run',
  TIMEOUT: 'Claude Code CLI timed out',
  NON_ZERO_EXIT: 'Claude Code CLI exited with a non-zero status',
  INVALID_JSON: 'Claude Code CLI returned output that is not valid JSON',
  CLI_ERROR: 'Claude Code CLI reported an error result',
  PROVIDER_MISMATCH: 'Claude Code response was not served by the first-party subscription provider',
  STRUCTURED_OUTPUT_MISSING: 'Claude Code response has no structured_output',
  EMPTY_RESULT: 'Claude Code response has no result text',
}

const AUTH_FAILURE_PATTERN = /\b401\b|invalid api key|please run \/login|not logged in|log ?in again|oauth token (?:has )?expired|authentication_error|unauthorized/i

export function redactSecrets(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/((?:access|refresh|oauth|api)[_-]?(?:token|key)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1<redacted>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, '<redacted>')
}

function failure(errorCode: ClaudeCodeErrorCode, detail?: string): { ok: false; errorCode: ClaudeCodeErrorCode; errorMessage: string } {
  const snippet = detail ? redactSecrets(detail.replace(/\s+/g, ' ').trim()).slice(0, ERROR_SNIPPET_CHARS) : ''
  return { ok: false, errorCode, errorMessage: snippet ? `${ERROR_MESSAGES[errorCode]}: ${snippet}` : ERROR_MESSAGES[errorCode] }
}

export function buildChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // allowlist外の環境変数は渡さない。
  const env = {} as NodeJS.ProcessEnv
  for (const key of ENV_ALLOWLIST) {
    const value = source[key]
    if (value) env[key] = value
  }
  return env
}

// auth status / 実推論の双方がこの options で起動する。
// cwd は os.tmpdir() に固定し、worktree (CLAUDE.md / AGENTS.md / .claude/) を継承させない。
export function childSpawnOptions(env: NodeJS.ProcessEnv): SpawnOptions {
  return { shell: false, cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] }
}

export function buildClaudeArgs(request: Pick<ClaudeCodeRequest, 'systemPrompt' | 'jsonSchema' | 'model'>): string[] {
  return [
    '-p',
    '--model', request.model ?? CLAUDE_CODE_MODEL,
    '--output-format', 'json',
    ...(request.jsonSchema ? ['--json-schema', JSON.stringify(request.jsonSchema)] : []),
    '--max-turns', '1',
    '--no-session-persistence',
    '--safe-mode',
    '--tools', '',
    '--disallowedTools', 'mcp__*',
    '--permission-prompts', 'none',
    '--no-chrome',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--system-prompt', request.systemPrompt,
  ]
}

function runProcess(spawn: SpawnFn, command: string, args: readonly string[], env: NodeJS.ProcessEnv, input: string | null, timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: ProcessOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    let child: ChildProcess
    try {
      child = spawn(command, args, childSpawnOptions(env))
    } catch (error) {
      resolve({ kind: 'spawn_error', code: (error as NodeJS.ErrnoException).code ?? null })
      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL') }, KILL_GRACE_MS).unref()
      settle({ kind: 'timeout' })
    }, timeoutMs)

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < MAX_STDERR_BYTES) stderr += chunk })
    child.on('error', (error: NodeJS.ErrnoException) => settle({ kind: 'spawn_error', code: error.code ?? null }))
    child.on('close', (code) => settle({ kind: 'exit', code, stdout, stderr }))

    // EPIPE 等 (CLI が stdin を読む前に終了) は close / error 側で扱う
    child.stdin?.on('error', () => {})
    if (input != null) child.stdin?.end(input, 'utf8')
    else child.stdin?.end()
  })
}

function spawnFailure(code: string | null): { ok: false; errorCode: ClaudeCodeErrorCode; errorMessage: string } {
  return code === 'ENOENT' ? failure('CLI_NOT_FOUND') : failure('SPAWN_FAILED', code ?? undefined)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim())
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps = {}) {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnFn)
  const cliPath = deps.cliPath ?? CLAUDE_CLI_PATH
  const env = buildChildEnv(deps.env ?? process.env)
  const now = deps.now ?? Date.now

  // Phase 1: 認証結果はキャッシュしない。推論の直前に毎回 `claude auth status` を確認する。
  async function checkSubscriptionAuth(): Promise<AuthCheck> {
    const outcome = await runProcess(spawn, cliPath, ['auth', 'status'], env, null, AUTH_TIMEOUT_MS)
    if (outcome.kind === 'spawn_error') return spawnFailure(outcome.code)
    if (outcome.kind === 'timeout') return failure('TIMEOUT', 'auth status')
    const status = parseJsonObject(outcome.stdout)
    if (!status) {
      if (AUTH_FAILURE_PATTERN.test(`${outcome.stdout}\n${outcome.stderr}`)) return failure('AUTH_EXPIRED')
      return failure(outcome.code === 0 ? 'INVALID_JSON' : 'NON_ZERO_EXIT', 'auth status')
    }
    // email / orgId 等は読み捨てる (ログ・返却値に含めない)
    if (status.loggedIn !== true) return failure('AUTH_EXPIRED')
    if (status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') {
      return failure('NOT_SUBSCRIPTION', `authMethod=${String(status.authMethod)} apiProvider=${String(status.apiProvider)}`)
    }
    if (typeof status.subscriptionType !== 'string' || !status.subscriptionType) return failure('NOT_SUBSCRIPTION', 'subscriptionType missing')
    return { ok: true, subscriptionType: status.subscriptionType }
  }

  async function run(request: ClaudeCodeRequest): Promise<ClaudeCodeResult> {
    const startedAt = now()
    if (!request.prompt.trim() || !request.systemPrompt.trim()) return failure('INVALID_REQUEST', 'prompt and systemPrompt are required')
    if (Buffer.byteLength(request.prompt, 'utf8') > MAX_PROMPT_BYTES) return failure('INVALID_REQUEST', 'prompt too large')

    const auth = await checkSubscriptionAuth()
    if (!auth.ok) return auth

    const outcome = await runProcess(spawn, cliPath, buildClaudeArgs(request), env, request.prompt, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (outcome.kind === 'spawn_error') return spawnFailure(outcome.code)
    if (outcome.kind === 'timeout') return failure('TIMEOUT')

    const payload = parseJsonObject(outcome.stdout)
    if (!payload) {
      if (AUTH_FAILURE_PATTERN.test(`${outcome.stdout}\n${outcome.stderr}`)) return failure('AUTH_EXPIRED')
      return outcome.code === 0 ? failure('INVALID_JSON') : failure('NON_ZERO_EXIT', `exit=${outcome.code}`)
    }

    const resultText = typeof payload.result === 'string' ? payload.result : ''
    if (payload.api_error_status === 401 || payload.api_error_status === 403 || (payload.is_error === true && AUTH_FAILURE_PATTERN.test(resultText))) {
      return failure('AUTH_EXPIRED')
    }
    if (payload.is_error === true) return failure('CLI_ERROR', typeof payload.subtype === 'string' ? payload.subtype : undefined)
    if (outcome.code !== 0) return failure('NON_ZERO_EXIT', `exit=${outcome.code}`)

    const modelUsage = payload.modelUsage && typeof payload.modelUsage === 'object' ? payload.modelUsage as Record<string, { provider?: unknown }> : {}
    const models = Object.keys(modelUsage)
    if (!models.length || models.some((model) => modelUsage[model]?.provider !== 'firstParty')) {
      return failure('PROVIDER_MISMATCH', models.map((model) => `${model}:${String(modelUsage[model]?.provider)}`).join(','))
    }

    let text: string
    let structuredOutput: unknown = null
    if (request.jsonSchema) {
      // CLI 2.1.285 実測: --json-schema 指定時は top-level `structured_output` に object が入る
      const structured = payload.structured_output
      if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return failure('STRUCTURED_OUTPUT_MISSING')
      structuredOutput = structured
      text = JSON.stringify(structured)
    } else {
      if (!resultText.trim()) return failure('EMPTY_RESULT')
      text = resultText
    }

    return { ok: true, text, structuredOutput, provider: CLAUDE_CODE_PROVIDER, model: models[0] ?? null, durationMs: now() - startedAt }
  }

  return { checkSubscriptionAuth, run }
}

let defaultAdapter: ReturnType<typeof createClaudeCodeAdapter> | null = null

export function runClaudeCode(request: ClaudeCodeRequest): Promise<ClaudeCodeResult> {
  defaultAdapter ??= createClaudeCodeAdapter()
  return defaultAdapter.run(request)
}
