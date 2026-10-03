import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  CLAUDE_TASK_IDS,
  CLAUDE_TASK_PROFILES,
  dispatchClaudeCode,
  getClaudeTaskProfile,
  type ClaudeTaskId,
} from '@/lib/server/claude-code-dispatcher'
import { CLAUDE_CODE_PROVIDER, type ClaudeCodeRequest, type ClaudeCodeResult } from '@/lib/server/claude-code-adapter'
import {
  PAGE06_COMPONENT_DIR,
  PAGE06_RENDERER_FILE,
  PAGE06_SNAPSHOT_FILE,
  buildDesignBuildArgs,
  changedSourceFiles,
  designBuildCommands,
  isPage06EditablePath,
  type ClaudeDesignBuildRequest,
  type ClaudeDesignBuildResult,
} from '@/lib/server/claude-code-design-build'
import {
  UI_DESIGN_OUTPUT_ROOT,
  UI_DESIGN_PROJECT_ID,
  UI_DESIGN_WORKTREE,
  buildUiDesignArgs,
  changedUiSourceFiles,
  isUiDesignEditablePath,
  uiDesignCommands,
  type ClaudeUiDesignRequest,
  type ClaudeUiDesignResult,
} from '@/lib/server/claude-code-ui-design'

const validOutputs = {
  market_narrative: { headline: '見出し', paragraphs: ['段落'] },
  page_review: { summary: '要約', strengths: ['強み'], issues: [{ severity: 'medium', area: '表', issue: '密度', recommendation: '余白を調整' }], suggestedChanges: ['変更'] },
  copy_edit: { revisedText: '修正文', changes: ['簡潔化'] },
  design_review: { overallAssessment: '良好', hierarchyIssues: [], spacingIssues: [], typographyIssues: [], chartIssues: [], recommendations: ['維持'] },
  final_review: { blockingIssues: [], nonBlockingIssues: ['軽微'], suggestedFixes: ['確認'] },
  page_design_build: { summary: '完了', changedFiles: ['components/reports/design-lab/page06/styles.ts'], artifacts: [], tests: [{ name: 'typecheck', status: 'pass', detail: '' }], remainingIssues: [] },
  ui_design_review: { summary: '調査完了', concept: '高密度ワークベンチ', changedFiles: [], artifacts: [], tests: [], findings: ['結果優先'], remainingIssues: [], revisionRecommended: false },
  ui_design_build: { summary: '初版完了', concept: '高密度ワークベンチ', changedFiles: ['components/trigger-discovery/design-lab/view.tsx'], artifacts: [], tests: [], findings: [], remainingIssues: [], revisionRecommended: false },
  ui_revision: { summary: '修正完了', concept: '高密度ワークベンチ', changedFiles: ['components/trigger-discovery/design-lab/view.tsx'], artifacts: [], tests: [], findings: [], remainingIssues: [], revisionRecommended: false },
  ui_final_qa: { summary: 'QA完了', concept: '高密度ワークベンチ', changedFiles: [], artifacts: [], tests: [], findings: [], remainingIssues: [], revisionRecommended: false },
} as const

const validInputs: Record<ClaudeTaskId, Record<string, unknown>> = {
  market_narrative: { reportDate: '2026-10-02', market: { advances: 1 } },
  page_review: { page: 'Page 06 content', context: 'A4 landscape' },
  copy_edit: { text: '校正対象です。' },
  design_review: { page: 'Page 06 visual description' },
  final_review: { document: 'Final document content' },
  page_design_build: { project: 'page06', request: '表を読みやすくする' },
  ui_design_review: { project: UI_DESIGN_PROJECT_ID, request: '現在画面を調査する' },
  ui_design_build: { project: UI_DESIGN_PROJECT_ID, request: 'Design Labを実装する' },
  ui_revision: { project: UI_DESIGN_PROJECT_ID, request: 'QA指摘を修正する', previousOutputDir: `${UI_DESIGN_OUTPUT_ROOT}/runs/fixture-build` },
  ui_final_qa: { project: UI_DESIGN_PROJECT_ID, request: '完成版を確認する', previousOutputDir: `${UI_DESIGN_OUTPUT_ROOT}/runs/fixture-build` },
}

function adapterSuccess(output: unknown, capture?: ClaudeCodeRequest[]): (request: ClaudeCodeRequest) => Promise<ClaudeCodeResult> {
  return async (request) => {
    capture?.push(request)
    return { ok: true, text: JSON.stringify(output), structuredOutput: output, provider: CLAUDE_CODE_PROVIDER, model: 'claude-sonnet-5-5', durationMs: 7 }
  }
}

async function unitTests() {
  assert.deepEqual(Object.keys(CLAUDE_TASK_PROFILES), [...CLAUDE_TASK_IDS])
  for (const id of CLAUDE_TASK_IDS) {
    const profile = getClaudeTaskProfile(id)
    assert.ok(profile, id)
    assert.equal(profile.id, id)
    assert.equal(profile.model, 'sonnet')
    assert.ok(profile.systemPrompt.length > 20)
    assert.ok(profile.timeoutMs > 0)
    assert.ok(profile.maxInputBytes > 0)
  }
  assert.equal(getClaudeTaskProfile('arbitrary_prompt'), null)

  const unknown = await dispatchClaudeCode({ task: 'arbitrary_prompt', input: {} })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.errorCode, 'UNKNOWN_TASK')

  for (const id of CLAUDE_TASK_IDS) {
    const captured: ClaudeCodeRequest[] = []
    const result = await dispatchClaudeCode({ task: id, input: validInputs[id] }, {
      runAdapter: adapterSuccess(validOutputs[id], captured),
      runDesignBuild: async () => ({ ok: true, text: '', structuredOutput: validOutputs.page_design_build, provider: CLAUDE_CODE_PROVIDER, model: 'claude-sonnet-5-5', durationMs: 7 }),
      runUiDesign: async (request) => ({ ok: true, text: '', structuredOutput: validOutputs[id as keyof typeof validOutputs], provider: CLAUDE_CODE_PROVIDER, model: 'claude-sonnet-5-5', durationMs: request.mode.length }),
    })
    assert.equal(result.ok, true, id)
    if (!result.ok) continue
    assert.equal(result.task, id)
    assert.equal(result.provider, CLAUDE_CODE_PROVIDER)
    assert.deepEqual(result.data, validOutputs[id])
    if (id === 'page_design_build' || id.startsWith('ui_')) {
      assert.equal(captured.length, 0)
    } else {
      assert.equal(captured.length, 1)
      assert.equal(captured[0].model, 'sonnet')
      assert.ok(captured[0].jsonSchema)
      assert.ok(!captured[0].prompt.includes('--model'))
    }
  }

  const invalidInputs: Array<[ClaudeTaskId, unknown]> = [
    ['market_narrative', null], ['page_review', {}], ['copy_edit', { text: '' }], ['design_review', { page: 1 }], ['final_review', { document: '' }], ['page_design_build', { project: 'other', request: 'x' }],
    ['ui_design_review', { project: 'other', request: 'x' }], ['ui_design_build', { project: UI_DESIGN_PROJECT_ID, request: '' }],
    ['ui_revision', { project: UI_DESIGN_PROJECT_ID, request: 'x' }], ['ui_final_qa', { project: UI_DESIGN_PROJECT_ID, request: 'x' }],
  ]
  for (const [task, input] of invalidInputs) {
    const result = await dispatchClaudeCode({ task, input }, { runAdapter: async () => { throw new Error('must not run') } })
    assert.equal(result.ok ? null : result.errorCode, 'INVALID_INPUT', task)
  }

  const tooLarge = await dispatchClaudeCode({ task: 'copy_edit', input: { text: 'x'.repeat(60_001) } }, { runAdapter: adapterSuccess(validOutputs.copy_edit) })
  assert.equal(tooLarge.ok ? null : tooLarge.errorCode, 'INPUT_TOO_LARGE')

  for (const errorCode of ['AUTH_EXPIRED', 'NOT_SUBSCRIPTION', 'PROVIDER_MISMATCH'] as const) {
    const result = await dispatchClaudeCode({ task: 'page_review', input: validInputs.page_review }, {
      runAdapter: async () => ({ ok: false, errorCode, errorMessage: `failure ${errorCode}` }),
    })
    assert.equal(result.ok ? null : result.errorCode, errorCode)
  }

  const invalidOutput = await dispatchClaudeCode({ task: 'page_review', input: validInputs.page_review }, { runAdapter: adapterSuccess({ summary: 'x' }) })
  assert.equal(invalidOutput.ok ? null : invalidOutput.errorCode, 'INVALID_OUTPUT')

  const threw = await dispatchClaudeCode({ task: 'page_review', input: validInputs.page_review }, { runAdapter: async () => { throw new Error('boom') } })
  assert.equal(threw.ok ? null : threw.errorCode, 'ADAPTER_THREW')

  const secret = `${['sk', 'ant', 'api03'].join('-')}-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`
  const redacted = await dispatchClaudeCode({ task: 'page_review', input: validInputs.page_review }, {
    runAdapter: async () => ({ ok: false, errorCode: 'CLI_ERROR', errorMessage: `provider ${secret}` }),
  })
  assert.ok(!JSON.stringify(redacted).includes(secret))

  const designRequest: ClaudeDesignBuildRequest = { instruction: '表を大きくする', model: 'sonnet', timeoutMs: 1, systemPrompt: 'system', jsonSchema: {} }
  const outputDir = '/Users/yoshio/Documents/ChatGPT/MAIL-REPORT-2-QA/page06-design-lab-build/runs/test-run'
  const designArgs = buildDesignBuildArgs(designRequest, outputDir)
  for (const flag of ['--restricted', '--safe-mode', '--no-session-persistence', '--no-chrome', '--strict-mcp-config']) assert.ok(designArgs.includes(flag), flag)
  assert.equal(designArgs[designArgs.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(designArgs[designArgs.indexOf('--permission-prompts') + 1], 'none')
  const allowed = designArgs[designArgs.indexOf('--allowedTools') + 1]
  for (const required of [PAGE06_COMPONENT_DIR, PAGE06_RENDERER_FILE, PAGE06_SNAPSHOT_FILE, outputDir]) assert.ok(allowed.includes(required), required)
  for (const forbidden of ['git commit', 'git push', 'npm run web:deploy']) assert.ok(!allowed.includes(forbidden), forbidden)
  const commands = designBuildCommands(outputDir)
  assert.ok(allowed.includes(commands.test))
  assert.ok(allowed.includes(commands.typecheck))
  assert.ok(allowed.includes(commands.render))
  assert.equal(isPage06EditablePath('components/reports/design-lab/page06/styles.ts'), true)
  assert.equal(isPage06EditablePath('scripts/lib/design-lab-page06-render.ts'), true)
  assert.equal(isPage06EditablePath('app/page.tsx'), false)
  assert.deepEqual(changedSourceFiles(new Map([['a', '1'], ['b', '1']]), new Map([['a', '2'], ['b', '1'], ['c', '1']])), ['a', 'c'])

  const uiRequest: ClaudeUiDesignRequest = {
    mode: 'build', project: UI_DESIGN_PROJECT_ID, instruction: '改善する', model: 'sonnet', timeoutMs: 1,
    systemPrompt: 'system', jsonSchema: {},
  }
  const uiOutputDir = `${UI_DESIGN_OUTPUT_ROOT}/runs/test-build`
  const uiArgs = buildUiDesignArgs(uiRequest, uiOutputDir)
  for (const flag of ['--restricted', '--safe-mode', '--no-session-persistence', '--no-chrome', '--strict-mcp-config']) assert.ok(uiArgs.includes(flag), flag)
  assert.equal(uiArgs[uiArgs.indexOf('--permission-mode') + 1], 'acceptEdits')
  const uiAllowed = uiArgs[uiArgs.indexOf('--allowedTools') + 1]
  assert.ok(uiAllowed.includes(UI_DESIGN_WORKTREE))
  assert.ok(uiAllowed.includes(uiOutputDir))
  for (const forbidden of ['git commit', 'git push', 'npm run web:deploy']) assert.ok(!uiAllowed.includes(forbidden), forbidden)
  const uiCommands = uiDesignCommands(uiOutputDir)
  assert.ok(uiAllowed.includes(uiCommands.test))
  assert.ok(uiAllowed.includes(uiCommands.typecheck))
  assert.ok(uiAllowed.includes(uiCommands.render))
  assert.equal(isUiDesignEditablePath('components/trigger-discovery/design-lab/view.tsx'), true)
  assert.equal(isUiDesignEditablePath('app/ui-design-lab/trigger-discovery/page.tsx'), false)
  assert.equal(isUiDesignEditablePath('app/trigger-discovery/TriggerDiscoveryClient.tsx'), false)
  assert.equal(isUiDesignEditablePath('app/api/trigger-discovery/search/route.ts'), false)
  assert.deepEqual(changedUiSourceFiles(new Map([['a', '1']]), new Map([['a', '2'], ['b', '1']])), ['a', 'b'])

  // stdin CLI: unknown task は adapter/Claude を呼ばず、stdout は単一 JSON のみ。
  const tsx = path.resolve('node_modules/.bin/tsx')
  const cli = spawnSync(tsx, ['scripts/claude-dispatch.ts'], {
    cwd: process.cwd(), shell: false, encoding: 'utf8', input: JSON.stringify({ task: 'unknown', input: {} }),
  })
  assert.equal(cli.status, 1)
  assert.equal(cli.stderr, '')
  const cliResult = JSON.parse(cli.stdout.trim()) as { ok: boolean; errorCode: string }
  assert.equal(cliResult.ok, false)
  assert.equal(cliResult.errorCode, 'UNKNOWN_TASK')
  assert.equal(cli.stdout.trim().split('\n').length, 1)

  console.log('claude code dispatcher unit tests passed')
}

async function liveTest() {
  const result = await dispatchClaudeCode({
    task: 'page_review',
    input: { page: '見出し: 日次レポート\n本文: 騰落銘柄数を簡潔に表示。', context: 'read-only subscription smoke test' },
  })
  assert.equal(result.ok, true, result.ok ? '' : `${result.errorCode}: ${result.errorMessage}`)
  if (!result.ok) return
  assert.equal(result.provider, CLAUDE_CODE_PROVIDER)
  console.log(JSON.stringify({ live: 'PASS', task: result.task, provider: result.provider, model: result.model, durationMs: result.durationMs }))
}

unitTests()
  .then(() => process.env.CLAUDE_DISPATCH_LIVE === '1' ? liveTest() : undefined)
  .catch((error) => { console.error(error); process.exitCode = 1 })
