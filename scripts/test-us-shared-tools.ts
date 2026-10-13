import assert from 'node:assert/strict'
import { explicitTickerFromText, fallbackPlan } from '@/lib/assistant/router'
import type { AssistantPageContext } from '@/lib/assistant/types'

const usContext: AssistantPageContext = {
  pathname: '/ai/research',
  search: 'market=US',
  ticker: null,
  market: 'US',
  universe: null,
}

assert.equal(explicitTickerFromText('米国株の物理ML上昇候補を10件見せて'), null)
assert.equal(explicitTickerFromText('PMSとPFSが強い米国株'), null)
assert.equal(explicitTickerFromText('BRK.Bの現在地を見て'), 'BRK.B')
assert.equal(explicitTickerFromText('BRK-Bに似た銘柄'), 'BRK-B')

const momentumPlan = fallbackPlan('米国株でPMSと6ステージが強い初動候補を探して', usContext)
assert.equal(momentumPlan.responseType, 'results')
assert.equal(momentumPlan.toolCalls[0]?.market, 'US')
assert.equal(momentumPlan.toolCalls[0]?.tool, 'screen_jp_stocks')
assert.equal(momentumPlan.toolCalls[0]?.ticker, undefined)

const jpOnlyFilterPlan = fallbackPlan('日経225の貸借銘柄から米国株の上昇候補を探して', usContext)
assert.equal(jpOnlyFilterPlan.toolCalls[0]?.market, 'US')
assert.equal(jpOnlyFilterPlan.toolCalls[0]?.universe, null)
assert.equal(jpOnlyFilterPlan.toolCalls[0]?.marginType, null)
assert.equal(jpOnlyFilterPlan.interpretedConditions?.includes('日経225'), false)
assert.equal(jpOnlyFilterPlan.interpretedConditions?.includes('貸借'), false)

const clarification = fallbackPlan('米国株で何か良さそうな銘柄はない？', usContext)
assert.equal(clarification.responseType, 'clarify')
assert.ok(clarification.clarificationQuestions?.some((question) => question.includes('SEC業種')))
assert.equal(clarification.clarificationQuestions?.some((question) => question.includes('日経225')), false)

console.log('US shared tools assistant routing tests passed')
