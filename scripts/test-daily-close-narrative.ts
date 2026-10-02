import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  DAILY_CLOSE_REPORT_TYPE,
  DAILY_CLOSE_REPORT_VERSION,
  type DailyCloseReport,
  type PeriodMetric,
  type StageSet,
  type WatchlistReportRow,
} from '@/lib/daily-close-report'
import {
  CLAUDE_CODE_PROVIDER,
  createClaudeCodeAdapter,
  type ClaudeCodeErrorCode,
  type ClaudeCodeRequest,
  type ClaudeCodeResult,
  type SpawnFn,
} from '@/lib/server/claude-code-adapter'
import {
  NARRATIVE_HEADLINE_MAX,
  NARRATIVE_PARAGRAPH_MAX,
  NARRATIVE_PARAGRAPHS_MAX,
  buildNarrativeInput,
  buildNarrativePrompt,
  deterministicNarrative,
  generateClaudeNarrative,
  validateNarrative,
} from '@/lib/server/daily-close-narrative'

// Daily close narrative test。実 CLI・DB は使わない。

const stages: StageSet = { dayA: 2, dayB: 1, weekA: 3, weekB: 2, monthA: 1, monthB: 1 }

function metric(meanReturn: number | null): PeriodMetric {
  return { meanReturn, medianReturn: meanReturn, winnerCount: 3, loserCount: 2, eligibleCount: 5, totalCount: 5, winRate: 0.6, coverageRatio: 1, lowSample: false }
}

function makeReport(): DailyCloseReport {
  const watchRow = {
    ticker: 'WATCH9999', name: 'ウォッチ銘柄', price: 1000, dailyReturn: 1.5, volumeRatio: 2, turnoverRatio: 1, tradingValue: 1e9,
    sector33: '機械', classification60: '分類01', stages, previousStages: stages,
    status: 'NEAR', score: 70, previousScore: 60, zoneDistancePct: 1, previousZoneDistancePct: 2, averageTradingValue: 1e9,
    changeReasons: ['Score 60→70'], sparkline: [1, 2, 3],
  } as WatchlistReportRow
  return {
    version: DAILY_CLOSE_REPORT_VERSION,
    reportType: DAILY_CLOSE_REPORT_TYPE,
    reportDate: '2026-09-30',
    requestedDate: null,
    priceDate: '2026-09-30',
    derivedDate: '2026-09-30',
    generatedAt: '2026-09-30T09:00:00.000Z',
    generationMs: 12.3,
    current: true,
    dataStatus: {
      jpPrice: { date: '2026-09-30', status: 'CURRENT' },
      jpDerived: { date: '2026-09-30', status: 'CURRENT' },
      trigger: { date: '2026-09-30', status: 'CURRENT' },
      largeHolder: { date: '2026-09-29', status: 'DELAYED' },
    },
    executive: { keyPoints: [], kpis: [] },
    market: {
      indices: [{ code: 'TOPIX', label: 'TOPIX', value: 2800.123, changePct: 0.456 }],
      advances: 1200, declines: 300, unchanged: 100, tradingValue: 4.5e12, newHighs: 40, newLows: 5,
      stageDistribution: [{ stage: 2, count: 500 }],
    },
    sectors33: ['機械', '電気機器', '化学', '銀行業', '小売業'].map((name, index) => ({
      name, return1D: 2 - index, return5D: 3 - index, currentRank: index + 1, previousRank: index + 2, rankChange: 1, eligibleCount: 10, totalCount: 10,
    })),
    classifications60: Array.from({ length: 8 }, (_, index) => ({
      name: `分類${index + 1}`, oneWeek: metric(index - 3), twoWeek: metric(index - 4), oneMonth: metric(index - 5),
      rank1W: index + 1, rank2W: index + 1, rank1M: index + 1, rankChange1MTo1W: 0,
    })),
    watchlist: { source: 'BROWSER_LOCAL_STORAGE', total: 2, changed: [watchRow] },
    trigger: {
      available: true, candidateCount: 12, definitionName: 'MA接近', evaluationDate: '2026-09-30', previousEvaluationDate: '2026-09-29',
      currentCounts: { NEW: 3, RE_ENTRY: 1, NEAR: 5, IN_ZONE: 3 }, previousCounts: { NEW: 2, RE_ENTRY: 0, NEAR: 4, IN_ZONE: 2 },
      newRows: [], reentryRows: [], nearRows: [], inZoneRows: [],
    },
    setups: { stageImproving: [], maApproaching: [], priceRangeHit: [] },
    unusual: { volumeSpike: [], turnoverSpike: [], priceMove: [], triggerScoreMove: [] },
    events: { largeHolder: { status: 'DELAYED', priceDate: '2026-09-29', events: [] }, earnings: [] },
    takeaways: {
      1: { headline: 'TAKEAWAY_MARKER_ONE', detail: ['DETAIL_MARKER_A', 'DETAIL_MARKER_B'] },
      2: { headline: 'TAKEAWAY_MARKER_TWO', detail: [] },
      11: { headline: 'TAKEAWAY_MARKER_ELEVEN', detail: ['DETAIL_MARKER_C'] },
    },
    sources: ['ohlcv_daily'],
    limitations: [],
  }
}

function validationTests() {
  const valid = validateNarrative({ headline: '  見出し  ', paragraphs: [' 段落1 ', '段落2'] })
  assert.deepEqual(valid, { ok: true, narrative: { headline: '見出し', paragraphs: ['段落1', '段落2'] } })

  const rejects: Array<[unknown, string]> = [
    [null, 'not_object'],
    ['text', 'not_object'],
    [['headline'], 'not_object'],
    [{ headline: 'h', paragraphs: ['p'], extra: 1 }, 'extra_keys:extra'],
    [{ headline: 1, paragraphs: ['p'] }, 'headline_not_string'],
    [{ paragraphs: ['p'] }, 'headline_not_string'],
    [{ headline: '   ', paragraphs: ['p'] }, 'headline_empty'],
    [{ headline: 'あ'.repeat(NARRATIVE_HEADLINE_MAX + 1), paragraphs: ['p'] }, 'headline_too_long'],
    [{ headline: 'a\nb', paragraphs: ['p'] }, 'headline_control_chars'],
    [{ headline: 'h', paragraphs: 'p' }, 'paragraphs_not_array'],
    [{ headline: 'h' }, 'paragraphs_not_array'],
    [{ headline: 'h', paragraphs: [] }, 'paragraphs_empty'],
    [{ headline: 'h', paragraphs: Array(NARRATIVE_PARAGRAPHS_MAX + 1).fill('p') }, 'paragraphs_too_many'],
    [{ headline: 'h', paragraphs: [1] }, 'paragraph_not_string'],
    [{ headline: 'h', paragraphs: ['  '] }, 'paragraph_empty'],
    [{ headline: 'h', paragraphs: ['あ'.repeat(NARRATIVE_PARAGRAPH_MAX + 1)] }, 'paragraph_too_long'],
    [{ headline: 'h', paragraphs: ['a\u0000b'] }, 'paragraph_control_chars'],
  ]
  for (const [value, reason] of rejects) assert.deepEqual(validateNarrative(value), { ok: false, reason }, reason)
  assert.equal(validateNarrative({ headline: 'あ'.repeat(NARRATIVE_HEADLINE_MAX), paragraphs: ['あ'.repeat(NARRATIVE_PARAGRAPH_MAX)] }).ok, true)
}

function inputTests() {
  const report = makeReport()
  const input = buildNarrativeInput(report)
  const prompt = buildNarrativePrompt(report)

  // 比較汚染防止: deterministic takeaways は Claude input に含めない
  assert.ok(!('deterministicTakeaways' in input))
  assert.ok(!('takeaways' in input))
  for (const marker of ['TAKEAWAY_MARKER', 'DETAIL_MARKER']) assert.ok(!prompt.includes(marker), marker)
  // 銘柄単位の明細は渡さない
  assert.ok(!prompt.includes('WATCH9999'))
  assert.deepEqual(input.watchlist, { total: 2, changedCount: 1 })

  assert.equal(input.reportDate, '2026-09-30')
  assert.equal(input.dataStatus.largeHolder, 'DELAYED')
  assert.deepEqual(input.market.indices, [{ label: 'TOPIX', value: 2800.12, changePct: 0.46, note: null }])
  assert.deepEqual(input.sectors33.top.map((row) => row.name), ['機械', '電気機器', '化学'])
  assert.deepEqual(input.sectors33.bottom.map((row) => row.name), ['化学', '銀行業', '小売業'])
  assert.deepEqual(input.classifications60OneWeek.top.map((row) => row.name), ['分類8', '分類7', '分類6'])
  assert.deepEqual(input.classifications60OneWeek.bottom.map((row) => row.name), ['分類3', '分類2', '分類1'])
  assert.equal(input.trigger.candidateCount, 12)
  assert.match(prompt, /^[\s\S]*<data>\n\{[\s\S]*\}\n<\/data>$/)
}

function deterministicTests() {
  const report = makeReport()
  const narrative = deterministicNarrative(report, 'TIMEOUT')
  assert.equal(narrative.source, 'deterministic')
  if (narrative.source !== 'deterministic') return
  assert.equal(narrative.fallbackReason, 'TIMEOUT')
  assert.equal(narrative.takeaways, report.takeaways)
  assert.equal(narrative.headline, 'TAKEAWAY_MARKER_ONE')
  assert.deepEqual(narrative.paragraphs, [
    'TAKEAWAY_MARKER_ONE（DETAIL_MARKER_A / DETAIL_MARKER_B）',
    'TAKEAWAY_MARKER_TWO',
    'TAKEAWAY_MARKER_ELEVEN（DETAIL_MARKER_C）',
  ])
}

async function expectDeterministic(run: (request: ClaudeCodeRequest) => Promise<ClaudeCodeResult>, reason: string, timeoutMs?: number) {
  const report = makeReport()
  const snapshot = structuredClone(report)
  const narrative = await generateClaudeNarrative(report, { run, timeoutMs })
  assert.equal(narrative.source, 'deterministic', reason)
  if (narrative.source !== 'deterministic') return
  assert.equal(narrative.fallbackReason, reason)
  assert.equal(narrative.takeaways, report.takeaways)
  assert.deepEqual(report, snapshot, `${reason}: report must not be mutated`)
}

async function generateTests() {
  // Claude 成功
  {
    const report = makeReport()
    const snapshot = structuredClone(report)
    const captured: ClaudeCodeRequest[] = []
    const narrative = await generateClaudeNarrative(report, {
      run: async (request) => {
        captured.push(request)
        return { ok: true, text: '', structuredOutput: { headline: ' 見出し ', paragraphs: ['段落'] }, provider: CLAUDE_CODE_PROVIDER, model: 'claude-sonnet-5-5', durationMs: 5 }
      },
    })
    assert.deepEqual(narrative, { source: CLAUDE_CODE_PROVIDER, model: 'claude-sonnet-5-5', durationMs: 5, headline: '見出し', paragraphs: ['段落'] })
    assert.equal(captured.length, 1)
    assert.ok(captured[0].jsonSchema)
    assert.ok(!captured[0].prompt.includes('TAKEAWAY_MARKER'))
    assert.deepEqual(report, snapshot)
  }

  // adapter 失敗 → deterministic fallback
  const codes: ClaudeCodeErrorCode[] = ['CLI_NOT_FOUND', 'AUTH_EXPIRED', 'NOT_SUBSCRIPTION', 'TIMEOUT', 'NON_ZERO_EXIT', 'INVALID_JSON', 'CLI_ERROR', 'PROVIDER_MISMATCH', 'STRUCTURED_OUTPUT_MISSING']
  for (const errorCode of codes) await expectDeterministic(async () => ({ ok: false, errorCode, errorMessage: 'x' }), errorCode)
  await expectDeterministic(async () => { throw new Error('boom') }, 'ADAPTER_THREW')
  await expectDeterministic(async () => ({ ok: true, text: '', structuredOutput: { headline: '', paragraphs: [] }, provider: CLAUDE_CODE_PROVIDER, model: null, durationMs: 1 }), 'INVALID_OUTPUT')
  await expectDeterministic(async () => ({ ok: true, text: '', structuredOutput: { headline: 'h', paragraphs: ['p'], extra: true }, provider: CLAUDE_CODE_PROVIDER, model: null, durationMs: 1 }), 'INVALID_OUTPUT')
}

function hangingOrAuthSpawn(authStatus: Record<string, unknown> | null): SpawnFn {
  return (_command, args) => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), exitCode: null, kill: () => true })
    setImmediate(() => {
      if (args[0] !== 'auth' || !authStatus) return // 推論はハングさせる
      stdout.end(JSON.stringify(authStatus))
      setImmediate(() => child.emit('close', 0, null))
    })
    return child as unknown as ChildProcess
  }
}

async function unavailableTests() {
  // CLI 不存在 (実 spawn だが存在しないパスなので CLI は起動しない)
  await expectDeterministic(createClaudeCodeAdapter({ cliPath: '/nonexistent/stockboard-test/claude' }).run, 'CLI_NOT_FOUND')
  // subscription 以外の認証
  await expectDeterministic(createClaudeCodeAdapter({ spawn: hangingOrAuthSpawn({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', subscriptionType: null }) }).run, 'NOT_SUBSCRIPTION')
  // login 失効
  await expectDeterministic(createClaudeCodeAdapter({ spawn: hangingOrAuthSpawn({ loggedIn: false }) }).run, 'AUTH_EXPIRED')
  // 推論 timeout
  await expectDeterministic(createClaudeCodeAdapter({ spawn: hangingOrAuthSpawn({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }) }).run, 'TIMEOUT', 50)
}

async function main() {
  validationTests()
  inputTests()
  deterministicTests()
  await generateTests()
  await unavailableTests()
  console.log('daily close narrative tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
