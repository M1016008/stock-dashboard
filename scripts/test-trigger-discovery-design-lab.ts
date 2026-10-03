import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { LAB_STATES } from '@/components/trigger-discovery/design-lab/fixtures'
import {
  DESIGN_LAB_OUTPUT_ROOT,
  LAB_VIEWPORTS,
  assertDesignLabOutputDir,
  assertFixtureOnlyDesignLabSources,
  renderStateHtml,
  startFixturePreviewServer,
} from './lib/ui-design-lab-trigger-discovery-render'

const html = Object.fromEntries(LAB_STATES.map((s) => [s, renderStateHtml(s)])) as Record<(typeof LAB_STATES)[number], string>

// 5 states × 5 viewports
assert.equal(LAB_VIEWPORTS.length, 5)
assert.deepEqual(LAB_VIEWPORTS.map((v) => `${v.width}x${v.height}`), ['1440x1000', '1024x768', '768x1024', '390x844', '1920x1080'])

// 共通: Header / Mode / Saved / Builder / 検索
for (const state of LAB_STATES) {
  assert.match(html[state], /現在・単日時点/, `${state}: mode selector`)
  assert.match(html[state], /保存済みTrigger/, `${state}: saved bar`)
  assert.match(html[state], /基準日/, `${state}: as-of field`)
  assert.match(html[state], /Trigger距離/, `${state}: trigger distance`)
  assert.match(html[state], /詳細条件/, `${state}: detail drawer`)
}

// results: 100行・評価日解決・STALE_ACCEPTED・Status/Stage/ページング
const results = html.results
assert.equal((results.match(/data-row/g) ?? []).length, 100)
assert.match(results, /指定日[\s\S]*2026-09-27（日）[\s\S]*評価日[\s\S]*2026-09-25（金）/)
assert.match(results, /STALE_ACCEPTED/)
assert.match(results, /Stale accepted/)
assert.match(results, /PIT Universe/)
assert.match(results, /Status表示フィルター/)
assert.match(results, /aria-sort="descending"/)
assert.match(results, /表示件数/)
assert.match(results, /Mini Chart/)
assert.equal((results.match(/Stage絞り込み/g) ?? []).length >= 1, true)

// 各状態の識別
assert.match(html.initial, /data-state-panel="initial"/)
assert.match(html.loading, /role="status"/)
assert.match(html.loading, /aria-busy="true"/)
assert.match(html.loading, /data-skeleton/)
assert.match(html.empty, /data-state-panel="empty"/)
assert.match(html.empty, /候補はありません/)
assert.match(html.error, /role="alert"/)
assert.match(html.error, /もう一度検索/)
assert.doesNotMatch(html.error, /data-row/)

// 契約: Period/Historical/Outcome/Path/Follow-up を実装していない
for (const state of LAB_STATES) assert.doesNotMatch(html[state], /Outcome|Follow-?up|Historical Scan/)

// design-lab配下はAPI/DB/計算ロジックをimportしない
const dir = path.resolve(__dirname, '../components/trigger-discovery/design-lab')
assertFixtureOnlyDesignLabSources()
for (const file of fs.readdirSync(dir)) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8')
  assert.doesNotMatch(src, /from '@\/lib\/(?!trigger-discovery-contract)|prisma|fetch\(|from 'next\/|["'`]\/api\//, `${file}: forbidden import`)
}

// Next App Routerへ載せない。共通layout/status pollingから物理的に隔離する。
assert.equal(fs.existsSync(path.resolve(__dirname, '../app/ui-design-lab/trigger-discovery/page.tsx')), false)
assert.throws(() => assertDesignLabOutputDir(path.resolve(__dirname, '../.tmp-design-lab')), /isolated QA output root/)

async function previewIsolationTest() {
  fs.mkdirSync(DESIGN_LAB_OUTPUT_ROOT, { recursive: true })
  const outputDir = fs.mkdtempSync(path.join(DESIGN_LAB_OUTPUT_ROOT, 'isolation-test-'))
  fs.writeFileSync(path.join(outputDir, 'preview.html'), '<!doctype html><title>fixture preview</title>')
  fs.writeFileSync(path.join(outputDir, 'trigger-discovery-results.html'), html.results)
  const preview = await startFixturePreviewServer({ outDir: outputDir, port: 0 })
  try {
    const index = await fetch(preview.url)
    assert.equal(index.status, 200)
    assert.equal(index.headers.get('x-design-lab-isolation'), 'fixture-only')
    assert.match(await index.text(), /fixture preview/)

    const result = await fetch(`http://127.0.0.1:${preview.port}/trigger-discovery-results.html`)
    assert.equal(result.status, 200)
    assert.match(await result.text(), /data-row/)

    for (const pathname of ['/api/status/overview', '/api/health', '/package.json']) {
      const response = await fetch(`http://127.0.0.1:${preview.port}${pathname}`)
      assert.equal(response.status, 404, pathname)
    }
    const post = await fetch(preview.url, { method: 'POST' })
    assert.equal(post.status, 405)
  } finally {
    await new Promise<void>((resolve, reject) => preview.server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
}

previewIsolationTest()
  .then(() => console.log('trigger-discovery design-lab: all checks passed'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
