import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Page06MomentumMatrix } from '@/components/reports/design-lab/page06/Page06MomentumMatrix'
import type { ClassificationMomentum, PeriodMetric } from '@/lib/daily-close-report'
import { buildMomentumMatrix, classifyMomentumState, isMeanDriven } from '@/lib/daily-close-momentum-matrix'
import {
  PAGE06_HEADLINE_MAX,
  PAGE06_LINE_MAX,
  buildPage06ClaudeInput,
  deterministicPage06Narrative,
  validatePage06Narrative,
} from '@/lib/daily-close-page06-narrative-content'
import { CLAUDE_CODE_PROVIDER, type ClaudeCodeResult } from '@/lib/server/claude-code-adapter'
import { buildPage06Prompt, generatePage06Narrative } from '@/lib/server/daily-close-page06-narrative'

// Page 06 Design Lab (Momentum Matrix) test。実 CLI・DB は使わない。

function metric(meanReturn: number | null, overrides: Partial<PeriodMetric> = {}): PeriodMetric {
  return { meanReturn, medianReturn: meanReturn, winnerCount: 6, loserCount: 4, eligibleCount: 10, totalCount: 10, winRate: 0.6, coverageRatio: 1, lowSample: false, ...overrides }
}

function row(name: string, rank1M: number | null, rank1W: number | null, oneWeek: PeriodMetric = metric(1), oneMonth: PeriodMetric = metric(2)): ClassificationMomentum {
  return {
    name, oneWeek, twoWeek: metric(1), oneMonth, rank1W, rank2W: rank1W, rank1M,
    rankChange1MTo1W: rank1M != null && rank1W != null ? rank1M - rank1W : null,
  }
}

function stateTests() {
  // 境界値 (Phase 1 しきい値: 15 / 30 / 45 / Shift 15)
  assert.equal(classifyMomentumState(15, 15), 'LEADER')
  assert.equal(classifyMomentumState(16, 15), 'NEUTRAL')
  assert.equal(classifyMomentumState(31, 15), 'EMERGING')
  assert.equal(classifyMomentumState(30, 15), 'NEUTRAL')
  assert.equal(classifyMomentumState(31, 16), 'NEUTRAL')
  assert.equal(classifyMomentumState(15, 31), 'FADING')
  assert.equal(classifyMomentumState(15, 30), 'NEUTRAL')
  assert.equal(classifyMomentumState(46, 31), 'RECOVERING')
  assert.equal(classifyMomentumState(46, 32), 'NEUTRAL')
  assert.equal(classifyMomentumState(45, 20), 'NEUTRAL')
  assert.equal(classifyMomentumState(60, 10), 'EMERGING')
  assert.equal(classifyMomentumState(null, 1), 'NEUTRAL')

  assert.equal(isMeanDriven(metric(2, { medianReturn: -0.1 })), true)
  assert.equal(isMeanDriven(metric(2, { medianReturn: 0 })), true)
  assert.equal(isMeanDriven(metric(2, { winRate: 0.49 })), true)
  assert.equal(isMeanDriven(metric(2, { medianReturn: 1, winRate: 0.5 })), false)
  assert.equal(isMeanDriven(metric(-1, { medianReturn: -2, winRate: 0.1 })), false)
  assert.equal(isMeanDriven(metric(null)), false)
}

function fixture(): ClassificationMomentum[] {
  return [
    row('上位A', 1, 2), row('上位B', 3, 1), row('上位C', 5, 9), row('上位D', 10, 12),
    row('浮上A', 50, 3, metric(4.12, { medianReturn: 3.81, winRate: 0.714 })), row('浮上B', 40, 10), row('浮上C', 33, 14),
    row('浮上LOW', 58, 1, metric(9, { lowSample: true, eligibleCount: 3, totalCount: 3 })),
    row('失速A', 2, 55, metric(-3.3)), row('失速B', 8, 40, metric(1.5, { medianReturn: -0.2 })),
    row('改善A', 59, 40), row('改善B', 52, 33),
    row('中立A', 25, 25), row('中立B', 20, 22), row('欠損', null, 5),
  ]
}

function modelTests() {
  const model = buildMomentumMatrix({ reportDate: '2026-10-02', classifications60: fixture() })
  assert.equal(model.points.length, 15)
  assert.deepEqual(model.counts, { LEADER: 4, EMERGING: 4, FADING: 2, RECOVERING: 2, NEUTRAL: 3 })
  assert.equal(model.lowSampleCount, 1)
  assert.deepEqual(model.lowSampleNames, ['浮上LOW'])

  // 並び順と上限 3 件、LOW SAMPLE は候補外
  assert.deepEqual(model.lists.LEADER.map((point) => point.name), ['上位B', '上位A', '上位C'])
  assert.deepEqual(model.lists.EMERGING.map((point) => point.name), ['浮上A', '浮上B', '浮上C'])
  assert.deepEqual(model.lists.FADING.map((point) => point.name), ['失速A', '失速B'])
  assert.deepEqual(model.lists.RECOVERING.map((point) => point.name), ['改善A', '改善B'])
  assert.deepEqual(model.spotlight.map((point) => point.name), ['浮上A', '失速A', '改善A', '上位B'])
  assert.equal(model.points.find((point) => point.name === '浮上LOW')?.labeled, false)
  assert.equal(model.points.find((point) => point.name === '失速B')?.meanDriven, true)

  // Claude 入力: LOW SAMPLE 名は含めない、件数のみ
  const input = buildPage06ClaudeInput(model)
  const prompt = buildPage06Prompt(input)
  assert.ok(!prompt.includes('浮上LOW'))
  assert.equal(input.stateCounts.lowSample, 1)
  assert.deepEqual(input.featured[0], {
    state: '急浮上', name: '浮上A', rank1M: 50, rank1W: 3, momentumShift: 47,
    oneWeek: { meanPct: 4.1, medianPct: 3.8, winRatePct: 71 }, oneMonth: { meanPct: 2 }, meanDriven: false,
  })
  assert.ok(!/加速度ではない/.test(JSON.stringify(input.featured)))
  return { model, input }
}

function validationTests(model: ReturnType<typeof modelTests>['model'], input: ReturnType<typeof modelTests>['input']) {
  const names = model.points.map((point) => point.name)
  const good = { headline: '急浮上4・高位失速2分類', fact: '浮上Aは1M#50から1W#3へ47位上昇、1W平均4.1%、勝率71%。', interpretation: '順位を上げた分類が失速分類より多い。', caveat: '順位は平均リターン基準。LOW SAMPLE 1分類は対象外。' }
  assert.equal(validatePage06Narrative(good, input, names).ok, true)

  const reject = (value: unknown, reason: string) => {
    const result = validatePage06Narrative(value, input, names)
    assert.equal(result.ok, false, reason)
    if (!result.ok) assert.ok(result.reason.startsWith(reason), `${reason} != ${result.reason}`)
  }
  reject(null, 'not_object')
  reject({ ...good, extra: 'x' }, 'extra_keys')
  reject({ ...good, fact: 1 }, 'fact_not_string')
  reject({ ...good, headline: '  ' }, 'headline_empty')
  reject({ ...good, headline: 'あ'.repeat(PAGE06_HEADLINE_MAX + 1) }, 'headline_too_long')
  reject({ ...good, caveat: 'あ'.repeat(PAGE06_LINE_MAX + 1) }, 'caveat_too_long')
  reject({ ...good, fact: 'a\nb' }, 'fact_control_chars')
  reject({ ...good, interpretation: '浮上Aは買い場。' }, 'interpretation_forbidden_word')
  reject({ ...good, fact: '浮上Aは1W平均12.3%。' }, 'number_not_in_input')
  reject({ ...good, fact: '浮上LOWが急浮上。' }, 'non_featured_classification')
  reject({ ...good, fact: '上位Cが上位維持。' }, 'non_featured_classification')
}

function fallbackTests(model: ReturnType<typeof modelTests>['model']) {
  const narrative = deterministicPage06Narrative(model)
  assert.equal(narrative.headline, '急浮上4・高位失速2分類、浮上Aが47位上昇')
  assert.equal(narrative.fact, '上位維持4・急浮上4・高位失速2・下位改善2分類。注目首位は浮上A（1M#50→1W#3、1W平均+4.1%）。')
  assert.equal(narrative.interpretation, '1M下位からの順位上昇（6分類）が高位からの失速（2分類）を上回る。')
  assert.equal(narrative.caveat, '順位は平均リターン基準で、リターンの加速度ではない。LOW SAMPLE 1分類は注目対象外。')
  for (const [key, text] of Object.entries(narrative)) assert.ok(text.length <= (key === 'headline' ? PAGE06_HEADLINE_MAX : PAGE06_LINE_MAX), key)

  const quiet = buildMomentumMatrix({ reportDate: '2026-10-02', classifications60: [row('上位A', 1, 1), row('中立A', 25, 25), row('中立B', 30, 28)] })
  const quietNarrative = deterministicPage06Narrative(quiet)
  assert.equal(quietNarrative.headline, '上位維持1分類、大きな順位変化は限定的')
  assert.equal(quietNarrative.interpretation, '1M下位からの順位上昇（0分類）は高位からの失速（0分類）と拮抗。')

  const meanDriven = buildMomentumMatrix({ reportDate: '2026-10-02', classifications60: [row('失速M', 2, 50, metric(1, { medianReturn: -1 }))] })
  assert.match(deterministicPage06Narrative(meanDriven).caveat, /失速Mは平均主導/)
}

async function generateTests(model: ReturnType<typeof modelTests>['model']) {
  const ok = (structuredOutput: unknown): ClaudeCodeResult => ({ ok: true, text: '', structuredOutput, provider: CLAUDE_CODE_PROVIDER, model: 'claude-sonnet-5-5', durationMs: 5 })
  const good = { headline: '急浮上4分類', fact: '浮上Aは1W#3。', interpretation: '順位上昇が多い。', caveat: '順位は平均リターン基準。' }

  const claude = await generatePage06Narrative(model, { run: async () => ok(good) })
  assert.equal(claude.source, CLAUDE_CODE_PROVIDER)
  assert.deepEqual(claude.narrative, good)

  const invalid = await generatePage06Narrative(model, { run: async () => ok({ ...good, fact: '浮上Aは99位上昇。' }) })
  assert.equal(invalid.source, 'deterministic')
  if (invalid.source === 'deterministic') {
    assert.equal(invalid.fallbackReason, 'INVALID_OUTPUT')
    assert.equal(invalid.fallbackDetail, 'number_not_in_input:99')
    assert.deepEqual(invalid.narrative, deterministicPage06Narrative(model))
  }
  const failed = await generatePage06Narrative(model, { run: async () => ({ ok: false, errorCode: 'AUTH_EXPIRED', errorMessage: 'x' }) })
  assert.equal(failed.source === 'deterministic' ? failed.fallbackReason : null, 'AUTH_EXPIRED')
  const threw = await generatePage06Narrative(model, { run: async () => { throw new Error('boom') } })
  assert.equal(threw.source === 'deterministic' ? threw.fallbackReason : null, 'ADAPTER_THREW')
}

function renderTests(model: ReturnType<typeof modelTests>['model']) {
  const html = renderToStaticMarkup(createElement(Page06MomentumMatrix, {
    model, narrative: deterministicPage06Narrative(model), narrativeSource: { kind: 'deterministic', reason: null }, generatedAt: '2026/10/02 18:00:00',
  }))
  assert.match(html, /60分類 MOMENTUM MATRIX/)
  assert.ok(!/ACCELERATION|Acceleration/.test(html), 'page must not label rank change as acceleration')
  assert.match(html, /Momentum Shift = 1M順位 − 1W順位/)
  assert.match(html, /@page \{ size: A4 landscape/)
  assert.equal((html.match(/<circle /g) ?? []).length, 14, 'all ranked classifications are plotted (欠損 excluded)')
  assert.equal((html.match(/stroke-dasharray="2.2 1.6"/g) ?? []).length, 1, 'LOW SAMPLE is drawn dashed')
  assert.ok(!html.includes('pointLabel">浮上LOW'), 'LOW SAMPLE is not labeled')
  assert.match(html, /DESIGN LAB · 非Production/)
  assert.match(html, /width: 297mm; height: 210mm/, 'A4 landscape page size comes from layout constants')
}

async function main() {
  stateTests()
  const { model, input } = modelTests()
  validationTests(model, input)
  fallbackTests(model)
  await generateTests(model)
  renderTests(model)
  console.log('daily close momentum matrix tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
