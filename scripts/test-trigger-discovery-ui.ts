import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('app/trigger-discovery/TriggerDiscoveryClient.tsx', 'utf8')
const historicalWorkspace = fs.readFileSync('components/trigger-discovery/HistoricalScanWorkspace.tsx', 'utf8')
const outcomeWorkspace = fs.readFileSync('components/trigger-discovery/HistoricalOutcomeWorkspace.tsx', 'utf8')
const outcomeSegmentation = fs.readFileSync('components/trigger-discovery/OutcomeSegmentationPanel.tsx', 'utf8')
const outcomeRobustness = fs.readFileSync('components/trigger-discovery/OutcomeRobustnessPanel.tsx', 'utf8')
const historicalResultRoute = fs.readFileSync('app/api/trigger-discovery/historical-scan/jobs/[jobId]/result/route.ts', 'utf8')
const historicalJobService = fs.readFileSync('lib/server/trigger-discovery-historical-scan-jobs.ts', 'utf8')
const notificationPanel = fs.readFileSync('components/trigger-discovery/TriggerNotificationSettingsPanel.tsx', 'utf8')
const dataPopover = fs.readFileSync('components/shared/DataPopover.tsx', 'utf8')
const navigation = fs.readFileSync('components/layout/navigation.ts', 'utf8')

for (const text of ['日A', '日B', '週A', '週B', '月A', '月B']) {
  assert.ok(client.includes(text), `${text} must remain visible in the Stage contract`)
}
for (const text of ['Triggerを検索', 'Stageで絞り込む', 'PIT Universe', 'Stale accepted']) {
  assert.ok(client.includes(text), `${text} must remain in the Trigger Discovery UI`)
}
for (const text of ['月足', '2週足', '2週足は、週足を2本ずつ束ねて作成します。', "timeframe === 'BIWEEKLY' ? '本' : 'か月'"]) {
  assert.ok(client.includes(text), `${text} must remain in the Timeframe UI contract`)
}
for (const text of [
  'title="Trigger距離"',
  'title="Near距離"',
  'title="2本とも上向き"',
  'title="上から接近"',
  'title="基準日"',
  'MA1〜MA2で形成される価格帯（Trigger Zone）まで、何％手前から「接近中」と判定するかを設定します。',
  'MA1とMA2の間の価格帯です。',
  'Trigger距離以内',
  'APPROACHING',
  'Near距離以内',
  'NEAR',
  'MA1〜MA2の間',
  'IN ZONE',
  '株価がMA1〜MA2のTrigger Zoneより上にあり、そこへ向かって下落・接近している銘柄を対象とします。',
  '指定した日付時点で利用可能な価格・MA・Stageだけを使ってTriggerを検索します。休日の場合は、その日以前の直近取引日に解決されます。',
  '上場期間は、現在保持している全取引履歴から過去時点を復元しています。',
  '最新の利用可能日に解決されます。',
  '最新へ',
  '過去検証',
  '→ 評価日',
  "response.meta.resolvedAsOf ?? '評価日なし'",
  '指定日 {response.meta.requestedAsOf} → 評価日',
]) {
  assert.ok(client.includes(text), `Trigger Discovery help UI should include ${text}`)
}
assert.ok(client.includes("import { DataPopover } from '@/components/shared/DataPopover'"), 'Help UI must reuse DataPopover')
assert.ok(client.includes('triggerAriaLabel={`${title}の説明`}'), 'Help triggers must have accessible names')
assert.ok(client.includes('openOnHover'), 'Help must support desktop hover/focus and mobile tap')
assert.ok(dataPopover.includes('aria-label={triggerAriaLabel}'), 'DataPopover must apply the accessible trigger name')
assert.ok(dataPopover.includes("event.pointerType === 'mouse'"), 'DataPopover must open help on desktop hover')
assert.ok(dataPopover.includes('onFocus={() =>'), 'DataPopover must open help from keyboard focus')
assert.ok(client.includes('timeframe: response.meta.timeframe'), 'Mini Chart request and cache must carry the result timeframe')
assert.ok(client.includes("setTimeframe(request.timeframe ?? 'MONTHLY')"), 'Saved Trigger load must restore its Monthly/Biweekly timeframe')
assert.ok(client.includes("definition.evaluationConfig.timeframe === 'BIWEEKLY' ? '2週足' : '月足'"), 'Saved Trigger list/editor must identify its timeframe')
assert.equal(client.includes('2週足条件の保存は次の更新で対応予定です。'), false, 'Biweekly save must be enabled')
assert.equal(client.includes("disabled={savedBusy || timeframe === 'BIWEEKLY'}"), false, 'Biweekly save controls must not be disabled')
assert.ok(client.includes('AbortController'), 'stale searches must be abortable')
assert.ok(client.includes("'/api/trigger-discovery/mini-charts'"), 'Mini Charts must use a separate batch endpoint')
assert.ok(client.includes('response.rows.map'), 'the results table renders independently from Mini Chart completion')
assert.ok(client.includes('miniChartLoadingKeys'), 'each Mini Chart cell must expose a loading state')
assert.ok(client.includes('miniChartCache.current'), 'Mini Charts must be reused within the current client session')
assert.ok(client.includes('controller.abort()'), 'stale Mini Chart batches must be abortable')
assert.ok(client.includes('TriggerScoreCell'), 'Trigger Score must expose an explainable breakdown')
assert.ok(client.includes('Trigger Scoreは条件への適合度です'), 'Score must not be presented as an investment recommendation')
assert.ok(client.includes('sortKey="triggerScore"'), 'Trigger Score must be sortable')
assert.ok(client.indexOf('sortKey="triggerStatus"') < client.indexOf('sortKey="triggerScore"'), 'Score follows Status')
const resultColumnOrder = [
  'data-column="stock"',
  'data-column="status"',
  'data-column="score"',
  'data-column="chart"',
  'data-column="price"',
  'data-column="market"',
  'data-column="zone"',
  'data-column="ma1"',
  'data-column="ma2"',
  'data-column="trading-value"',
  'data-column="volume"',
  'data-column="stage"',
  'data-column="watchlist"',
]
resultColumnOrder.reduce((previousIndex, marker) => {
  const index = client.indexOf(marker, previousIndex + 1)
  assert.ok(index > previousIndex, `${marker} must follow the required Trigger result review order`)
  return index
}, -1)
assert.ok(client.includes('sticky left-0'), 'the stock identity column must remain visible during horizontal scrolling')
assert.ok(client.includes('sticky top-0'), 'the result header must remain visible during desktop table scrolling')
assert.ok(client.includes('grid grid-cols-6 gap-1'), 'six Stage axes must render as one compact block')
assert.ok(client.includes('STAGE_AXIS_LABELS[axis]'), 'the compact Stage block must preserve 日A→日B→週A→週B→月A→月B labels')
assert.ok(client.includes("response.meta.timeframe === 'BIWEEKLY' ? '本' : 'M'"), 'distance headers must follow the selected timeframe unit')
assert.ok(client.includes('row.averageVolume'), 'the result table must use the existing averageVolume response value')
assert.ok(client.indexOf('compactAmount(row.averageTradingValue)') < client.indexOf('numberOrDash(row.averageVolume'), 'average trading value must precede average volume')
assert.ok(client.includes("aria-sort={sortAria('triggerScore')}"), 'sortable columns must expose their active direction through aria-sort')
assert.ok(client.includes('現在${activeSort?.direction'), 'sort control labels must announce the active direction')
assert.ok(client.includes('評価内訳'), 'technical result counts must remain available as secondary detail')
assert.ok(client.includes('criteriaSummary'), 'active result criteria must remain visible above the table')
assert.ok(client.includes('const [builderOpen, setBuilderOpen] = useState(true)'), 'the condition builder must be open before the first search')
assert.ok(client.includes('if (collapseBuilderOnSuccess) setBuilderOpen(false)'), 'an explicit successful search must enter results focus mode')
assert.ok(client.includes('await runSearch(validateAndBuildRequest(), true)'), 'only the explicit search action should request automatic builder collapse')
assert.ok(client.includes("{(!response || builderOpen) && <div data-trigger-builder>"), 'the existing builder must remain mounted only while editing or before a search')
assert.ok(client.includes('data-trigger-compact-summary'), 'successful searches must expose the compact results summary')
assert.ok(client.includes('data-trigger-builder-toggle'), 'focus mode must provide a condition-editing control')
assert.ok(client.includes('条件を変更'), 'focus mode must let users reopen the existing builder')
assert.ok(client.includes('候補 <strong'), 'the candidate count must lead the compact summary')
assert.ok(client.includes('評価日 {response.meta.resolvedAsOf'), 'the resolved evaluation date must remain visible in focus mode')
assert.ok(client.includes("response.meta.timeframe === 'BIWEEKLY' ? '2週足' : '月足'"), 'the result timeframe and MA pair must remain visible in focus mode')
assert.ok(client.includes('適用中 {criteriaSummary}'), 'active major conditions must remain visible in focus mode')
for (const text of ['Trigger距離 ${request.maxApproachDistancePct}%', 'Near ${request.nearDistancePct}%', "'2本とも上向き'", "'上から接近'"]) {
  assert.ok(client.includes(text), `the compact summary must retain the active condition ${text}`)
}
assert.ok(client.includes('指定日 {response.meta.requestedAsOf} / 評価日'), 'historical as-of focus mode must distinguish requested and evaluated dates')
assert.ok(client.indexOf('data-trigger-compact-summary') < client.indexOf('data-trigger-results-table'), 'the compact summary must immediately precede the result area')
assert.ok(client.includes('setBuilderOpen(true)'), 'saved-trigger loading and mode changes must return to the editable builder')
assert.ok(client.includes('この条件に一致するTrigger候補はありません。'), 'empty results must explain the current condition has no candidates')
assert.ok(client.includes('WatchlistButton'), 'existing Watchlist integration must be reused')
assert.ok(client.includes("href={`/stock/${row.ticker}`}"), 'stock detail route must be preserved')
for (const text of ['保存済みTrigger', '条件を保存', '別名で保存', '名前変更', '変更あり']) {
  assert.ok(client.includes(text), `${text} must remain in the Saved Trigger UI`)
}
assert.ok(client.includes("fetch('/api/trigger-discovery/saved'"), 'Saved Trigger list must use its dedicated API')
assert.ok(client.includes('searchRequestFromSavedTrigger(definition, options.latestAsOf ?? draft.asOf)'), 'loading must use the latest runtime as-of date')
assert.ok(client.includes('setResponse(null)'), 'loading a definition must clear stale results without searching')
assert.ok(client.includes('内容を確認してからTriggerを検索してください'), 'loading must require an explicit search')
assert.ok(client.includes('基準日は保存されません'), 'the non-persisted as-of contract must be visible')
assert.ok(client.includes("method: 'DELETE'"), 'archive must use the Saved Trigger delete endpoint')
assert.ok(client.includes('TriggerNotificationSettingsPanel'), 'a loaded Saved Trigger must expose notification settings')
for (const text of [
  '通知設定',
  '毎日の候補まとめ',
  '毎日の評価結果から、現在のTrigger候補をまとめます。',
  '表示候補数',
  '候補の並び順は、このTriggerに保存されている並び順を使用します。',
  '状態変化のお知らせ',
  '新規候補',
  '再エントリー',
  'NEAR入り',
  'Trigger Zone入り',
  'Zoneから反発',
  'Zone下抜け',
  '詳細な離脱通知',
  '基本条件から離脱',
  'Stage条件から離脱',
  '市場・価格・流動性条件から離脱',
  'データ不足・更新なし',
  'その他の候補離脱',
  'Gmail自動配信は未設定です。通知設定をONにすると通知内容は生成されますが、メール送信は行われません。',
]) {
  assert.ok(notificationPanel.includes(text), `notification settings UI must include ${text}`)
}
assert.ok(notificationPanel.includes("role=\"switch\""), 'notification toggles must use the accessible switch role')
assert.ok(notificationPanel.includes('aria-checked={checked}'), 'notification switches must expose their current state')
assert.ok(notificationPanel.includes('type="checkbox"'), 'lifecycle event choices must use labeled native checkboxes')
assert.ok(notificationPanel.includes('disabled={!draft.dailyDigestEnabled || saving}'), 'Digest OFF must disable only the candidate-count input')
assert.ok(notificationPanel.includes('disabled={!draft.lifecycleAlertEnabled || saving}'), 'Alert OFF must disable event controls without clearing them')
assert.ok(notificationPanel.includes('通知設定に変更あり'), 'notification dirty state must be distinct from Builder changes')
assert.ok(notificationPanel.includes('未保存の通知設定を破棄して閉じますか？'), 'closing a dirty notification panel must be safe')
assert.ok(notificationPanel.includes('/notification-settings`'), 'the existing Saved Trigger settings endpoint must be reused')
assert.equal((notificationPanel.match(/method: 'PUT'/g) ?? []).length, 1, 'notification settings must only PUT from explicit save')
assert.ok(notificationPanel.includes('onClick={() => void saveSettings()}'), 'settings changes must require an explicit save action')
assert.ok(notificationPanel.includes('AbortController'), 'stale notification settings requests must be abortable')
assert.ok(notificationPanel.includes('sequence !== requestSequence.current'), 'a slow response for Trigger A must not overwrite Trigger B')
assert.ok(notificationPanel.includes("definition.evaluationConfig.timeframe === 'BIWEEKLY' ? '2週足' : '月足'"), 'the settings target must identify Monthly/Biweekly')
for (const forbidden of ['Gmail認証', 'テストメールを送る', '今すぐ通知', 'PENDING送信']) {
  assert.equal(notificationPanel.includes(forbidden), false, `${forbidden} must not be introduced in Phase 11`)
}
assert.ok(navigation.includes("href: '/trigger-discovery'"))
assert.ok(navigation.includes("pageIds: ['watchlist', 'ma25mMonitor', 'triggerDiscovery']"))

for (const text of [
  '現在・単日時点',
  '期間検証',
  '開始日',
  '終了日',
  'HistoricalScanWorkspace',
  'validateAndBuildHistoricalRequest',
]) {
  assert.ok(client.includes(text), `Historical mode builder must include ${text}`)
}
assert.equal((client.match(/label="MA 1"/g) ?? []).length, 1, 'Historical mode must share the existing MA builder')
assert.equal((client.match(/市場（未選択はすべて）/g) ?? []).length, 1, 'Historical mode must share the existing Universe builder')
assert.ok(client.includes('stageFilterControls(false)'), 'Historical mode must reuse the six-axis Stage filter controls')
assert.ok(client.includes("mode === 'current'"), 'Normal Trigger Search must remain the primary/default mode')

for (const text of [
  '期間検証を開始',
  '指定期間の各営業日時点でTrigger条件を再現し、候補入り・状態変化・候補離脱を確認します。',
  '期間によって1〜2分程度かかる場合があります。',
  '他の分析画面が一時的に遅くなる場合があります。',
  '本機能はTrigger発生履歴を確認するもので、その後の投資成果を評価するものではありません。',
  '最大520営業日',
  '検証をキャンセル',
  '処理位置によってキャンセル完了まで少し時間がかかる場合があります。',
  '検証サマリー',
  '候補数推移',
  '変化イベント',
  '最近の期間検証',
  '新規候補',
  '再エントリー',
  '状態変化',
  'NEAR入り',
  'Trigger Zone入り',
  '候補離脱',
  'グラフの日付を選ぶと、その日のイベントに絞り込みます。',
  '日付絞り込みを解除',
  'イベント日付で絞り込む',
  '期限切れ',
  '同じ条件で再実行',
  '単日で見る',
]) {
  assert.ok(historicalWorkspace.includes(text), `Historical Scan UI must include ${text}`)
}
for (const status of ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED']) {
  assert.ok(historicalWorkspace.includes(status), `Historical Scan UI must handle ${status}`)
}
assert.ok(historicalWorkspace.includes("fetch('/api/trigger-discovery/historical-scan/jobs'"), 'Historical UI must start only the async Job API')
assert.equal(historicalWorkspace.includes("fetch('/api/trigger-discovery/historical-scan'"), false, 'Historical UI must not call the synchronous scan API')
assert.ok(historicalWorkspace.includes('setTimeout(poll, 1_500)'), 'Job polling must use a bounded 1.5 second interval')
assert.ok(historicalWorkspace.includes('disabled={startBusy || Boolean(active)}'), 'Historical start must be disabled while the selected job is active')
assert.ok(historicalWorkspace.includes('role="progressbar"'), 'Actual job progress must be accessible')
assert.ok(historicalWorkspace.includes('processedTradingDays'), 'Progress must use processed trading days')
assert.ok(historicalWorkspace.includes('totalTradingDays'), 'Progress must use total trading days')
assert.ok(historicalWorkspace.includes('AbortController'), 'Polling and result requests must be abortable')
assert.ok(historicalWorkspace.includes('eventOffset'), 'Events must use server-side pagination')
assert.ok(historicalWorkspace.includes('[50, 100, 200]'), 'Event page sizes must remain bounded')
assert.ok(historicalWorkspace.includes("useState<EventOrder>('desc')"), 'Latest events must be shown first by default')
assert.ok(historicalWorkspace.includes('LineChart'), 'The existing Recharts library must render candidate history')
assert.ok(historicalWorkspace.includes("params.set('eventType', 'STATUS_CHANGED')"), 'Convenience status filters must reuse STATUS_CHANGED events')
assert.ok(historicalWorkspace.includes("params.set('currentStatus', 'NEAR')"), 'NEAR-entry filtering must run server-side')
assert.ok(historicalWorkspace.includes("params.set('currentStatus', 'IN_ZONE')"), 'IN_ZONE-entry filtering must run server-side')
assert.ok(historicalWorkspace.includes("params.set('eventDate', eventDate)"), 'Selected chart dates must run as a server-side event filter')
assert.ok(historicalWorkspace.includes('onClick={(state) =>'), 'Candidate history must allow chart date selection')
assert.ok(historicalWorkspace.includes('setEventOffset(0)'), 'Filter interactions must return event pagination to the first page')
assert.ok(historicalWorkspace.includes('ReferenceLine'), 'The selected chart date must remain visually identifiable')
assert.ok(historicalWorkspace.includes('type="date"'), 'Event date filtering must remain keyboard accessible')
assert.ok(historicalWorkspace.includes('StageTag'), 'Historical events must reuse the existing Stage display')
assert.ok(historicalWorkspace.includes('TriggerScoreCell'), 'Historical events must reuse the existing Trigger Score display')
assert.equal(historicalWorkspace.includes('TriggerMiniChart'), false, 'Historical event rows must not render Mini Charts')
assert.ok(historicalResultRoute.includes('parseHistoricalScanResultPagination'), 'Result API must validate event paging/filter parameters')
for (const parameter of ['eventType', 'currentStatus', 'eventDate', 'eventSearch', 'eventOrder']) {
  assert.ok(historicalJobService.includes(parameter), `Result paging service must support ${parameter}`)
}

assert.ok(historicalWorkspace.includes('HistoricalOutcomeWorkspace'), 'Completed Historical results must include the Outcome workspace')
for (const text of [
  'その後の値動き',
  'NEAR入り',
  'Trigger Zone入り',
  'NEAR入り vs Zone入り',
  '新規候補',
  '再エントリー',
  '中央値リターン',
  'プラス比率',
  'Future data不足',
  'リターン分布',
  '期間中の最大上昇幅',
  '期間中の最大下落幅',
  '個別Event結果',
  '分析可能データ',
  'この条件に該当するTrigger Eventはありません。',
  'Event日の終値を基準とし、20 / 60 / 120 / 245営業日後の終値を比較します。',
  '同一銘柄の複数イベントを含むため、各観測は統計的に完全独立ではありません。',
  'Trigger条件やScoreの計算には利用されません。',
  '売買バックテストではありません。',
]) {
  assert.ok(outcomeWorkspace.includes(text), `Outcome UI must include ${text}`)
}
assert.ok(outcomeWorkspace.includes("useState<OutcomeMode>('NEAR_ENTERED')"), 'NEAR entry must be the default Outcome selector')
assert.ok(outcomeWorkspace.includes("mode === 'COMPARE' ? ['NEAR_ENTERED', 'IN_ZONE_ENTERED']"), 'comparison must use two existing selector jobs')
assert.ok(outcomeWorkspace.includes("for (const selector of nextSelectors)"), 'comparison jobs must be submitted sequentially')
assert.ok(outcomeWorkspace.includes('/outcomes`'), 'Outcome UI must start only the async Outcome Job API')
assert.ok(outcomeWorkspace.includes('/api/trigger-discovery/outcome-jobs/${id}'), 'Outcome UI must poll the Outcome Job API')
assert.ok(outcomeWorkspace.includes('/result?${params}'), 'Outcome rows must use the paginated result API')
assert.ok(outcomeWorkspace.includes('detailLimit') && outcomeWorkspace.includes('[50, 100, 200]'), 'Outcome rows must keep bounded server-side page sizes')
assert.ok(outcomeWorkspace.includes("sortBy: detailSort") && outcomeWorkspace.includes("sortOrder: detailOrder"), 'Outcome row sorting must remain server-side')
assert.ok(outcomeWorkspace.includes("setTimeout(poll, 1_500)"), 'Outcome polling must be bounded and stop at terminal status')
assert.ok(outcomeWorkspace.includes('OUTCOME_TERMINAL_STATUSES.has(job.status)'), 'Outcome polling must recognize terminal statuses')
assert.ok(outcomeWorkspace.includes("method: 'DELETE'"), 'Outcome jobs must support cancellation')
assert.ok(outcomeWorkspace.includes('outcomeNearJob') && outcomeWorkspace.includes('outcomeZoneJob'), 'comparison job IDs must be restorable from URL state')
assert.ok(outcomeWorkspace.includes('Score下限') && outcomeWorkspace.includes('Score上限'), 'Event-time Trigger Score filters must be available as advanced controls')
assert.ok(outcomeWorkspace.includes('DataPopover'), 'Outcome methodology help must reuse the existing accessible popover')
assert.ok(outcomeWorkspace.includes("row[`availability${suffix}`] === 'AVAILABLE'"), 'Unavailable horizons must not be rendered as zero')
assert.ok(outcomeWorkspace.includes('StageTag'), 'Outcome rows must show the saved six-axis Event Stage')
assert.equal(outcomeWorkspace.includes('TriggerMiniChart'), false, 'Outcome rows must not load Mini Charts')
assert.equal(outcomeWorkspace.includes("from '@/lib/trigger-discovery-engine'"), false, 'Outcome UI must not import or rerun the Trigger Engine')

assert.ok(outcomeWorkspace.includes('OutcomeSegmentationPanel'), 'Outcome Segmentation must appear inside the existing Outcome workspace')
assert.ok(outcomeWorkspace.indexOf('<OutcomeSegmentationPanel') < outcomeWorkspace.indexOf('detailResult && hasAnyDetailEvents'), 'Outcome Segmentation must appear before Event detail')
assert.ok(outcomeWorkspace.includes('horizon={detailHorizon}') && outcomeWorkspace.includes('onHorizonChange={setDetailHorizon}'), 'Segmentation must share the existing Outcome horizon state')
for (const text of [
  '条件別に見る',
  'Trigger発生時のScoreやStageごとに、その後の値動きを分解して確認します。',
  'Score帯',
  'Stage別',
  'Stage組み合わせ',
  '比較',
  '観測単位',
  '中央値リターン',
  'プラス比率',
  '期間中最大上昇幅中央値',
  '期間中最大下落幅中央値',
  '0–40未満',
  '40–60未満',
  '60–80未満',
  '80–100',
  '対象件数が30件未満のため、参考値として表示しています。',
  'S1〜S6は循環的な相場構造を表す分類で、数字の大小がそのまま強弱順位を意味するものではありません。',
  'NEAR入り vs Zone入り',
  '別の期間・時間軸',
  '比較元と比較先で母集団条件が異なります',
  'この比較は統計的に独立したRandomized comparisonではありません。',
]) {
  assert.ok(outcomeSegmentation.includes(text), `Outcome Segmentation UI must include ${text}`)
}
assert.ok(outcomeSegmentation.includes("useState<StageDimension>('stage:weekA')"), 'Stage pair rows must default to weekA')
assert.ok(outcomeSegmentation.includes("useState<StageDimension>('stage:monthA')"), 'Stage views must default to monthA')
assert.ok(outcomeSegmentation.includes("disabled={option.value === columnDimension}"), 'duplicate Stage pair axes must be unavailable')
assert.ok(outcomeSegmentation.includes("role=\"gridcell\""), 'Heatmap cells must be keyboard-focusable buttons with grid semantics')
assert.ok(outcomeSegmentation.includes('Heatmap凡例'), 'Heatmap must include a visible/text legend')
assert.ok(outcomeSegmentation.includes("summary.eligibleCount > 0 ? metricValue"), 'eligible=0 must remain N/A instead of becoming zero percent')
assert.ok(outcomeSegmentation.includes('/segments?${params}'), 'Segment views must use the saved Segments API')
assert.ok(outcomeSegmentation.includes("fetch('/api/trigger-discovery/outcome-segment-comparisons'"), 'comparisons must use the server comparison API')
assert.ok(outcomeSegmentation.includes("fetch('/api/trigger-discovery/historical-scan/jobs?limit=20'"), 'timeframe comparison must reuse the completed Historical Job list')
assert.ok(!outcomeSegmentation.includes('[expanded, tab, comparisonKind, historicalJobsLoaded, historicalJobsLoading]'), 'Historical Job lazy-load effect must not abort itself when loading state changes')
assert.ok(outcomeSegmentation.includes('/outcomes`'), 'comparison Outcome generation must reuse the existing Outcome start API')
assert.ok(outcomeSegmentation.includes("setComparisonKind('source'); setComparisonData(null); setComparisonError(null); setComparisonLoading(false)"), 'switching comparison sources must clear aborted-request loading state')
assert.ok(outcomeSegmentation.includes('AbortController'), 'stale segmentation requests must be abortable')
assert.ok(outcomeSegmentation.includes('segmentCache.current') && outcomeSegmentation.includes('comparisonCache.current'), 'identical segmentation requests must be reused in session')
assert.equal(outcomeSegmentation.includes('TriggerMiniChart'), false, 'Segmentation must not load Mini Charts or OHLCV')
assert.equal(outcomeSegmentation.includes("from '@/lib/trigger-discovery-engine'"), false, 'Segmentation UI must not import the Trigger Engine')
assert.ok(outcomeSegmentation.includes('OutcomeRobustnessPanel'), 'Outcome robustness must stay inside the existing segmentation workspace')
assert.ok(outcomeRobustness.includes('/robustness?${params}'), 'Outcome robustness must use its derived read-only API')
assert.equal(outcomeRobustness.includes('/result?'), false, 'Outcome robustness must not fetch all Outcome Event rows')
assert.equal(outcomeRobustness.includes('historical-scan/jobs'), false, 'Outcome robustness must not fetch Historical Events into the browser')

console.log('trigger discovery UI structure tests passed')
