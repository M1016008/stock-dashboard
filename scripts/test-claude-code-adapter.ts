import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import {
  CLAUDE_CLI_PATH,
  CLAUDE_CODE_PROVIDER,
  buildChildEnv,
  buildClaudeArgs,
  childSpawnOptions,
  createClaudeCodeAdapter,
  redactSecrets,
  type SpawnFn,
} from '@/lib/server/claude-code-adapter'
import { NARRATIVE_JSON_SCHEMA, NARRATIVE_SYSTEM_PROMPT, validateNarrative } from '@/lib/server/daily-close-narrative'

// Claude Code adapter unit test。偽 spawn を使い、実 CLI は呼ばない。
// CLAUDE_NARRATIVE_LIVE=1 の場合のみ、最後に実 CLI (subscription) で 1 回推論する。

type Reply = { stdout?: string; stderr?: string; code?: number; errorCode?: string; hang?: boolean }
type Call = { command: string; args: readonly string[]; options: SpawnOptions; stdin: string; killed: string[] }

const AUTH_OK = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'someone@example.com',
  orgId: '00000000-0000-0000-0000-000000000000',
  subscriptionType: 'pro',
})

const STRUCTURED = { headline: 'テスト見出し', paragraphs: ['段落1'] }

function inferencePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: JSON.stringify(STRUCTURED),
    structured_output: STRUCTURED,
    modelUsage: { 'claude-sonnet-5-5': { provider: 'firstParty', costBasis: 'list' } },
    ...overrides,
  })
}

function fakeSpawn(replies: { auth?: Reply; inference?: Reply }) {
  const calls: Call[] = []
  const spawn: SpawnFn = (command, args, options) => {
    const isAuth = args[0] === 'auth'
    const reply = (isAuth ? replies.auth : replies.inference) ?? { stdout: isAuth ? AUTH_OK : inferencePayload(), code: 0 }
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const call: Call = { command, args, options, stdin: '', killed: [] }
    calls.push(call)
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => { call.stdin += chunk })
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, stderr, exitCode: null as number | null,
      kill: (signal: string) => { call.killed.push(signal); return true },
    })
    setImmediate(() => {
      if (reply.errorCode) {
        child.emit('error', Object.assign(new Error(`spawn ${reply.errorCode}`), { code: reply.errorCode }))
        return
      }
      if (reply.hang) return
      if (reply.stdout) stdout.write(reply.stdout)
      if (reply.stderr) stderr.write(reply.stderr)
      stdout.end()
      stderr.end()
      child.exitCode = reply.code ?? 0
      setImmediate(() => child.emit('close', reply.code ?? 0, null))
    })
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

const fakeAnthropicKeyPrefix = ['sk', 'ant', 'api03'].join('-')
const fakeBearerToken = ['abc', 'def', 'ghi'].join('.')

const hostileEnv = {
  HOME: '/Users/test',
  USER: 'test',
  PATH: '/usr/bin:/bin',
  LANG: 'ja_JP.UTF-8',
  TMPDIR: '/tmp/test/',
  ANTHROPIC_API_KEY: `${fakeAnthropicKeyPrefix}-SHOULD-NOT-LEAK`,
  ANTHROPIC_AUTH_TOKEN: 'should-not-leak',
  ANTHROPIC_BASE_URL: 'https://example.invalid',
  CLAUDE_CODE_OAUTH_TOKEN: 'should-not-leak',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  OPENAI_API_KEY: 'sk-should-not-leak',
} as unknown as NodeJS.ProcessEnv

const request = { prompt: '<data>{"advances":1}</data>', systemPrompt: NARRATIVE_SYSTEM_PROMPT, jsonSchema: NARRATIVE_JSON_SCHEMA }

async function unitTests() {
  // env allowlist
  const env = buildChildEnv(hostileEnv)
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER'])
  for (const key of Object.keys(env)) assert.ok(!/ANTHROPIC|CLAUDE_CODE|OPENAI/.test(key))

  // spawn options: shell 無効・cwd は tmpdir 固定
  const options = childSpawnOptions(env)
  assert.equal(options.shell, false)
  assert.equal(options.cwd, os.tmpdir())

  // args: 合意済み flag 一式。prompt は args に含めない
  const args = buildClaudeArgs(request)
  const expectedPairs: Array<[string, string]> = [
    ['--model', 'sonnet'], ['--output-format', 'json'], ['--max-turns', '1'], ['--tools', ''],
    ['--disallowedTools', 'mcp__*'], ['--permission-prompts', 'none'], ['--system-prompt', NARRATIVE_SYSTEM_PROMPT],
    ['--json-schema', JSON.stringify(NARRATIVE_JSON_SCHEMA)],
  ]
  assert.equal(args[0], '-p')
  for (const [flag, value] of expectedPairs) assert.equal(args[args.indexOf(flag) + 1], value, flag)
  for (const flag of ['--no-session-persistence', '--safe-mode', '--no-chrome', '--disable-slash-commands', '--strict-mcp-config']) assert.ok(args.includes(flag), flag)
  for (const forbidden of ['--bare', '--restricted', '--dangerously-skip-permissions', '--api-key', '--settings']) assert.ok(!args.includes(forbidden), forbidden)
  assert.ok(!args.includes(request.prompt))
  assert.equal(buildClaudeArgs({ ...request, model: 'opus' })[args.indexOf('--model') + 1], 'opus')

  // 正常系
  {
    const fake = fakeSpawn({})
    const adapter = createClaudeCodeAdapter({ spawn: fake.spawn, env: hostileEnv })
    const result = await adapter.run(request)
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('unreachable')
    assert.equal(result.provider, CLAUDE_CODE_PROVIDER)
    assert.equal(result.model, 'claude-sonnet-5-5')
    assert.deepEqual(result.structuredOutput, STRUCTURED)
    assert.equal(fake.calls.length, 2)
    const [authCall, inferenceCall] = fake.calls
    assert.deepEqual(authCall.args, ['auth', 'status'])
    for (const call of fake.calls) {
      assert.equal(call.command, CLAUDE_CLI_PATH)
      assert.equal(call.options.shell, false)
      assert.equal(call.options.cwd, os.tmpdir())
      assert.deepEqual(Object.keys(call.options.env ?? {}).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER'])
    }
    assert.equal(inferenceCall.stdin, request.prompt)
    assert.ok(!JSON.stringify(result).includes('someone@example.com'))
  }

  // 認証キャッシュなし: 推論ごとに auth status を実行する
  {
    const fake = fakeSpawn({})
    const adapter = createClaudeCodeAdapter({ spawn: fake.spawn, env: hostileEnv })
    await adapter.run(request)
    await adapter.run(request)
    assert.deepEqual(fake.calls.map((call) => call.args[0]), ['auth', '-p', 'auth', '-p'])
  }

  const expectFailure = async (replies: { auth?: Reply; inference?: Reply }, errorCode: string, inferenceCalled: boolean, timeoutMs?: number) => {
    const fake = fakeSpawn(replies)
    const adapter = createClaudeCodeAdapter({ spawn: fake.spawn, env: hostileEnv })
    const result = await adapter.run({ ...request, timeoutMs })
    assert.equal(result.ok, false, errorCode)
    if (result.ok) throw new Error('unreachable')
    assert.equal(result.errorCode, errorCode)
    assert.equal(fake.calls.some((call) => call.args[0] === '-p'), inferenceCalled, `${errorCode} inference called`)
    return { result, fake }
  }

  // CLI 不存在
  await expectFailure({ auth: { errorCode: 'ENOENT' } }, 'CLI_NOT_FOUND', false)
  await expectFailure({ inference: { errorCode: 'ENOENT' } }, 'CLI_NOT_FOUND', true)
  await expectFailure({ auth: { errorCode: 'EACCES' } }, 'SPAWN_FAILED', false)

  // subscription guard: 条件を満たさない限り推論へ進まない
  const authReply = (overrides: Record<string, unknown>) => ({ stdout: JSON.stringify({ ...JSON.parse(AUTH_OK), ...overrides }), code: 0 })
  await expectFailure({ auth: authReply({ loggedIn: false }) }, 'AUTH_EXPIRED', false)
  await expectFailure({ auth: authReply({ authMethod: 'api_key' }) }, 'NOT_SUBSCRIPTION', false)
  await expectFailure({ auth: authReply({ authMethod: 'console' }) }, 'NOT_SUBSCRIPTION', false)
  await expectFailure({ auth: authReply({ apiProvider: 'bedrock' }) }, 'NOT_SUBSCRIPTION', false)
  await expectFailure({ auth: authReply({ apiProvider: 'vertex' }) }, 'NOT_SUBSCRIPTION', false)
  await expectFailure({ auth: authReply({ subscriptionType: '' }) }, 'NOT_SUBSCRIPTION', false)
  await expectFailure({ auth: authReply({ subscriptionType: null }) }, 'NOT_SUBSCRIPTION', false)
  await expectFailure({ auth: { stdout: 'Not logged in. Please run /login', code: 1 } }, 'AUTH_EXPIRED', false)
  await expectFailure({ auth: { stdout: 'garbage', code: 0 } }, 'INVALID_JSON', false)

  // 401 / login 失効
  await expectFailure({ inference: { stdout: inferencePayload({ is_error: true, api_error_status: 401, result: 'error' }), code: 1 } }, 'AUTH_EXPIRED', true)
  await expectFailure({ inference: { stdout: inferencePayload({ is_error: true, result: 'OAuth token has expired. Please run /login' }), code: 1 } }, 'AUTH_EXPIRED', true)
  await expectFailure({ inference: { stdout: '', stderr: 'Invalid API key · Please run /login', code: 1 } }, 'AUTH_EXPIRED', true)

  // timeout: SIGTERM で kill する
  {
    const { fake } = await expectFailure({ inference: { hang: true } }, 'TIMEOUT', true, 50)
    assert.deepEqual(fake.calls[1].killed, ['SIGTERM'])
  }

  // exit code / JSON / result 異常
  await expectFailure({ inference: { stdout: 'not json', code: 0 } }, 'INVALID_JSON', true)
  await expectFailure({ inference: { stdout: 'boom', code: 2 } }, 'NON_ZERO_EXIT', true)
  await expectFailure({ inference: { stdout: inferencePayload(), code: 3 } }, 'NON_ZERO_EXIT', true)
  await expectFailure({ inference: { stdout: inferencePayload({ is_error: true, subtype: 'error_max_turns' }), code: 0 } }, 'CLI_ERROR', true)

  // provider guard: firstParty 以外は拒否
  await expectFailure({ inference: { stdout: inferencePayload({ modelUsage: { 'claude-sonnet-5-5': { provider: 'bedrock' } } }), code: 0 } }, 'PROVIDER_MISMATCH', true)
  await expectFailure({ inference: { stdout: inferencePayload({ modelUsage: {} }), code: 0 } }, 'PROVIDER_MISMATCH', true)
  await expectFailure({ inference: { stdout: inferencePayload({ modelUsage: { a: { provider: 'firstParty' }, b: { provider: 'vertex' } } }), code: 0 } }, 'PROVIDER_MISMATCH', true)

  // structured output
  await expectFailure({ inference: { stdout: inferencePayload({ structured_output: undefined }), code: 0 } }, 'STRUCTURED_OUTPUT_MISSING', true)
  await expectFailure({ inference: { stdout: inferencePayload({ structured_output: ['x'] }), code: 0 } }, 'STRUCTURED_OUTPUT_MISSING', true)
  {
    const fake = fakeSpawn({ inference: { stdout: inferencePayload({ result: '' }), code: 0 } })
    const adapter = createClaudeCodeAdapter({ spawn: fake.spawn, env: hostileEnv })
    const result = await adapter.run({ prompt: 'x', systemPrompt: 'y' })
    assert.equal(result.ok ? null : result.errorCode, 'EMPTY_RESULT')
  }

  // 不正 request は spawn しない
  {
    const fake = fakeSpawn({})
    const adapter = createClaudeCodeAdapter({ spawn: fake.spawn, env: hostileEnv })
    assert.equal((await adapter.run({ ...request, prompt: '   ' })).ok, false)
    assert.equal((await adapter.run({ ...request, prompt: 'x'.repeat(100_001) })).ok, false)
    assert.equal(fake.calls.length, 0)
  }

  // secret redaction
  const secretText = `key ${fakeAnthropicKeyPrefix}-AAAAAAAAAAAAAAAAAAAA Bearer ${fakeBearerToken} access_token="tok123" someone@example.com ${'Z'.repeat(48)}`
  const redacted = redactSecrets(secretText)
  for (const secret of [fakeAnthropicKeyPrefix, fakeBearerToken, 'tok123', 'someone@example.com', 'Z'.repeat(48)]) assert.ok(!redacted.includes(secret), secret)
  {
    const { result } = await expectFailure({ auth: authReply({ authMethod: `${fakeAnthropicKeyPrefix}-LEAKLEAKLEAK` }) }, 'NOT_SUBSCRIPTION', false)
    if (!result.ok) assert.ok(!result.errorMessage.includes('LEAKLEAK'))
  }

  console.log('claude code adapter unit tests passed')
}

async function liveTest() {
  // 実 CLI 1 回。subscription 以外であれば adapter 側で拒否される。
  const adapter = createClaudeCodeAdapter()
  const auth = await adapter.checkSubscriptionAuth()
  assert.equal(auth.ok, true, auth.ok ? '' : `${auth.errorCode}: ${auth.errorMessage}`)
  const result = await adapter.run({
    prompt: '<data>{"reportDate":"2026-01-05","market":{"advances":1200,"declines":300,"unchanged":100}}</data>\nこの値だけで1段落のテスト用ナラティブを書いてください。',
    systemPrompt: NARRATIVE_SYSTEM_PROMPT,
    jsonSchema: NARRATIVE_JSON_SCHEMA,
  })
  assert.equal(result.ok, true, result.ok ? '' : `${result.errorCode}: ${result.errorMessage}`)
  if (!result.ok) return
  const validated = validateNarrative(result.structuredOutput)
  assert.equal(validated.ok, true, validated.ok ? '' : validated.reason)
  console.log(JSON.stringify({
    live: 'PASS',
    subscriptionType: auth.ok ? auth.subscriptionType : null,
    provider: result.provider,
    model: result.model,
    durationMs: result.durationMs,
    narrative: validated.ok ? validated.narrative : null,
  }, null, 2))
}

async function main() {
  await unitTests()
  if (process.env.CLAUDE_NARRATIVE_LIVE === '1') await liveTest()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
