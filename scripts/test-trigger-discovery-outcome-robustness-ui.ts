import assert from 'node:assert/strict'
import fs from 'node:fs'

const segmentation = fs.readFileSync('components/trigger-discovery/OutcomeSegmentationPanel.tsx', 'utf8')
const robustness = fs.readFileSync('components/trigger-discovery/OutcomeRobustnessPanel.tsx', 'utf8')

assert.ok(segmentation.includes("type SegmentTab = 'score' | 'spread' | 'stage' | 'pair' | 'compare' | 'robustness'"))
assert.ok(segmentation.includes("{ value: 'robustness', label: '観測単位' }"))
assert.ok(segmentation.includes("tab === 'robustness'"), 'the new analysis must stay inside the existing segmentation tabs')
assert.ok(segmentation.includes('<OutcomeRobustnessPanel'), 'the robustness panel must be connected to the completed Outcome job')
assert.ok(segmentation.includes("tab === 'compare' || tab === 'robustness'"), 'existing segment fetching must not run behind the robustness tab')

for (const text of [
  '重複の影響',
  'Event単位',
  'Episode単位',
  '銘柄均等',
  'Observation Funnel',
  '重複集中度を見る',
  'tickerあたりEvent数 中央 / P90 / 最大',
  'tickerあたりEpisode数 中央 / P90 / 最大',
  '上位10銘柄Event占有率',
  'Horizon横断比較',
  'Eligible Event',
  'Eligible Episode',
  'Eligible銘柄',
  'そのHorizonの将来データが揃うEventをeligibleとして集計します。',
  '代表となるEventで、そのHorizonの将来データが揃うEpisodeをeligibleとして集計します。',
  'そのHorizonでeligibleなEpisodeが1件以上ある銘柄をeligibleとして集計します。',
  'Score帯別の3方式比較',
  'MA間隔拡大別の3方式比較',
  '対象Event 2件以上のEpisode',
  'Episode / Event 観測数比',
  'Event順序異常',
  '候補入りからEXITEDまでを1 Episode',
  'Stage組み合わせ',
  '選択Segment詳細',
  '3方式で同じColor Scaleを使用します。',
  '統計的有意性を判定するものではありません。',
]) {
  assert.ok(robustness.includes(text), `Outcome robustness UI must include ${text}`)
}

for (const horizon of ['1カ月', '3カ月', '6カ月', '12カ月']) {
  assert.ok(robustness.includes(horizon), `${horizon} must remain available in the shared Horizon contract`)
}
for (const metric of ['中央値リターン', 'プラス比率', '期間中最大上昇幅中央値', '期間中最大下落幅中央値']) {
  assert.ok(robustness.includes(metric), `${metric} must be selectable`)
}
for (const dimension of ['stage:dayA', 'stage:dayB', 'stage:weekA', 'stage:weekB', 'stage:monthA', 'stage:monthB']) {
  assert.ok(robustness.includes(dimension), `${dimension} must be supported`)
}

assert.ok(robustness.includes("useState<StageDimension>('stage:monthA')"), 'Stage view must default to monthA')
assert.ok(robustness.includes("useState<StageDimension>('stage:weekA')"), 'Stage pair rows must default to weekA')
assert.ok(robustness.includes("useState<RobustnessMetric>('medianReturn')"), 'median return must be the default metric')
assert.ok(robustness.includes("useState<RobustnessScope>('overall')"), 'overall must be the default analysis scope')
assert.ok(robustness.includes('/robustness?${params}'), 'the UI must use the derived robustness endpoint')
assert.ok(robustness.includes('AbortController'), 'leaving or changing dimensions must abort stale requests')
assert.ok(robustness.includes('requestSequence.current'), 'stale responses must not overwrite newer state')
assert.ok(robustness.includes('RESPONSE_CACHE'), 'identical outcome job and dimensions must be cached in session')
assert.ok(robustness.includes('Date.parse(cached.meta.expiresAt) > Date.now()'), 'derived cache must not outlive its source artifacts')
assert.ok(robustness.includes("if (scope === 'spread') return ['spreadExpansion']"), 'spread comparison must use saved Outcome diagnostics')
assert.ok(robustness.includes('if (!active) return null'), 'leaving the tab must remove the robustness UI')
assert.ok(robustness.includes('connectNulls={false}'), 'eligible=0 chart points must stay missing')
assert.ok(robustness.includes("summary.eligibleCount === 0"), 'eligible=0 must be rendered as N/A')
assert.ok(robustness.includes('summary?.smallSample && summary.eligibleCount > 0'), 'small sample state must be evaluated per unit')
assert.ok(robustness.includes('role="gridcell"'), 'Heatmap cells must provide keyboard-focusable detail')
assert.ok(robustness.includes('const pairScale = visibleResponse'), 'all three Heatmaps must share one scale')
assert.equal(robustness.includes('/result?'), false, 'the browser must not load Outcome Event rows')
assert.equal(robustness.includes('historical-scan/jobs'), false, 'the browser must not load Historical Event artifacts')
assert.equal(robustness.includes("from '@/lib/trigger-discovery-engine'"), false, 'the UI must not import the Trigger Engine')
assert.equal(robustness.includes('有効性が証明'), false, 'the UI must not make an automatic efficacy claim')
assert.equal(robustness.includes('頑健性が確認'), false, 'the UI must not make an automatic robustness claim')

console.log('trigger discovery Outcome robustness UI tests passed')
