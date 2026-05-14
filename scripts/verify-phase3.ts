// scripts/verify-phase3.ts
//
// Phase 3 の検証: テスト銘柄について類似ケース取得 + パターン統計取得を実行し、結果を表示。
//
// 使い方:
//   USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/verify-phase3.ts

import { db } from '@/lib/db/client'
import { dailySnapshots } from '@/lib/db/schema'
import { findSimilarSnapshots, findStereoscopicallySimilar } from '@/lib/similarity'
import { getPatternStats } from '@/lib/patterns'
import { patternCode } from '@/lib/features'
import { desc, eq } from 'drizzle-orm'

const TEST_TICKERS = ['7203', '6758', '9984']  // トヨタ / ソニー / ソフトバンク G
const HORIZONS = [30, 60, 90, 180]

async function main() {
  for (const ticker of TEST_TICKERS) {
    const latest = (await db
      .select()
      .from(dailySnapshots)
      .where(eq(dailySnapshots.ticker, ticker))
      .orderBy(desc(dailySnapshots.date))
      .limit(1))[0]

    if (!latest) {
      console.log(`\n=== ${ticker}: スナップショットなし ===`)
      continue
    }

    console.log(`\n=== ${ticker} @ ${latest.date} ===`)
    console.log(`ステージ (daily_a, daily_b, weekly_a, weekly_b, monthly_a, monthly_b): ${latest.daily_a_stage}, ${latest.daily_b_stage}, ${latest.weekly_a_stage}, ${latest.weekly_b_stage}, ${latest.monthly_a_stage}, ${latest.monthly_b_stage}`)

    // 類似ケース (daily timescale, top 5)
    const dailySim = await findSimilarSnapshots(ticker, latest.date, 'daily', 5)
    console.log('\nDaily 類似 top 5:')
    console.table(dailySim)

    // 立体的類似 (3 timescale 共通の top 5)
    const stereo = await findStereoscopicallySimilar(ticker, latest.date, 100, 5)
    console.log('\nStereoscopic 類似 top 5:')
    console.table(stereo)

    // パターン統計
    const code = patternCode({
      daily_a:   latest.daily_a_stage,
      daily_b:   latest.daily_b_stage,
      weekly_a:  latest.weekly_a_stage,
      weekly_b:  latest.weekly_b_stage,
      monthly_a: latest.monthly_a_stage,
      monthly_b: latest.monthly_b_stage,
    })
    console.log(`\nPattern code: ${code ?? '(null - ステージ計算不能)'}`)

    if (code) {
      for (const h of HORIZONS) {
        const stats = await getPatternStats(code, h)
        if (stats) {
          const cats = stats.category_breakdown
          console.log(
            `  H=${h}d  n=${stats.count.toString().padStart(6)}  p50=${(stats.p50 ?? 0).toFixed(2).padStart(7)}%  ` +
            `(very_up=${cats.very_up}, up=${cats.up}, flat=${cats.flat}, down=${cats.down}, very_down=${cats.very_down})  ` +
            `layer=${stats.fallback_layer}`
          )
        } else {
          console.log(`  H=${h}d  (該当データなし)`)
        }
      }
    }
  }

  console.log('\n=== サニティチェック SQL ===')
  // distinct パターン数、horizon=60 件数 top10、111111 / 444444 の傾向
  const { client } = await import('@/lib/db/client')

  const distinctPatterns = await client.execute('SELECT COUNT(DISTINCT pattern_code) AS n FROM pattern_stats')
  console.log(`Distinct パターンコード数: ${(distinctPatterns.rows[0] as any).n}`)

  const topCount = await client.execute(`
    SELECT pattern_code, count, p50
    FROM pattern_stats
    WHERE horizon_days = 60
    ORDER BY count DESC LIMIT 10
  `)
  console.log('\nHorizon=60 件数 top10:')
  console.table(topCount.rows)

  for (const code of ['111111', '444444']) {
    const res = await client.execute({
      sql: 'SELECT * FROM pattern_stats WHERE pattern_code = ? ORDER BY horizon_days',
      args: [code],
    })
    console.log(`\nパターン ${code}:`)
    console.table(res.rows)
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
