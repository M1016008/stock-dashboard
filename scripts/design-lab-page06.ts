import fs from 'node:fs'
import path from 'node:path'
import { MOMENTUM_STATE_LABEL, buildMomentumMatrix } from '@/lib/daily-close-momentum-matrix'
import { buildPage06ClaudeInput, deterministicPage06Narrative, validatePage06Narrative, type Page06Narrative } from '@/lib/daily-close-page06-narrative-content'
import { generatePage06Narrative } from '@/lib/server/daily-close-page06-narrative'
import { SNAPSHOT_VERSION, baseName, readSnapshot, renderSnapshot, type Page06Snapshot } from './lib/design-lab-page06-render'
import {
  PORTED_BLOCKS,
  READONLY_REPORT_CONSTRAINTS,
  buildDailyCloseReport,
  isReportDate,
  precheckReadonlyDatabase,
  verifyPortedSource,
} from './lib/readonly-daily-close-report'

// Page 06 Design Lab CLI。
//
// generate: 本番 SQLite を read-only で読み、Matrix 判定 → Narrative → snapshot.json → HTML/PDF/PNG
//   CLAUDE_DESIGN_LAB=1 READONLY_SQLITE_DB_PATH=<db> TSX_DISABLE_CACHE=1 \
//     ./node_modules/.bin/tsx scripts/design-lab-page06.ts generate <outDir> [YYYY-MM-DD] [--narrative-json <file>]
//   --narrative-json: 既に生成済みの Claude 文章 ({ model, durationMs, text }) を再検証して使う (Claude を呼ばない)
//
// render: snapshot.json から HTML/PDF/PNG だけを再生成 (DB・Claude に触れない。レイアウト調整用)
//   TSX_DISABLE_CACHE=1 ./node_modules/.bin/tsx scripts/design-lab-page06.ts render <snapshot.json> [outDir]
//
// 出力先はリポジトリ外のみ。Production の PDF / レポート経路には接続しない。

function assertOutsideRepo(dir: string): void {
  if (dir === process.cwd() || dir.startsWith(`${process.cwd()}${path.sep}`)) throw new Error('output directory must be outside the repository')
}

function takeFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value) throw new Error(`${flag} requires a value`)
  args.splice(index, 2)
  return value
}

async function generate(args: string[]) {
  const narrativeJson = takeFlag(args, '--narrative-json')
  const outDir = args[0] ? path.resolve(args[0]) : ''
  const requestedDate = args[1] ?? '2026-10-02'
  if (!outDir) throw new Error('generate requires <outDir>')
  assertOutsideRepo(outDir)
  if (!isReportDate(requestedDate)) throw new Error(`invalid date: ${requestedDate}`)
  if (!narrativeJson && process.env.CLAUDE_DESIGN_LAB !== '1') throw new Error('CLAUDE_DESIGN_LAB=1 is required (generate calls Claude Code CLI once)')

  verifyPortedSource()
  console.log(`Ported source verification: PASS (${PORTED_BLOCKS.length} blocks)`)
  await precheckReadonlyDatabase()
  console.log('SQLite precheck: journal_mode=wal, -readonly, query_only=ON')

  const report = await buildDailyCloseReport({ requestedDate, watchlistTickers: [] })
  if (report.priceDate !== requestedDate) throw new Error(`priceDate mismatch: requested ${requestedDate}, got ${report.priceDate}`)
  console.log(`Design Lab market_date: ${report.priceDate}`)

  const model = buildMomentumMatrix(report)
  const claudeInput = buildPage06ClaudeInput(model)
  const deterministicFallback = deterministicPage06Narrative(model)

  let narrative: Page06Snapshot['narrative']
  if (narrativeJson) {
    const saved = JSON.parse(fs.readFileSync(narrativeJson, 'utf8')) as { model?: string | null; durationMs?: number | null; text: Page06Narrative }
    const validated = validatePage06Narrative(saved.text, claudeInput, model.points.map((point) => point.name))
    if (!validated.ok) throw new Error(`saved narrative failed validation: ${validated.reason}`)
    narrative = { source: 'claude-code-subscription', model: saved.model ?? null, durationMs: saved.durationMs ?? null, text: validated.narrative }
    console.log('Narrative: reused saved Claude output (validated, Claude not called)')
  } else {
    // ここで初めて Claude Code を 1 回呼ぶ
    const result = await generatePage06Narrative(model)
    narrative = result.source === 'deterministic'
      ? { source: 'deterministic', fallbackReason: result.fallbackReason, fallbackDetail: result.fallbackDetail ?? null, text: result.narrative }
      : { source: 'claude-code-subscription', model: result.model, durationMs: result.durationMs, text: result.narrative }
  }

  const snapshot: Page06Snapshot = {
    version: SNAPSHOT_VERSION,
    reportDate: report.priceDate,
    generatedAt: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    dataStatus: report.dataStatus,
    constraints: { ...READONLY_REPORT_CONSTRAINTS },
    model,
    claudeInput,
    narrative,
    deterministicFallback,
  }
  fs.mkdirSync(outDir, { recursive: true })
  const snapshotPath = path.join(outDir, `${baseName(snapshot.reportDate, 'claude')}.snapshot.json`)
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  await renderAndReport(snapshot, outDir, snapshotPath)
}

async function renderAndReport(snapshot: Page06Snapshot, outDir: string, snapshotPath: string) {
  const outputs = await renderSnapshot(snapshot, outDir)
  console.log(JSON.stringify({
    reportDate: snapshot.reportDate,
    counts: Object.fromEntries(Object.entries(snapshot.model.counts).map(([state, count]) => [MOMENTUM_STATE_LABEL[state as keyof typeof MOMENTUM_STATE_LABEL], count])),
    lowSample: { count: snapshot.model.lowSampleCount, names: snapshot.model.lowSampleNames },
    narrative: snapshot.narrative,
    deterministicFallback: snapshot.deterministicFallback,
    snapshotPath,
    outputs,
  }, null, 2))
}

async function render(args: string[]) {
  const snapshotPath = args[0] ? path.resolve(args[0]) : ''
  if (!snapshotPath) throw new Error('render requires <snapshot.json>')
  const outDir = args[1] ? path.resolve(args[1]) : path.dirname(snapshotPath)
  assertOutsideRepo(outDir)
  await renderAndReport(readSnapshot(snapshotPath), outDir, snapshotPath)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'generate') return generate(args)
  if (command === 'render') return render(args)
  throw new Error('usage: design-lab-page06.ts generate <outDir> [YYYY-MM-DD] [--narrative-json <file>] | render <snapshot.json> [outDir]')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'design lab failed')
  process.exitCode = 1
})
