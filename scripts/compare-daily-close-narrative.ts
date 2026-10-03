import { generateClaudeNarrative } from '@/lib/server/daily-close-narrative'
import {
  PORTED_BLOCKS,
  READONLY_REPORT_CONSTRAINTS,
  buildDailyCloseReport,
  isReportDate,
  precheckReadonlyDatabase,
  verifyPortedSource,
} from './lib/readonly-daily-close-report'

// Deterministic Narrative vs Claude Code Subscription Narrative を 1 日分だけ比較する。
// report は scripts/lib/readonly-daily-close-report.ts (sqlite3 -readonly) で組み立てる。
// 結果は stdout のみ。実 CLI を 1 回呼ぶため CLAUDE_NARRATIVE_COMPARE=1 の明示指定が必要。
//
// 実行例:
//   CLAUDE_NARRATIVE_COMPARE=1 READONLY_SQLITE_DB_PATH=<db> TSX_DISABLE_CACHE=1 \
//     ./node_modules/.bin/tsx scripts/compare-daily-close-narrative.ts [YYYY-MM-DD]

async function main() {
  if (process.env.CLAUDE_NARRATIVE_COMPARE !== '1') {
    console.error('CLAUDE_NARRATIVE_COMPARE=1 is required (this script calls Claude Code CLI once)')
    process.exitCode = 2
    return
  }
  const requestedDate = process.argv[2] ?? null
  if (requestedDate && !isReportDate(requestedDate)) throw new Error(`invalid date: ${requestedDate}`)

  // 移植元ソース照合。不一致なら DB にも Claude にも触れず中止
  verifyPortedSource()
  console.log(`Ported source verification: PASS (${PORTED_BLOCKS.length} blocks)`)
  await precheckReadonlyDatabase()
  console.log('SQLite precheck: journal_mode=wal, -readonly, query_only=ON')

  // report を読み取り生成し、実際に使われた priceDate を Claude 呼び出し前に表示する
  const report = await buildDailyCloseReport({ requestedDate, watchlistTickers: [] })
  console.log(`Comparison market_date: ${report.priceDate}`)

  const deterministic = Object.keys(report.takeaways).map(Number).sort((a, b) => a - b).map((key) => {
    const takeaway = report.takeaways[key]
    return takeaway.detail.length ? `${takeaway.headline}（${takeaway.detail.join(' / ')}）` : takeaway.headline
  })

  // ここで初めて Claude Code を 1 回呼ぶ
  const claude = await generateClaudeNarrative(report)

  console.log(JSON.stringify({
    requestedDate,
    reportDate: report.reportDate,
    priceDate: report.priceDate,
    dataStatus: report.dataStatus,
    comparisonConstraints: { ...READONLY_REPORT_CONSTRAINTS, watchlist: '空 (watchlistTickers: [])' },
    deterministic: { source: 'deterministic', paragraphs: deterministic },
    claude: claude.source === 'deterministic'
      ? { source: claude.source, fallbackReason: claude.fallbackReason }
      : claude,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'compare failed')
  process.exitCode = 1
})
