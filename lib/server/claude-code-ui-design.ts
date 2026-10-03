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

export const UI_DESIGN_PROJECT_ID = 'trigger-discovery-current-v1' as const
export const UI_DESIGN_WORKTREE = '/Users/yoshio/dev/stock-dashboard/.claude/worktrees/ui-design-trigger-discovery'
export const UI_DESIGN_OUTPUT_ROOT = '/Users/yoshio/Documents/ChatGPT/UI-DESIGN-QA/trigger-discovery'

const UI_COMPONENT_DIR = path.join(UI_DESIGN_WORKTREE, 'components/trigger-discovery/design-lab')
const UI_RENDERER_FILE = path.join(UI_DESIGN_WORKTREE, 'scripts/lib/ui-design-lab-trigger-discovery-render.ts')
const UI_TEST_FILE = path.join(UI_DESIGN_WORKTREE, 'scripts/test-trigger-discovery-design-lab.ts')

const UI_READONLY_PATHS = [
  path.join(UI_DESIGN_WORKTREE, 'app/trigger-discovery'),
  path.join(UI_DESIGN_WORKTREE, 'components/trigger-discovery'),
  path.join(UI_DESIGN_WORKTREE, 'app/globals.css'),
  path.join(UI_DESIGN_WORKTREE, 'app/layout.tsx'),
  path.join(UI_DESIGN_WORKTREE, 'components/layout'),
  path.join(UI_DESIGN_WORKTREE, 'components/ui'),
  path.join(UI_DESIGN_WORKTREE, 'lib/trigger-discovery-contract.ts'),
  path.join(UI_DESIGN_WORKTREE, 'lib/trigger-definition.ts'),
  path.join(UI_DESIGN_WORKTREE, 'lib/trigger-discovery-timeframe.ts'),
  path.join(UI_DESIGN_WORKTREE, 'scripts/test-trigger-discovery-ui.ts'),
] as const

const UI_EDITABLE_PATHS = [UI_COMPONENT_DIR, UI_RENDERER_FILE, UI_TEST_FILE] as const
const DESIGN_TIMEOUT_MS = 25 * 60_000
const REVIEW_TIMEOUT_MS = 10 * 60_000
const AUTH_TIMEOUT_MS = 15_000
const KILL_GRACE_MS = 5_000
const MAX_STDOUT_BYTES = 4_000_000
const MAX_STDERR_BYTES = 64_000

export const UI_DESIGN_STATES = ['initial', 'results', 'loading', 'empty', 'error'] as const
export const UI_DESIGN_VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  ipadLandscape: { width: 1024, height: 768 },
  ipadPortrait: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
  wide: { width: 1920, height: 1080 },
} as const

export type UiDesignMode = 'review' | 'build' | 'revision' | 'final_qa'

export type UiDesignOutput = {
  summary: string
  concept: string
  changedFiles: string[]
  artifacts: Array<{ kind: 'png' | 'html' | 'json'; path: string }>
  tests: Array<{ name: string; status: 'pass' | 'fail'; detail: string }>
  findings: string[]
  remainingIssues: string[]
  revisionRecommended: boolean
}

export const UI_DESIGN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'concept', 'changedFiles', 'artifacts', 'tests', 'findings', 'remainingIssues', 'revisionRecommended'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 2_000 },
    concept: { type: 'string', minLength: 1, maxLength: 4_000 },
    changedFiles: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 500 } },
    artifacts: {
      type: 'array', maxItems: 100,
      items: { type: 'object', additionalProperties: false, required: ['kind', 'path'], properties: { kind: { enum: ['png', 'html', 'json'] }, path: { type: 'string', minLength: 1, maxLength: 1_000 } } },
    },
    tests: {
      type: 'array', maxItems: 50,
      items: { type: 'object', additionalProperties: false, required: ['name', 'status', 'detail'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, status: { enum: ['pass', 'fail'] }, detail: { type: 'string', maxLength: 1_000 } } },
    },
    findings: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1_000 } },
    remainingIssues: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1_000 } },
    revisionRecommended: { type: 'boolean' },
  },
}

export const UI_DESIGN_SYSTEM_PROMPT = [
  'あなたはStockBoardのUI/UX Designer兼UI Implementation Engineerです。情報設計を自分で決定し、指定Design Lab内でReact/CSS実装とPreview生成まで行ってください。',
  '対象はTrigger Discoveryの「現在・単日時点」のみです。Period、Historical Scan、Outcome、Path、Follow-up Drawerは編集しません。',
  '既存Production UIは機能・意味・操作契約を理解するためのread-only資料です。business logic、API、DB、計算、Trigger/Score/Stage/PIT、Saved Trigger engineを変更しないでください。',
  'Design Labはfixture-onlyの静的HTML/PNGとして生成し、専用localhost serverだけでPreviewしてください。Next route、Production API、共通health/status、Storage Guard、DB、LaunchAgentへ接続してはいけません。',
  '装飾より、100銘柄前後の比較効率、条件変更から結果確認までの速さ、iPad実用性、loading/empty/errorの明瞭さを優先してください。',
  '編集可能範囲とコマンドはホストallowlistが唯一の権限です。Production統合、Git、DB、Gmail、Scheduler、launchd、commit、push、deployは禁止です。',
  '最終回答は指定JSON schemaだけで返してください。',
].join('\n')

export type ClaudeUiDesignRequest = {
  mode: UiDesignMode
  project: typeof UI_DESIGN_PROJECT_ID
  instruction: string
  context?: Record<string, unknown>
  previousOutputDir?: string
  model: ClaudeCodeModel
  timeoutMs?: number
  systemPrompt: string
  jsonSchema: Record<string, unknown>
}

export type ClaudeUiDesignErrorCode = ClaudeCodeErrorCode | 'WORKSPACE_INVALID' | 'POLICY_VIOLATION' | 'ARTIFACT_INVALID'
export type ClaudeUiDesignResult =
  | { ok: true; text: string; structuredOutput: unknown; provider: typeof CLAUDE_CODE_PROVIDER; model: string | null; durationMs: number }
  | { ok: false; errorCode: ClaudeUiDesignErrorCode; errorMessage: string }

export type ClaudeUiDesignDeps = {
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

type UiManifest = {
  version: 1
  previewPath: string
  screenshots: Array<{ state: string; viewport: string; width: number; height: number; path: string }>
}

function failure(errorCode: ClaudeUiDesignErrorCode, detail: string): ClaudeUiDesignResult {
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

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function gitFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: UI_DESIGN_WORKTREE, shell: false, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('git file inventory failed')
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort()
}

function sourceSnapshot(): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (const relative of gitFiles()) {
    const absolute = path.join(UI_DESIGN_WORKTREE, relative)
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

export function changedUiSourceFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((file) => before.get(file) !== after.get(file)).sort()
}

export function isUiDesignEditablePath(relative: string): boolean {
  return relative.startsWith('components/trigger-discovery/design-lab/')
    || relative === 'scripts/lib/ui-design-lab-trigger-discovery-render.ts'
    || relative === 'scripts/test-trigger-discovery-design-lab.ts'
}

function makeRunId(now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`
}

export function uiDesignCommands(outputDir: string): { test: string; typecheck: string; render: string } {
  return {
    test: 'TSX_DISABLE_CACHE=1 ./node_modules/.bin/tsx scripts/test-trigger-discovery-design-lab.ts',
    typecheck: './node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.json',
    render: `TSX_DISABLE_CACHE=1 ./node_modules/.bin/tsx scripts/lib/ui-design-lab-trigger-discovery-render.ts ${outputDir}`,
  }
}

function toolPath(kind: 'Read' | 'Glob' | 'Grep' | 'Edit' | 'Write', target: string, directory = true): string {
  return `${kind}(${target}${directory ? '/**' : ''})`
}

export function buildUiDesignArgs(request: ClaudeUiDesignRequest, outputDir: string): string[] {
  const commands = uiDesignCommands(outputDir)
  const readTools = UI_READONLY_PATHS.flatMap((target) => {
    const directory = fs.existsSync(target) && fs.statSync(target).isDirectory()
    return (['Read', 'Glob', 'Grep'] as const).map((kind) => toolPath(kind, target, directory))
  })
  const editableReadTools = UI_EDITABLE_PATHS.flatMap((target) => {
    const directory = !path.extname(target)
    return (['Read', 'Glob', 'Grep'] as const).map((kind) => toolPath(kind, target, directory))
  })
  const outputReadTools = (['Read', 'Glob', 'Grep'] as const).map((kind) => toolPath(kind, outputDir))
  const mutationTools = request.mode === 'build' || request.mode === 'revision'
    ? [
        toolPath('Edit', UI_COMPONENT_DIR), toolPath('Write', UI_COMPONENT_DIR),
        toolPath('Edit', UI_RENDERER_FILE, false), toolPath('Write', UI_RENDERER_FILE, false),
        toolPath('Edit', UI_TEST_FILE, false), toolPath('Write', UI_TEST_FILE, false),
        toolPath('Edit', outputDir), toolPath('Write', outputDir),
        `Bash(${commands.test})`, `Bash(${commands.typecheck})`, `Bash(${commands.render})`,
      ]
    : []
  const previousTools = request.previousOutputDir
    ? (['Read', 'Glob', 'Grep'] as const).map((kind) => toolPath(kind, request.previousOutputDir!))
    : []
  const toolNames = request.mode === 'build' || request.mode === 'revision' ? 'Read,Glob,Grep,Edit,Write,Bash' : 'Read,Glob,Grep'
  return [
    '-p', '--model', request.model, '--output-format', 'json', '--json-schema', JSON.stringify(request.jsonSchema),
    '--max-turns', request.mode === 'build' || request.mode === 'revision' ? '40' : '12',
    '--no-session-persistence', '--safe-mode', '--restricted',
    '--tools', toolNames, '--allowedTools', [...readTools, ...editableReadTools, ...outputReadTools, ...previousTools, ...mutationTools].join(','),
    '--disallowedTools', 'mcp__*,WebFetch,WebSearch,Task,NotebookEdit',
    '--permission-mode', request.mode === 'build' || request.mode === 'revision' ? 'acceptEdits' : 'default',
    '--permission-prompts', 'none', '--no-chrome', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--add-dir', outputDir, ...(request.previousOutputDir ? ['--add-dir', request.previousOutputDir] : []),
    '--system-prompt', request.systemPrompt,
  ]
}

function buildPrompt(request: ClaudeUiDesignRequest, outputDir: string): string {
  const commands = uiDesignCommands(outputDir)
  const common = [
    `<mode>${request.mode}</mode>`,
    `<project>${request.project}</project>`,
    `<request>${request.instruction}</request>`,
    request.context ? `<context>${JSON.stringify(request.context)}</context>` : '',
    '<production_source_readonly>', ...UI_READONLY_PATHS.map((target) => path.relative(UI_DESIGN_WORKTREE, target)), '</production_source_readonly>',
    '<editable_paths>', ...UI_EDITABLE_PATHS.map((target) => path.relative(UI_DESIGN_WORKTREE, target)), '</editable_paths>',
    `<new_output_dir>${outputDir}</new_output_dir>`,
    request.previousOutputDir ? `<previous_output_readonly>${request.previousOutputDir}</previous_output_readonly>` : '',
  ]
  if (request.mode === 'review') {
    return [
      '既存Trigger Discoveryをread-onlyで調査し、現在・単日時点の情報設計、比較効率、iPad操作性を評価してください。Design Specの判断はあなた自身で行ってください。ファイル変更は0です。',
      ...common,
    ].filter(Boolean).join('\n')
  }
  if (request.mode === 'final_qa') {
    return [
      '完成したDesign Lab sourceとScreenshotをread-onlyで確認し、overflow、overlap、情報階層、100銘柄比較、iPad操作性、loading/empty/errorを厳しく評価してください。ファイル変更は0です。',
      ...common,
    ].filter(Boolean).join('\n')
  }
  return [
    request.mode === 'revision'
      ? '前回成果物とQA findingsを読み、明らかな問題を1回だけ修正して全Screenshotを再生成してください。'
      : '既存UIをread-onlyで理解し、情報設計を自分で決定してDesign Labの初版をReact/CSSで実装してください。',
    ...common,
    '<required_states>initial,results,loading,empty,error</required_states>',
    '<required_viewports>desktop 1440x1000; ipadLandscape 1024x768; ipadPortrait 768x1024; mobile 390x844; wide 1920x1080</required_viewports>',
    '<required_manifest>ui-design-lab-manifest.json: version=1, previewPath, screenshots[{state,viewport,width,height,path}] for every 5x5 combination</required_manifest>',
    '<allowed_commands>', commands.test, commands.typecheck, commands.render, '</allowed_commands>',
    'rendererはリポジトリ外のnew_output_dirだけへfixture-onlyの静的HTML/PNG/manifestを生成してください。Next routeやProduction APIを使わず、全25 PNGをReadで確認して結果をstructured outputへ記録してください。',
    '上記以外のファイル変更、任意コマンド、外部アクセス、Git操作は禁止です。',
  ].filter(Boolean).join('\n')
}

function validateWorkspace(request: ClaudeUiDesignRequest): string | null {
  if (request.project !== UI_DESIGN_PROJECT_ID) return 'unknown UI design project'
  if (!fs.existsSync(UI_DESIGN_WORKTREE)) return 'UI design worktree is missing'
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: UI_DESIGN_WORKTREE, shell: false, encoding: 'utf8' })
  if (branch.status !== 0 || branch.stdout.trim() !== 'claude/ui-design-trigger-discovery-phase1') return 'unexpected UI design branch'
  for (const target of UI_READONLY_PATHS) if (!fs.existsSync(target)) return `read-only source missing: ${path.basename(target)}`
  if (request.previousOutputDir) {
    const previous = path.resolve(request.previousOutputDir)
    if (!previous.startsWith(`${path.resolve(UI_DESIGN_OUTPUT_ROOT)}${path.sep}`) || !fs.existsSync(previous)) return 'previous output is outside UI output root or missing'
  }
  return null
}

function pngDimensions(file: string): { width: number; height: number } | null {
  const bytes = fs.readFileSync(file)
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function validateManifest(outputDir: string): string | null {
  const manifestPath = path.join(outputDir, 'ui-design-lab-manifest.json')
  if (!fs.existsSync(manifestPath)) return 'UI screenshot manifest is missing'
  let manifest: UiManifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as UiManifest
  } catch {
    return 'UI screenshot manifest is invalid JSON'
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.screenshots) || typeof manifest.previewPath !== 'string') return 'UI screenshot manifest contract is invalid'
  const resolveArtifactPath = (artifactPath: string) => path.isAbsolute(artifactPath)
    ? path.resolve(artifactPath)
    : path.resolve(outputDir, artifactPath)
  const preview = resolveArtifactPath(manifest.previewPath)
  if (!preview.startsWith(`${path.resolve(outputDir)}${path.sep}`) || !fs.existsSync(preview)) return 'preview HTML is outside output or missing'
  for (const state of UI_DESIGN_STATES) {
    for (const [viewport, size] of Object.entries(UI_DESIGN_VIEWPORTS)) {
      const item = manifest.screenshots.find((entry) => entry.state === state && entry.viewport === viewport)
      if (!item || item.width !== size.width || item.height !== size.height) return `screenshot missing: ${state}/${viewport}`
      const absolute = resolveArtifactPath(item.path)
      if (!absolute.startsWith(`${path.resolve(outputDir)}${path.sep}`) || !fs.existsSync(absolute)) return `screenshot path invalid: ${state}/${viewport}`
      const dimensions = pngDimensions(absolute)
      if (!dimensions || dimensions.width !== size.width || dimensions.height !== size.height) return `screenshot dimensions invalid: ${state}/${viewport}`
    }
  }
  return null
}

export function createClaudeCodeUiDesignRunner(deps: ClaudeUiDesignDeps = {}) {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnFn)
  const cliPath = deps.cliPath ?? CLAUDE_CLI_PATH
  const env = buildChildEnv(deps.env ?? process.env)
  const now = deps.now ?? Date.now

  return async function run(request: ClaudeUiDesignRequest): Promise<ClaudeUiDesignResult> {
    const startedAt = now()
    const invalidWorkspace = validateWorkspace(request)
    if (invalidWorkspace) return failure('WORKSPACE_INVALID', invalidWorkspace)
    const suffix = request.mode === 'revision' ? '-revision' : `-${request.mode}`
    const outputDir = path.join(UI_DESIGN_OUTPUT_ROOT, 'runs', `${deps.runId ?? makeRunId(startedAt)}${suffix}`)
    if (fs.existsSync(outputDir)) return failure('WORKSPACE_INVALID', 'run output already exists')
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 })

    const auth = await createClaudeCodeAdapter({ spawn, cliPath, env }).checkSubscriptionAuth()
    if (!auth.ok) return auth
    let before: Map<string, string>
    try { before = sourceSnapshot() } catch { return failure('WORKSPACE_INVALID', 'source snapshot failed') }

    const outcome = await runProcess(
      spawn,
      cliPath,
      buildUiDesignArgs(request, outputDir),
      { shell: false, cwd: UI_DESIGN_WORKTREE, env, stdio: ['pipe', 'pipe', 'pipe'] },
      buildPrompt(request, outputDir),
      request.timeoutMs ?? (request.mode === 'build' || request.mode === 'revision' ? DESIGN_TIMEOUT_MS : REVIEW_TIMEOUT_MS),
    )
    if (outcome.kind === 'spawn_error') return failure(outcome.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'SPAWN_FAILED', outcome.code ?? 'spawn failed')
    if (outcome.kind === 'timeout') return failure('TIMEOUT', `UI ${request.mode} timed out`)

    let changed: string[]
    try { changed = changedUiSourceFiles(before, sourceSnapshot()) } catch { return failure('WORKSPACE_INVALID', 'post-run source snapshot failed') }
    const canEdit = request.mode === 'build' || request.mode === 'revision'
    const forbidden = canEdit ? changed.filter((file) => !isUiDesignEditablePath(file)) : changed
    if (forbidden.length) return failure('POLICY_VIOLATION', `changed outside allowlist: ${forbidden.slice(0, 8).join(',')}`)

    const payload = parseObject(outcome.stdout)
    if (!payload) return failure(outcome.code === 0 ? 'INVALID_JSON' : 'NON_ZERO_EXIT', `exit=${outcome.code}`)
    if (payload.is_error === true) return failure('CLI_ERROR', String(payload.subtype ?? 'unknown'))
    if (outcome.code !== 0) return failure('NON_ZERO_EXIT', `exit=${outcome.code}`)
    const modelUsage = isObject(payload.modelUsage) ? payload.modelUsage : {}
    const models = Object.keys(modelUsage)
    if (!models.length || models.some((model) => !isObject(modelUsage[model]) || modelUsage[model].provider !== 'firstParty')) return failure('PROVIDER_MISMATCH', 'postflight provider is not firstParty')
    if (!isObject(payload.structured_output)) return failure('STRUCTURED_OUTPUT_MISSING', 'structured output missing')
    const structured = payload.structured_output
    if (!Array.isArray(structured.changedFiles) || structured.changedFiles.some((file) => typeof file !== 'string')) return failure('POLICY_VIOLATION', 'reported changedFiles are invalid')
    const reportedChanged = [...new Set(structured.changedFiles as string[])].sort()
    if (JSON.stringify(reportedChanged) !== JSON.stringify(changed)) return failure('POLICY_VIOLATION', 'reported changedFiles do not match measured source changes')

    if (canEdit) {
      const manifestError = validateManifest(outputDir)
      if (manifestError) return failure('ARTIFACT_INVALID', manifestError)
    }
    if (!Array.isArray(structured.artifacts)) return failure('ARTIFACT_INVALID', 'artifacts missing')
    const artifactRoots = [outputDir, ...(request.mode === 'final_qa' && request.previousOutputDir ? [request.previousOutputDir] : [])]
      .map((root) => path.resolve(root))
    for (const artifact of structured.artifacts) {
      if (!isObject(artifact) || typeof artifact.path !== 'string') return failure('ARTIFACT_INVALID', 'artifact path missing')
      const absolute = path.isAbsolute(artifact.path)
        ? path.resolve(artifact.path)
        : path.resolve(request.mode === 'final_qa' && request.previousOutputDir ? request.previousOutputDir : outputDir, artifact.path)
      const inAllowedRoot = artifactRoots.some((root) => absolute.startsWith(`${root}${path.sep}`))
      if (!inAllowedRoot || !fs.existsSync(absolute)) return failure('ARTIFACT_INVALID', 'artifact outside run output or missing')
    }
    return { ok: true, text: JSON.stringify(structured), structuredOutput: structured, provider: CLAUDE_CODE_PROVIDER, model: models[0] ?? null, durationMs: now() - startedAt }
  }
}

let defaultRunner: ReturnType<typeof createClaudeCodeUiDesignRunner> | null = null

export function runClaudeCodeUiDesign(request: ClaudeUiDesignRequest): Promise<ClaudeUiDesignResult> {
  defaultRunner ??= createClaudeCodeUiDesignRunner()
  return defaultRunner(request)
}
