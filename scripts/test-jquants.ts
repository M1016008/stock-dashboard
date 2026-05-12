// scripts/test-jquants.ts
// J-Quants 接続スモークテスト。3 銘柄の直近 5 日分を取得して中身を表示。
//
//   npx tsx --env-file=.env.local scripts/test-jquants.ts

import { fetchJQuantsDaily, fetchJQuantsListedInfo, toJQuantsCode } from '@/lib/jquants'

async function main() {
  console.log('=== toJQuantsCode 変換テスト ===')
  console.log(`'7203'       → '${toJQuantsCode('7203')}'`)       // 期待: 72030
  console.log(`'7203.T'     → '${toJQuantsCode('7203.T')}'`)     // 期待: 72030
  console.log(`'72030'      → '${toJQuantsCode('72030')}'`)      // 期待: 72030

  console.log('\n=== 上場情報 (7203) ===')
  const info = await fetchJQuantsListedInfo('7203')
  console.log(info[0] ?? '(取得できず)')

  console.log('\n=== 直近 5 日の OHLCV (7203 トヨタ) ===')
  // 直近 5 営業日 = 約 1 週間
  const today = new Date()
  const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const fromStr = oneWeekAgo.toISOString().slice(0, 10)
  const ohlcv = await fetchJQuantsDaily('7203', fromStr)
  console.table(ohlcv.slice(-5))

  console.log(`\n総取得行数: ${ohlcv.length}`)

  console.log('\n=== ソニー G (6758) も 1 件確認 ===')
  const sony = await fetchJQuantsDaily('6758', fromStr)
  console.log(`6758: ${sony.length} 行、最新 = ${sony[sony.length - 1]?.date}, close = ${sony[sony.length - 1]?.close}`)

  console.log('\n認証 + API 接続 OK ✓')
}

main().catch(err => {
  console.error('Fatal:', err.message ?? err)
  process.exit(1)
})
