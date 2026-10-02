import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CLAUDE_CLI_PATH,
  CLAUDE_CODE_PROVIDER,
  buildChildEnv,
  createClaudeCodeAdapter,
  redactSecrets,
  type ClaudeCodeErrorCode,
  type ClaudeCodeModel,
  type SpawnFn,
} from '@/lib/server/claude-code-adapter'

// page_design_build 専用 runner。通常の tools-none adapter とは分離し、固定worktreeと
// 固定allowlistだけでClaude自身によるDesign Lab実装・再描画を許可する。

export const PAGE06_DESIGN_WORKTREE = '/Users/yoshio/dev/stock-dashboard/.claude/worktrees/claude-narrative-bridge'
export const PAGE06_COMPONENT_DIR = path.join(PAGE06_DESIGN_WORKTREE, 'components/reports/design-lab/page06')
export const PAGE06_RENDERER_FILE = path.join(PAGE06_DESIGN_WORKTREE, 'scripts/lib/design-lab-page06-render.ts')
export const PAGE06_SNAPSHOT_FILE = '/Users/yoshio/Documents/ChatGPT/MAIL-REPORT-2-QA/page06-design-lab-handoff/page06-momentum-matrix-2026-10-02.snapshot.json'
export const PAGE06_OUTPUT_ROOT = '/Users/yoshio/Documents/ChatGPT/MAIL-REPORT-2-QA/page06-design-lab-build'

const DESIGN_TIMEOUT_MS = 15 * 60_000
const AUTH_TIMEOUT_MS = 15_000
const KILL_GRACE_MS = 5_000
const MAX_STDOUT_BYTES = 4_000_000
const MAX_STDERR_BYTES = 64_000

export const PAGE06_TEST_COMMAND = 'TSX_DISABLE_CACHE=1 ./node_modules/.bin/tsx scripts/test-daily-close-momentum-matrix.ts'
export const PAGE06_TYPECHECK_COMMAND = './node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.json'

export type PageDesignBuildOutput = {
  summary: string
  changedFiles: string[]
  artifacts: Array<{ kind: 'pdf' | 'png' | 'html'; path: string }>
  tests: Array<{ name: string; status: 'pass' | 'fail'; detail: string }>
  remainingIssues: string[]
}

export const PAGE_DESIGN_BUILD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'changedFiles', 'artifacts', 'tests', 'remainingIssues'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 2_000 },
    changedFiles: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 500 } },
    artifacts: {
      type: 'array', maxItems: 30,
      items: { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: { kind: { enum: ['pdf', 'png', 'html'] }, path: { type: 'string', minLength: 1, maxLength: 1_000 } } },
    },
    tests: {
      type: 'array', maxItems: 30,
      items: { type: 'object', additionalProperties: false, required: ['name', 'status', 'detail'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, status: { enum: ['pass', 'fail'] }, detail: { type: 'string', maxLength: 1_000 } } },
    },
    remainingIssues: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 1_000 } },
  },
}

export const PAGE_DESIGN_BUILD_SYSTEM_PROMPT = [
  'あなたはStockBoard資料のDesign Lab担当です。Design Lab内でデザインを考え、実装し、PDF/PNG生成と必要な再調整まで行ってください。',
  '編集可能範囲と実行可能コマンドはホストのallowlistが唯一の権限です。権限外ファイルを変更しようとしないでください。',
  'Production統合、Git操作、DB操作、Gmail、Scheduler、launchd、commit、push、deployは禁止です。',
  '既存の本番成果物を上書きせず、指定された新規run outputだけへ生成してください。',
  '最終回答は変更ファイル、成果物、実行テスト、残課題を指定JSON schemaで返してください。',
].join('\n')

export type ClaudeDesignBuildErrorCode = ClaudeCodeErrorCode | 'WORKSPACE_INVALID' | 'POLICY_VIOLATION' | 'ARTIFACT_INVALID'
export type ClaudeDesignBuildResult =
  | { ok: true; text: string; structuredOutput: unknown; provider: typeof CLAUDE_CODE_PROVIDER; model: string | null; durationMs: number }
  | { ok: false; errorCode: ClaudeDesignBuildErrorCode; errorMessage: string }

export type ClaudeDesignBuildRequest = {
  instruction: string
  model: ClaudeCodeModel
  timeoutMs?: number
  systemPrompt: string
  jsonSchema: Record<string, unknown>
}

export type ClaudeDesignBuildDeps = {
  spawn?: SpawnFn
  cliPath?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  runId?: string
}

type ProcessOutcome =
  | { kind: 'exit'; code: number | null; stdout: string; stderr: string }
  | { kind: 'spawn_error'; code: string | null }
  | { kind: 'timeout' }

function failure(errorCode: ClaudeDesignBuildErrorCode, detail: string): ClaudeDesignBuildResult {
  return { ok: false, errorCode, errorMessage: redactSecrets(detail.replace(/\s+/g, ' ').trim()).slice(0, 300) }
}

function runProcess(spawn: SpawnFn, command: string, args: readonly string[], options: SpawnOptions, input: string, timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let child: ChildProcess
    const settle = (outcome: ProcessOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    try {
      child = spawn(command, args, options)
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
    child.stdin?.on('error', () => {})
    child.stdin?.end(input, 'utf8')
  })
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim())
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function gitFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: PAGE06_DESIGN_WORKTREE, shell: false, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('git file inventory failed')
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort()
}

function sourceSnapshot(): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (const relative of gitFiles()) {
    const absolute = path.join(PAGE06_DESIGN_WORKTREE, relative)
    const stat = fs.lstatSync(absolute)
    const digest = stat.isSymbolicLink()
      ? `symlink:${fs.readlinkSync(absolute)}`
      : stat.isFile()
        ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
        : `other:${stat.mode}`
    snapshot.set(relative, digest)
  }
  return snapshot
}

export function changedSourceFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((file) => before.get(file) !== after.get(file)).sort()
}

export function isPage06EditablePath(relative: string): boolean {
  return relative.startsWith('components/reports/design-lab/page06/') || relative === 'scripts/lib/design-lab-page06-render.ts'
}

function makeRunId(now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`
}

export function designBuildCommands(outputDir: string): { test: string; typecheck: string; render: string } {
  return {
    test: PAGE06_TEST_COMMAND,
    typecheck: PAGE06_TYPECHECK_COMMAND,
    render: `TSX_DISABLE_CACHE=1 ./node_modules/.bin/tsx scripts/design-lab-page06.ts render ${PAGE06_SNAPSHOT_FILE} ${outputDir}`,
  }
}

export function buildDesignBuildArgs(request: ClaudeDesignBuildRequest, outputDir: string): string[] {
  const commands = designBuildCommands(outputDir)
  const allowedTools = [
    'Read', 'Glob', 'Grep',
    `Edit(${PAGE06_COMPONENT_DIR}/**)`, `Write(${PAGE06_COMPONENT_DIR}/**)`,
    `Edit(${PAGE06_RENDERER_FILE})`, `Write(${PAGE06_RENDERER_FILE})`,
    `Read(${path.dirname(PAGE06_SNAPSHOT_FILE)}/**)`,
    `Read(${outputDir}/**)`, `Write(${outputDir}/**)`, `Edit(${outputDir}/**)`,
    `Bash(${commands.test})`, `Bash(${commands.typecheck})`, `Bash(${commands.render})`,
  ]
  return [
    '-p', '--model', request.model, '--output-format', 'json', '--json-schema', JSON.stringify(request.jsonSchema),
    '--max-turns', '30', '--no-session-persistence', '--safe-mode', '--restricted',
    '--tools', 'Read,Glob,Grep,Edit,Write,Bash', '--allowedTools', allowedTools.join(','),
    '--disallowedTools', 'mcp__*,WebFetch,WebSearch,Task,NotebookEdit',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--no-chrome',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--add-dir', path.dirname(PAGE06_SNAPSHOT_FILE), outputDir,
    '--system-prompt', request.systemPrompt,
  ]
}

function buildPrompt(instruction: string, outputDir: string): string {
  const commands = designBuildCommands(outputDir)
  return [
    'Page 06 Design Labを依頼内容に沿って改善し、あなた自身で実装・テスト・PDF/PNG生成・必要な再調整まで完了してください。',
    `<request>${instruction}</request>`,
    '<editable_paths>',
    path.relative(PAGE06_DESIGN_WORKTREE, PAGE06_COMPONENT_DIR),
    path.relative(PAGE06_DESIGN_WORKTREE, PAGE06_RENDERER_FILE),
    '</editable_paths>',
    `<snapshot_readonly>${PAGE06_SNAPSHOT_FILE}</snapshot_readonly>`,
    `<new_output_dir>${outputDir}</new_output_dir>`,
    '<allowed_commands>', commands.test, commands.typecheck, commands.render, '</allowed_commands>',
    '上記以外のファイル変更・コマンド・外部アクセス・Git操作は禁止です。既存PDFを上書きしないでください。',
  ].join('\n')
}

function validateWorkspace(): string | null {
  if (!fs.existsSync(PAGE06_DESIGN_WORKTREE) || !fs.existsSync(PAGE06_COMPONENT_DIR) || !fs.existsSync(PAGE06_RENDERER_FILE)) return 'design worktree or editable source is missing'
  if (!fs.existsSync(PAGE06_SNAPSHOT_FILE)) return 'read-only snapshot is missing'
  for (const target of [PAGE06_COMPONENT_DIR, PAGE06_RENDERER_FILE]) {
    const real = fs.realpathSync(target)
    if (!real.startsWith(`${fs.realpathSync(PAGE06_DESIGN_WORKTREE)}${path.sep}`)) return 'editable path escapes worktree'
  }
  return null
}

export function createClaudeCodeDesignBuildRunner(deps: ClaudeDesignBuildDeps = {}) {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnFn)
  const cliPath = deps.cliPath ?? CLAUDE_CLI_PATH
  const env = buildChildEnv(deps.env ?? process.env)
  const now = deps.now ?? Date.now

  return async function run(request: ClaudeDesignBuildRequest): Promise<ClaudeDesignBuildResult> {
    const startedAt = now()
    const invalidWorkspace = validateWorkspace()
    if (invalidWorkspace) return failure('WORKSPACE_INVALID', invalidWorkspace)
    const outputDir = path.join(PAGE06_OUTPUT_ROOT, 'runs', deps.runId ?? makeRunId(startedAt))
    if (fs.existsSync(outputDir)) return failure('WORKSPACE_INVALID', 'run output already exists')
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 })

    const auth = await createClaudeCodeAdapter({ spawn, cliPath, env }).checkSubscriptionAuth()
    if (!auth.ok) return auth

    let before: Map<string, string>
    try {
      before = sourceSnapshot()
    } catch {
      return failure('WORKSPACE_INVALID', 'source snapshot failed')
    }

    const options: SpawnOptions = { shell: false, cwd: PAGE06_DESIGN_WORKTREE, env, stdio: ['pipe', 'pipe', 'pipe'] }
    const outcome = await runProcess(spawn, cliPath, buildDesignBuildArgs(request, outputDir), options, buildPrompt(request.instruction, outputDir), request.timeoutMs ?? DESIGN_TIMEOUT_MS)
    if (outcome.kind === 'spawn_error') return failure(outcome.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'SPAWN_FAILED', outcome.code ?? 'spawn failed')
    if (outcome.kind === 'timeout') return failure('TIMEOUT', 'page design build timed out')

    let changed: string[]
    try {
      changed = changedSourceFiles(before, sourceSnapshot())
    } catch {
      return failure('WORKSPACE_INVALID', 'post-run source snapshot failed')
    }
    const forbidden = changed.filter((file) => !isPage06EditablePath(file))
    if (forbidden.length) return failure('POLICY_VIOLATION', `changed outside allowlist: ${forbidden.slice(0, 8).join(',')}`)

    const payload = parseObject(outcome.stdout)
    if (!payload) return failure(outcome.code === 0 ? 'INVALID_JSON' : 'NON_ZERO_EXIT', `exit=${outcome.code}`)
    if (payload.is_error === true) return failure('CLI_ERROR', String(payload.subtype ?? 'unknown'))
    if (outcome.code !== 0) return failure('NON_ZERO_EXIT', `exit=${outcome.code}`)
    const modelUsage = isObject(payload.modelUsage) ? payload.modelUsage : {}
    const models = Object.keys(modelUsage)
    if (!models.length || models.some((model) => !isObject(modelUsage[model]) || modelUsage[model].provider !== 'firstParty')) {
      return failure('PROVIDER_MISMATCH', 'postflight provider is not firstParty')
    }
    if (!isObject(payload.structured_output)) return failure('STRUCTURED_OUTPUT_MISSING', 'structured output missing')
    const structured = payload.structured_output
    if (!Array.isArray(structured.changedFiles) || structured.changedFiles.some((file) => typeof file !== 'string' || !isPage06EditablePath(file))) {
      return failure('POLICY_VIOLATION', 'reported changedFiles are outside allowlist')
    }
    const reportedChanged = [...new Set(structured.changedFiles as string[])].sort()
    if (JSON.stringify(reportedChanged) !== JSON.stringify(changed)) {
      return failure('POLICY_VIOLATION', 'reported changedFiles do not match measured source changes')
    }
    if (!Array.isArray(structured.artifacts)) return failure('ARTIFACT_INVALID', 'artifacts missing')
    const artifactKinds = new Set<string>()
    for (const artifact of structured.artifacts) {
      if (!isObject(artifact) || typeof artifact.path !== 'string') return failure('ARTIFACT_INVALID', 'artifact path missing')
      const absolute = path.resolve(artifact.path)
      if (!absolute.startsWith(`${path.resolve(outputDir)}${path.sep}`) || !fs.existsSync(absolute)) return failure('ARTIFACT_INVALID', 'artifact outside run output or missing')
      artifactKinds.add(String(artifact.kind))
    }
    if (!artifactKinds.has('pdf') || !artifactKinds.has('png')) return failure('ARTIFACT_INVALID', 'PDF and PNG outputs are required')
    return {
      ok: true,
      text: JSON.stringify(structured),
      structuredOutput: structured,
      provider: CLAUDE_CODE_PROVIDER,
      model: models[0] ?? null,
      durationMs: now() - startedAt,
    }
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

let defaultRunner: ReturnType<typeof createClaudeCodeDesignBuildRunner> | null = null

export function runClaudeCodeDesignBuild(request: ClaudeDesignBuildRequest): Promise<ClaudeDesignBuildResult> {
  defaultRunner ??= createClaudeCodeDesignBuildRunner()
  return defaultRunner(request)
}
