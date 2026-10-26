// US ルート入口 20 件の Loading / Empty / Error 契約テスト。
// DB・ブラウザ・ネットワークを使わず、ソース契約と静的レンダリングだけで検証する。
//
// - 20 入口の棚卸し: app/us 配下の page.tsx と過不足なく一致すること
// - 共有 Error Boundary (app/us/error.tsx): 例外文を出さず、再試行だけを提示すること
// - 各入口: 読み込み中・空/未生成・失敗の表示が区別されて存在すること
//   (失敗を画面内で扱わない入口は、共有 Boundary が受けることを明示する)
// - 画面内の失敗表示: role="alert" と固定文言で伝え、API/例外の文字列をそのまま描画しないこと
// - 読み込み中・失敗中は件数を 0 と見せない (未確定は「—」や状態ラベル)。失敗表示は画面上部に置き、再試行で同じ取得をやり直す

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import UsError from '@/app/us/error'
import { logUsRouteError, safeErrorDigest, UsRouteErrorState } from '@/components/us/UsRouteErrorState'
import { EmptyState } from '@/components/ui/EmptyState'

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const exists = (file: string) => fs.existsSync(path.join(root, file))

type Contract = { file: string; patterns: RegExp[] }
type Entry = {
  id: string
  path: string
  pages: string[]
  loading: Contract[]
  empty: Contract[]
  /** 画面内で扱う失敗。無い入口は sharedBoundary で受ける */
  error: Contract[]
  /** 未捕捉の読み込み失敗を app/us/error.tsx に委ねる箇所 */
  sharedBoundary: Contract[]
  /** 失敗時に API/例外の生の文字列を描画していないこと (含んではいけないパターン) */
  forbidden?: Contract[]
}

const STOCK_PAGE = 'app/us/stock/[ticker]/page.tsx'
const STOCK_CLIENT = 'app/us/stock/[ticker]/UsStockDetailClient.tsx'
const STOCK_LOADING = 'app/us/stock/[ticker]/loading.tsx'
const routeSkeleton = (file: string): Contract => ({ file, patterns: [/PageLoadingSkeleton/] })

const ENTRYPOINTS: Entry[] = [
  {
    id: 'dashboard',
    path: '/us',
    pages: ['app/us/page.tsx'],
    loading: [{ file: 'app/us/page.tsx', patterns: [/<Suspense fallback=\{<MarketStateSkeleton \/>\}>/, /<Suspense fallback=\{<UsDashboardSectionFallback section="us-movers" \/>\}>/] }],
    empty: [{ file: 'app/us/page.tsx', patterns: [/mode === 'unavailable' \|\| !resolvedDate/, /<DashboardHistoricalUnavailable state=\{asOf\} \/>/] }],
    error: [{ file: 'app/us/page.tsx', patterns: [/function SectionError[\s\S]{0,80}role="alert"/, /売買候補を取得できませんでした/] }],
    sharedBoundary: [{ file: 'app/us/page.tsx', patterns: [/const asOf = await getUsDashboardAsOfState\(requested\)/] }],
  },
  {
    id: 'screener',
    path: '/us/screener',
    pages: ['app/us/screener/page.tsx'],
    loading: [{ file: 'app/us/screener/UsScreenerClient.tsx', patterns: [/'USデータを確認しています\.\.\.'/, /'検索中…'/] }],
    // 0 件・未生成は表のセルで説明し、取得失敗とは同時に出さない
    empty: [{
      file: 'app/us/screener/UsScreenerClient.tsx',
      patterns: [/指定した条件に該当する銘柄はありません/, /USデータが未取得です/, /USステージデータが未生成です/, /\{rows\.length === 0 && !fetchError && \(/],
    }],
    // 取得失敗は空結果と別の状態として持ち、表の外の alert と再試行で伝える。422 と決算鮮度 503 は専用状態
    error: [{
      file: 'app/us/screener/UsScreenerClient.tsx',
      patterns: [
        /const \[fetchError, setFetchError\] = useState<ScreenerErrorKind \| null>\(null\)/,
        /res\.status === 503 && data\.error === 'us_earnings_unavailable'/,
        /throw new ScreenerRequestError\('earnings', data\.reason\)/,
        /throw new ScreenerRequestError\(res\.status === 422 \? 'pit' : 'failed'\)/,
        /setFetchError\(error instanceof ScreenerRequestError \? error\.kind : 'failed'\)/,
        /pit: '過去日では使えない条件（取引所・資産種別・業種分類・時価総額）が含まれています。/,
        /failed: 'USスクリーナーの結果を取得できませんでした。/,
        /\{fetchError && \(\s*<div[^>]*>\s*<p role="alert"[^>]*>\{SCREENER_ERROR_COPY\[fetchError\]\}<\/p>\s*<button type="button" onClick=\{\(\) => setRetryVersion\(\(value\) => value \+ 1\)\}/,
        /\}, \[params, retryVersion, unavailableDateReason\]\)/,
        /loading \? '検索中…' : fetchError \? '取得失敗' : dateUnavailable \? '表示不可' : `\$\{rows\.length/,
        // 失敗は「最新データ」等の成功バッジより優先する (AS OF の日付は文脈として残す)
        /const modeLabel = fetchError\s*\? '取得失敗'/,
        /const modeClass = fetchError\s*\? 'border-red-200 bg-red-50 text-\[var\(--color-market-red-dark\)\]'/,
      ],
    }],
    sharedBoundary: [{ file: 'app/us/screener/page.tsx', patterns: [/const asOf = await getUsDashboardAsOfState\(requestedDate\)/] }],
    forbidden: [{
      file: 'app/us/screener/UsScreenerClient.tsx',
      // 失敗時に API の message や例外文を表示へ流さない。成功応答の message も既知の 2 種以外はそのまま出さない
      patterns: [/setMessage\(error/, /error\.message/, /throw new Error\(/, /^\s*return message\s*$/m, /\{message\}/],
    }],
  },
  {
    id: 'earnings',
    path: '/us/earnings',
    pages: ['app/us/earnings/page.tsx'],
    loading: [routeSkeleton('app/us/loading.tsx')],
    empty: [{ file: 'app/us/earnings/page.tsx', patterns: [/result\.rows\.length === 0/, /決算予定を表示できません/] }],
    error: [],
    sharedBoundary: [{ file: 'app/us/earnings/page.tsx', patterns: [/await getUsEarningsCalendar\(/] }],
  },
  {
    id: 'daily-close',
    path: '/us/daily-close',
    pages: ['app/us/daily-close/page.tsx'],
    loading: [routeSkeleton('app/us/loading.tsx')],
    empty: [{ file: 'app/us/daily-close/page.tsx', patterns: [/report\?\.status === 'empty'/, /対象日のUS市場データがありません/] }],
    error: [{ file: 'app/us/daily-close/page.tsx', patterns: [/role="alert"/, /US Daily Closeを読み込めません/] }],
    sharedBoundary: [],
  },
  {
    id: 'period-explorer',
    path: '/us/period-explorer',
    pages: ['app/us/period-explorer/page.tsx'],
    loading: [
      { file: 'app/us/period-explorer/page.tsx', patterns: [/<Suspense fallback=\{<PageLoadingSkeleton/] },
      { file: 'app/period-explorer/PeriodExplorerClient.tsx', patterns: [/期間データを集計しています/] },
    ],
    empty: [{ file: 'app/period-explorer/PeriodExplorerClient.tsx', patterns: [/response\.total === 0/, /条件に一致する銘柄がありません/] }],
    error: [{ file: 'app/period-explorer/PeriodExplorerClient.tsx', patterns: [/role="alert"/, /\{error\}/] }],
    sharedBoundary: [{ file: 'app/us/period-explorer/page.tsx', patterns: [/await getPeriodExplorerCalendar\('US'\)/] }],
  },
  {
    id: 'sector-etfs',
    path: '/us/sector-etfs',
    pages: ['app/us/sector-etfs/page.tsx'],
    loading: [routeSkeleton('app/us/loading.tsx')],
    empty: [{ file: 'app/us/sector-etfs/page.tsx', patterns: [/board\?\.status === 'empty'/, /USセクターETFデータがまだありません/] }],
    error: [{ file: 'app/us/sector-etfs/page.tsx', patterns: [/role="alert"/, /USセクターETFを読み込めませんでした/] }],
    sharedBoundary: [],
  },
  {
    id: 'sector-etf-detail',
    path: '/us/sector-etfs/[ticker]',
    pages: ['app/us/sector-etfs/[ticker]/page.tsx'],
    loading: [routeSkeleton('app/us/loading.tsx')],
    empty: [{ file: 'app/us/sector-etfs/[ticker]/page.tsx', patterns: [/notFound\(\)/, /構成銘柄・組入比率は利用できません/] }],
    error: [],
    sharedBoundary: [{ file: 'app/us/sector-etfs/[ticker]/page.tsx', patterns: [/await loadUsSectorEtfDetail\(/] }],
  },
  {
    id: 'trade-workbench',
    path: '/us/trade/workbench',
    pages: ['app/us/trade/workbench/page.tsx'],
    loading: [routeSkeleton('app/us/loading.tsx')],
    empty: [{ file: 'app/us/trade/workbench/page.tsx', patterns: [/data\.candidates\.length === 0/, /条件を満たすUS候補はありません/] }],
    error: [{ file: 'app/us/trade/workbench/page.tsx', patterns: [/role="alert"/, /Servingデータを利用できません/] }],
    sharedBoundary: [{ file: 'app/us/trade/workbench/page.tsx', patterns: [/await getUsTradeWorkbench\(/] }],
  },
  {
    id: 'ma25m-monitor',
    path: '/us/ma25m-monitor',
    pages: ['app/us/ma25m-monitor/page.tsx'],
    loading: [{ file: 'app/us/ma25m-monitor/page.tsx', patterns: [/role="status"/, /米国株の月足MAを読み込んでいます…/] }],
    empty: [{ file: 'app/us/ma25m-monitor/page.tsx', patterns: [/rows\.length === 0/, /該当銘柄はありません/] }],
    error: [{ file: 'app/us/ma25m-monitor/page.tsx', patterns: [/role="alert"/, /米国株MAデータを読み込めませんでした/] }],
    sharedBoundary: [],
  },
  {
    id: 'stage-screener',
    path: '/us/stage-screener',
    pages: ['app/us/stage-screener/page.tsx'],
    loading: [
      { file: 'app/us/stage-screener/page.tsx', patterns: [/<Suspense fallback=\{<LoadingStageMap \/>\}>/, /role="status"/] },
      { file: 'components/hex/HexStageMapView.tsx', patterns: [/\{loading && \(\s*<div role="status" aria-live="polite" aria-busy="true"[^>]*>\s*読み込み中…/] },
    ],
    empty: [{ file: 'components/hex/HexStageMapView.tsx', patterns: [/!loading && !error && filteredData\.length === 0/, /該当する銘柄がありません/] }],
    error: [{
      file: 'components/hex/HexStageMapView.tsx',
      patterns: [
        /\{error && !loading && \(\s*<div[^>]*>\s*<p role="alert"[^>]*>トレンドステージマップを取得できませんでした。時間をおいて再読み込みしてください。<\/p>\s*<button type="button" onClick=\{\(\) => setRetryVersion\(\(value\) => value \+ 1\)\}/,
        // 再試行は同じ条件の取得 effect を 1 回だけ再実行する
        /const \[retryVersion, setRetryVersion\] = useState\(0\)/,
        /\}, \[timeframe, selectedDate, activeUniverse, isUs, retryVersion\]\)/,
        // 読み込み中・失敗中は件数を「—」と状態ラベルで置き、0 や前回値を見せない
        /const countsReady = !loading && !error/,
        /const countText = \(n: number\) => \(countsReady \? n\.toLocaleString\(\) : '—'\)/,
        /\{!countsReady \? \(loading \? '件数を確認中' : '件数を取得できませんでした'\) :/,
        />\{countText\(count\)\}<\/span>/,
        /\{!countsReady \? '—' : avg == null \? '-' : avg\.toFixed\(2\)\}/,
        />\{countText\(unclassifiedCount\)\}<\/span>/,
        /\{countsReady \? '価格・履歴を更新中' : loading \? '確認中' : '取得失敗'\}/,
        /全投資対象（\{countText\(data\.length\)\}）[\s\S]*全投資対象（\{countText\(data\.length\)\}）/,
      ],
    }],
    sharedBoundary: [],
    // error state は失敗の有無にだけ使い、中身 (API 文言・decode 例外) は描画しない (JP と共有部品)。
    // 件数は countText を通す (生の数値を直接描画すると読み込み中・失敗中に 0 が出る)
    forbidden: [{
      file: 'components/hex/HexStageMapView.tsx',
      patterns: [
        /\{error\}/, /エラー: \{/, /\{String\(error/,
        />\{count\.toLocaleString\(\)\}</, />\{unclassifiedCount\}</, /全投資対象（\{data\.length\}）/, /（\{count\}）/, /（\{n\}）/,
        /\?\? 0\}）/,
      ],
    }],
  },
  {
    id: 'transitions',
    path: '/us/analysis/transitions',
    pages: ['app/us/analysis/transitions/page.tsx'],
    loading: [{ file: 'components/hex/StageTransitionScanner.tsx', patterns: [/role="status" aria-live="polite" aria-busy="true"/] }],
    empty: [
      { file: 'app/us/analysis/transitions/page.tsx', patterns: [/現在の6軸パターンはまだ生成されていません/, /USパターン統計を生成中です/] },
      { file: 'components/hex/StageTransitionScanner.tsx', patterns: [/<EmptyState outOfRange=/] },
    ],
    error: [{ file: 'components/hex/StageTransitionScanner.tsx', patterns: [/role="alert"/, /検索できませんでした/] }],
    sharedBoundary: [{ file: 'app/us/analysis/transitions/page.tsx', patterns: [/const analysis = await loadUsTransitionAnalysis\(\)/] }],
  },
  {
    id: 'backtest',
    path: '/us/analysis/backtest',
    pages: ['app/us/analysis/backtest/page.tsx'],
    loading: [{ file: 'components/us/backtest/UsBacktestResults.tsx', patterns: [/aria-busy=\{loading\}/, /'更新中…'/] }],
    empty: [
      { file: 'components/us/backtest/UsBacktestExplorer.tsx', patterns: [/営業日の検証結果はまだありません/] },
      { file: 'app/us/analysis/backtest/page.tsx', patterns: [/function EmptyRow/, /価格基準日以前のUSモデル評価を生成中です/] },
    ],
    error: [
      { file: 'components/us/backtest/UsBacktestExplorer.tsx', patterns: [/role="alert"/, /基準日の一覧を取得できませんでした/] },
      { file: 'components/us/backtest/UsBacktestResults.tsx', patterns: [/role="alert"/] },
    ],
    sharedBoundary: [{ file: 'app/us/analysis/backtest/page.tsx', patterns: [/const analysis = await loadUsBacktestAnalysis\(\)/] }],
  },
  {
    id: 'market-momentum',
    path: '/us/market-momentum',
    pages: ['app/us/market-momentum/page.tsx'],
    loading: [routeSkeleton('app/us/market-momentum/loading.tsx')],
    empty: [{ file: 'app/us/market-momentum/page.tsx', patterns: [/if \(!data\.date\)/, /米国株の PMS データがまだありません/] }],
    error: [{ file: 'app/us/market-momentum/page.tsx', patterns: [/loadFailed = true/, /role="alert"/, /米国株モメンタムを読み込めませんでした/] }],
    sharedBoundary: [],
  },
  {
    id: 'sectors',
    path: '/us/sectors',
    pages: ['app/us/sectors/page.tsx'],
    loading: [routeSkeleton('app/us/sectors/loading.tsx')],
    empty: [{ file: 'app/us/sectors/page.tsx', patterns: [/米国株のセクター集計に使うデータがまだありません/, /<UsSectorPitUnavailable /, /SEC SIC 分類のある銘柄がありません/] }],
    error: [{ file: 'app/us/sectors/page.tsx', patterns: [/loadFailed = true/, /role="alert"/, /米国株セクターを読み込めませんでした/] }],
    sharedBoundary: [],
  },
  {
    id: 'trigger-discovery',
    path: '/us/trigger-discovery',
    pages: ['app/us/trigger-discovery/page.tsx'],
    loading: [
      routeSkeleton('app/us/trigger-discovery/loading.tsx'),
      { file: 'app/us/trigger-discovery/UsTriggerDiscoveryClient.tsx', patterns: [/aria-busy=\{loading\}/, /'検索しています'/] },
    ],
    empty: [{ file: 'app/us/trigger-discovery/page.tsx', patterns: [/if \(!options\.latestAsOf\)/, /米国株の価格データがまだありません/] }],
    error: [
      { file: 'app/us/trigger-discovery/page.tsx', patterns: [/role="alert"/, /US条件トリガーを準備できませんでした/] },
      { file: 'app/us/trigger-discovery/UsTriggerDiscoveryClient.tsx', patterns: [/<Notice tone="error" role="alert" title="検索できませんでした">/] },
    ],
    sharedBoundary: [],
  },
  {
    id: 'mtf-close-calendar',
    path: '/us/mtf-close-calendar',
    pages: ['app/us/mtf-close-calendar/page.tsx'],
    loading: [{ file: 'app/mtf-close-calendar/MtfCloseCalendarClient.tsx', patterns: [/aria-busy=\{loading\}/] }],
    // 実データ範囲外は休日ルールだけで求めた予定日であることを明示する (未確認を確定値として見せない)
    empty: [{ file: 'app/mtf-close-calendar/MtfCloseCalendarClient.tsx', patterns: [/rulesOnly && !error/, /copy\.rulesOnlyNotice/] }],
    error: [{
      file: 'app/mtf-close-calendar/MtfCloseCalendarClient.tsx',
      patterns: [
        /const \[error, setError\] = useState\(false\)/,
        /\{error && \(\s*<div[^>]*>\s*<p role="alert"[^>]*>カレンダーを取得できませんでした。再読み込みしてください。<\/p>\s*<button\s+type="button"\s+onClick=\{\(\) => setRequestVersion\(\(value\) => value \+ 1\)\}/,
        /再読み込み\s*<\/button>/,
        /\{error \? null : \(/,
        /\}, \[loadCalendar, requestVersion\]\)/,
        // 読み込み中・失敗中は該当日数を 0営業日と見せない
        /条件に該当 \{loading \? '確認中' : error \? '取得失敗' : `\$\{matchingDays\}営業日`\}/,
      ],
    }],
    sharedBoundary: [],
    // JP と共有部品。失敗の有無だけを持ち、API の message・例外文は描画しない
    forbidden: [{
      file: 'app/mtf-close-calendar/MtfCloseCalendarClient.tsx',
      patterns: [/\{error\}/, /loadError\.message/, /payload\.message/, /条件に該当 \{matchingDays\}営業日/],
    }],
  },
  {
    id: 'ai-lens',
    path: '/us/analysis/ml-lens',
    pages: ['app/us/analysis/ml-lens/page.tsx'],
    loading: [routeSkeleton('app/us/loading.tsx')],
    empty: [
      { file: 'app/us/analysis/ml-lens/page.tsx', patterns: [/value \?\? '未生成'/] },
      { file: 'components/ml/PhysicsMlCandidatesPanel.tsx', patterns: [/候補はまだ生成されていません/] },
    ],
    error: [],
    sharedBoundary: [{ file: 'app/us/analysis/ml-lens/page.tsx', patterns: [/await Promise\.all\(\[\s*loadUsAnalysisStatus\(\)/] }],
  },
  {
    id: 'stock-overview',
    path: '/us/stock/AAPL',
    pages: [STOCK_PAGE],
    loading: [
      routeSkeleton(STOCK_LOADING),
      { file: STOCK_CLIENT, patterns: [/status === 'loading' \|\| status === 'idle'/] },
      { file: 'components/us/stock-detail/UsOverviewWorkspace.tsx', patterns: [/6ステージを読み込み中/] },
    ],
    // quote が null (日次データ未取得) は正当な「データなし」。page は固定文言だけを渡し、
    // initialQuote / initialError のどちらかを必ず渡すため、client 側の再取得 (API message を出しうる経路) は通らない。
    // getUsQuote の例外は握りつぶさず app/us/error.tsx が受ける (sharedBoundary)
    empty: [
      {
        file: STOCK_PAGE,
        patterns: [/initialQuote=\{quote\}/, /initialError=\{quote \? null : `\$\{normalized\} のUS価格データはまだ取得されていません。`\}/],
      },
      { file: STOCK_CLIENT, patterns: [/if \(initialQuote \|\| initialError\) return/, /の米国株データが見つかりません。/] },
      { file: 'components/us/stock-detail/UsOverviewWorkspace.tsx', patterns: [/この日付までの6ステージデータがありません。/, /'未取得'/] },
    ],
    error: [{ file: 'components/us/stock-detail/UsOverviewWorkspace.tsx', patterns: [/momentum\.status === 'error'/, /MA力場を取得できませんでした/] }],
    sharedBoundary: [{ file: STOCK_PAGE, patterns: [/await Promise\.all\(\[\s*getUsQuote\(normalized\)/] }],
  },
  {
    id: 'stock-fundamentals',
    path: '/us/stock/AAPL#fundamental',
    pages: [STOCK_PAGE],
    loading: [{ file: 'components/us/stock-detail/UsFundamentalsWorkspace.tsx', patterns: [/remote\.status === 'loading' && <LoadingBlock/] }],
    empty: [{ file: 'components/us/stock-detail/UsFundamentalsWorkspace.tsx', patterns: [/財務fact未取得/, /基準日までに SEC Companyfacts のFY売上高実績がありません。/] }],
    error: [
      { file: 'components/us/stock-detail/UsFundamentalsWorkspace.tsx', patterns: [/<ErrorBlock label="米国株ファンダメンタルを取得できませんでした。" onRetry=/] },
      { file: 'components/stock/fundamentals/primitives.tsx', patterns: [/export function ErrorBlock[\s\S]{0,120}role="alert"/] },
    ],
    sharedBoundary: [{ file: STOCK_PAGE, patterns: [/await Promise\.all\(\[\s*getUsQuote\(normalized\)/] }],
  },
  {
    id: 'stock-chart',
    path: '/us/stock/AAPL#chart',
    pages: [STOCK_PAGE],
    loading: [{ file: 'components/us/stock-detail/UsChartWorkspace.tsx', patterns: [/'6ステージを読み込み中'/, /'MAの角度を読み込み中'/] }],
    empty: [{ file: 'components/us/stock-detail/UsChartWorkspace.tsx', patterns: [/'6ステージの履歴がありません'/, /'未算出'/] }],
    error: [{ file: 'components/us/stock-detail/UsChartWorkspace.tsx', patterns: [/stage\.status === 'error'/, /6ステージを取得できませんでした/] }],
    sharedBoundary: [{ file: STOCK_PAGE, patterns: [/await Promise\.all\(\[\s*getUsQuote\(normalized\)/] }],
  },
]

// ソース契約と静的レンダリングでは確かめられず、ブラウザでの失敗注入で確認する項目
const BROWSER_ONLY_CHECKS = [
  'shared boundary: 実際の未捕捉例外で app/us/error.tsx が表示され、再試行で再取得されること・フォーカスが見えること',
  'shared boundary: ブラウザのコンソールに例外文・スタックが出ないこと (React/Next 自体の開発時ログを除く本番ビルドで確認)',
  'screener / stage map / MTF calendar: API 遮断時に alert が読み上げられ、空表示と同時に出ないこと (1440px / 390px)',
  'stage map / MTF calendar: API 遮断時に alert が 390px でもスクロールせずに見え、画面上部に件数 0 が出ないこと',
  'screener: API 遮断時に alert が開いた条件パネルより上にあり、「最新データ」バッジと並ばないこと',
  'screener / stage map / MTF calendar: 再試行 1 回で同じ URL のリクエストがちょうど 1 回出ること',
  'screener 空の日付: 読み込み表示が消え、空の説明文が実際に描画された最終状態で確認すること',
]

/* ---------- 1. 棚卸し ---------- */

assert.equal(ENTRYPOINTS.length, 20, 'US parity tracks exactly 20 route entrypoints')
assert.equal(new Set(ENTRYPOINTS.map((entry) => entry.id)).size, 20, 'entrypoint ids must be unique')

function listPages(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((dirent) => {
    const rel = `${dir}/${dirent.name}`
    if (dirent.isDirectory()) return listPages(rel)
    return dirent.name === 'page.tsx' ? [rel] : []
  })
}

const actualPages = listPages('app/us').sort()
const inventoriedPages = [...new Set(ENTRYPOINTS.flatMap((entry) => entry.pages))].sort()
assert.deepEqual(
  actualPages,
  inventoriedPages,
  'every app/us page.tsx must be inventoried here; add new US routes to ENTRYPOINTS with their state contracts',
)

/* ---------- 2. 共有 Loading / Error Boundary ---------- */

assert.ok(exists('app/us/loading.tsx'), 'app/us must keep a subtree loading boundary')
assert.match(read('app/us/loading.tsx'), /<PageLoadingSkeleton /)
const skeleton = read('components/ui/PageLoadingSkeleton.tsx')
assert.match(skeleton, /role="status" aria-live="polite" aria-busy="true"/, 'loading skeleton must announce a busy status')

assert.ok(exists('app/us/error.tsx'), 'app/us must have a shared error boundary')
// error.tsx は同じ segment の layout を包まない。US 専用 layout を足すなら、その失敗の受け先を見直す
assert.ok(!exists('app/us/layout.tsx'), 'app/us/layout.tsx would sit outside app/us/error.tsx; revisit the boundary before adding one')

function listErrorBoundaries(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((dirent) => {
    const rel = `${dir}/${dirent.name}`
    if (dirent.isDirectory()) return listErrorBoundaries(rel)
    return /^error\.(tsx|ts|jsx|js)$/.test(dirent.name) ? [rel] : []
  })
}

const FORBIDDEN_IN_BOUNDARY: Array<[RegExp, string]> = [
  [/error\.message/, 'must not read the raw exception message'],
  [/error\.stack/, 'must not read the stack trace'],
  [/error\.cause/, 'must not read the error cause'],
  [/String\(error\)|JSON\.stringify\(error|`\$\{error/, 'must not stringify the error'],
  [/\{error\}/, 'must not render the error object'],
  [/process\.env/, 'must not branch on environment configuration'],
  [/searchParams|useSearchParams|location\.(search|hash)/, 'must not read query/hash test switches'],
  [/dangerouslySetInnerHTML/, 'must not inject HTML'],
  [/console\.\w+\(\s*error\b/, 'must not log the exception object'],
]

for (const file of listErrorBoundaries('app/us')) {
  const source = read(file)
  assert.match(source, /^'use client'/, `${file} must be a Client Component`)
  for (const [pattern, reason] of FORBIDDEN_IN_BOUNDARY) assert.doesNotMatch(source, pattern, `${file} ${reason}`)
}

const boundary = read('app/us/error.tsx')
assert.match(boundary, /export default function \w+\(\{\s*error,\s*retry,\s*\}/, 'boundary must use the Next 16 retry() prop')
assert.match(boundary, /<UsRouteErrorState digest=\{error\.digest\} onRetry=\{\(\) => retry\(\)\} \/>/, 'boundary must pass only the digest and a retry action')
assert.doesNotMatch(boundary, /\breset\(/, 'boundary must retry (re-fetch), not reset without re-fetching')
assert.match(
  boundary,
  /useEffect\(\(\) => \{\s*logUsRouteError\(error\.digest\)\s*\}, \[error\.digest\]\)/,
  'boundary must log only through logUsRouteError(error.digest)',
)
assert.doesNotMatch(boundary, /console\./, 'boundary must not write the exception to the browser console directly')

const errorStateSource = read('components/us/UsRouteErrorState.tsx')
assert.match(errorStateSource, /digest\?: string \| null\s*onRetry: \(\) => void/, 'presentational state must not accept the error object')
for (const [pattern, reason] of FORBIDDEN_IN_BOUNDARY) {
  assert.doesNotMatch(errorStateSource, pattern, `UsRouteErrorState ${reason}`)
}
assert.doesNotMatch(errorStateSource, /<Link|href=/, 'error state offers only the retry action')
assert.equal((errorStateSource.match(/console\.\w+\(/g) ?? []).length, 1, 'only logUsRouteError writes to the console')
assert.match(errorStateSource, /console\.error\('\[us-route-error\]', safeErrorDigest\(digest\) \?\? 'no-digest'\)/)

/* ---------- 3. 共有 Error 表示の静的レンダリング ---------- */

const SECRET = 'DO_NOT_RENDER_SENTINEL /Users/ops/data/stockboard.db SQLITE_BUSY'
let retried = 0
const thrown = Object.assign(new Error(SECRET), { digest: '2817460391' })
thrown.stack = `Error: ${SECRET}\n    at loadUsDashboard (lib/server/us.ts:1:1)`
const html = renderToStaticMarkup(createElement(UsError, { error: thrown, retry: () => { retried += 1 } }))

assert.doesNotMatch(html, /DO_NOT_RENDER_SENTINEL|stockboard\.db|SQLITE_BUSY|loadUsDashboard/, 'boundary must not render raw exception text')
assert.match(html, /data-us-route-state="error"/)
assert.match(html, /<h1>画面を表示できませんでした<\/h1>/, 'error replaces the page title with one h1')
assert.match(html, /<div role="alert"[^>]*>/, 'error message must be announced as an alert')
assert.match(html, /<button type="button"[^>]*>.*再試行<\/button>/, 'retry must be a native keyboard-operable button')
assert.equal((html.match(/<button\b/g) ?? []).length, 1, 'exactly one action is offered')
assert.doesNotMatch(html, /<a\b/, 'error state must not navigate away (JP or otherwise)')
assert.match(html, /エラーID 2817460391/, 'a safe digest is shown for log correlation')
assert.match(html, /米国株/)
assert.match(html, /lucide-triangle-alert/, 'error uses the warning icon, not the empty-search icon')
assert.doesNotMatch(html, /lucide-search-x/)
assert.doesNotMatch(html, /aria-busy/, 'error is not a loading state')
assert.equal(retried, 0, 'rendering must not trigger a retry')

for (const unsafe of ['', 'has space', '<script>alert(1)</script>', 'a'.repeat(65), SECRET]) {
  assert.equal(safeErrorDigest(unsafe), null, `unsafe digest must be hidden: ${unsafe.slice(0, 20)}`)
  const unsafeHtml = renderToStaticMarkup(createElement(UsRouteErrorState, { digest: unsafe, onRetry: () => {} }))
  assert.doesNotMatch(unsafeHtml, /エラーID/, 'unsafe digest must not be rendered')
}
assert.equal(safeErrorDigest(undefined), null)
assert.equal(safeErrorDigest(12345), null)
assert.equal(safeErrorDigest('NEXT_digest-01'), 'NEXT_digest-01')
assert.doesNotMatch(renderToStaticMarkup(createElement(UsRouteErrorState, { onRetry: () => {} })), /エラーID/, 'client errors without a digest show no ID')

// コンソールへは固定ラベルと安全な digest だけ
const logged: unknown[][] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => { logged.push(args) }
try {
  logUsRouteError('2817460391')
  logUsRouteError(SECRET)
  logUsRouteError(undefined)
  logUsRouteError(thrown)
} finally {
  console.error = originalConsoleError
}
assert.deepEqual(logged, [
  ['[us-route-error]', '2817460391'],
  ['[us-route-error]', 'no-digest'],
  ['[us-route-error]', 'no-digest'],
  ['[us-route-error]', 'no-digest'],
], 'console logging must carry only a fixed label and a safe digest')

function findButtons(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, out)
    return out
  }
  if (!isValidElement(node)) return out
  if (node.type === 'button') out.push(node)
  for (const value of Object.values(node.props as Record<string, unknown>)) findButtons(value, out)
  return out
}

let stateRetried = 0
const buttons = findButtons(UsRouteErrorState({ digest: null, onRetry: () => { stateRetried += 1 } }))
assert.equal(buttons.length, 1, 'error state exposes one action')
;(buttons[0].props as { onClick: () => void }).onClick()
assert.equal(stateRetried, 1, 'the action calls retry exactly once')

// Empty は alert ではない。Error と同じ見た目の部品でも semantics で区別する
const emptyHtml = renderToStaticMarkup(createElement(EmptyState, { title: '該当なし' }))
assert.doesNotMatch(emptyHtml, /role="alert"/, 'empty state must not be announced as an error')
assert.match(emptyHtml, /lucide-search-x/)

/* ---------- 4. 入口ごとの Loading / Empty / Error ---------- */

function checkContracts(entry: Entry, kind: 'loading' | 'empty' | 'error' | 'sharedBoundary') {
  for (const contract of entry[kind]) {
    assert.ok(exists(contract.file), `${entry.id}: missing ${contract.file}`)
    const source = read(contract.file)
    for (const pattern of contract.patterns) {
      assert.match(source, pattern, `${entry.id} ${kind}: ${contract.file} must contain ${pattern}`)
    }
  }
}

for (const entry of ENTRYPOINTS) {
  for (const page of entry.pages) assert.ok(exists(page), `${entry.id}: missing ${page}`)
  assert.ok(entry.loading.length > 0, `${entry.id}: loading state must be declared`)
  assert.ok(entry.empty.length > 0, `${entry.id}: empty/unavailable state must be declared`)
  assert.ok(
    entry.error.length + entry.sharedBoundary.length > 0,
    `${entry.id}: failures must be handled on screen or delegated to app/us/error.tsx`,
  )
  for (const kind of ['loading', 'empty', 'error', 'sharedBoundary'] as const) checkContracts(entry, kind)
  for (const contract of entry.forbidden ?? []) {
    const source = read(contract.file)
    for (const pattern of contract.patterns) {
      assert.doesNotMatch(source, pattern, `${entry.id}: ${contract.file} must not render raw failure text (${pattern})`)
    }
  }
  // 共有 Boundary に委ねる箇所は、その読み込みを握りつぶして空表示にしていないこと
  for (const contract of entry.sharedBoundary) {
    const source = read(contract.file)
    for (const pattern of contract.patterns) {
      const match = source.match(pattern)
      assert.ok(match, `${entry.id}: delegated load not found`)
      const after = source.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 200)
      assert.doesNotMatch(after, /^[^;\n]*\.catch\(/, `${entry.id}: delegated load must not be swallowed`)
    }
  }
}

/* ---------- 5. 失敗表示の位置 (390px でスクロールせずに見える順序) ---------- */

function assertBefore(file: string, first: RegExp | string, second: RegExp | string, reason: string) {
  const source = read(file)
  const indexOf = (pattern: RegExp | string) => (typeof pattern === 'string' ? source.indexOf(pattern) : source.search(pattern))
  const a = indexOf(first)
  const b = indexOf(second)
  assert.ok(a >= 0, `${file}: ${first} not found`)
  assert.ok(b >= 0, `${file}: ${second} not found`)
  assert.ok(a < b, `${file}: ${reason}`)
}

const HEX = 'components/hex/HexStageMapView.tsx'
assertBefore(HEX, '{error && !loading && (', '{stageMomentumStats.map(', 'stage map alert must render above the Stage summary grid')
assertBefore(HEX, '<h2>トレンドステージマップ</h2>', '{error && !loading && (', 'stage map alert sits right under the heading/count')
assert.equal((read(HEX).match(/role="alert"/g) ?? []).length, 1, 'stage map shows the failure in exactly one place')

const MTF = 'app/mtf-close-calendar/MtfCloseCalendarClient.tsx'
assertBefore(MTF, /条件に該当 \{loading/, '{error && (', 'MTF alert follows the month header')
assertBefore(MTF, '{error && (', 'aria-label="同時に確定する本数で絞り込み"', 'MTF alert must render above the filter rows')
assert.equal((read(MTF).match(/role="alert"/g) ?? []).length, 1, 'MTF calendar shows the failure in exactly one place')

const SCREENER = 'app/us/screener/UsScreenerClient.tsx'
assertBefore(SCREENER, "loading ? '検索中…' : fetchError ? '取得失敗'", '{fetchError && (', 'screener alert follows the result status')
assertBefore(SCREENER, '{fetchError && (', '{filtersOpen && (', 'screener alert must render above the expanded filter panel')
assertBefore(SCREENER, '{fetchError && (', '<table', 'screener alert must render outside/above the scrolling table')
assert.equal((read(SCREENER).match(/role="alert"/g) ?? []).length, 2, 'screener keeps unavailable-date and fetch failures as two distinct, mutually exclusive alert states')

// 欠損は 0 ではない: 代表的な欠損表記がゼロ埋めに置き換わっていないこと
assert.match(read('app/us/analysis/backtest/page.tsx'), /if \(value == null\) return '-'/)
assert.match(read('app/us/analysis/transitions/page.tsx'), /if \(value == null\) return '-'/)
assert.match(read(STOCK_CLIENT), /Number\.NaN preserves "unavailable"/)

const delegated = ENTRYPOINTS.filter((entry) => entry.sharedBoundary.length > 0).map((entry) => entry.id)
const boundaryOnly = ENTRYPOINTS.filter((entry) => entry.error.length === 0).map((entry) => entry.id)
console.log(`US route state contracts passed: ${ENTRYPOINTS.length} entrypoints, ${actualPages.length} page files`)
console.log(`Shared error boundary receives uncaught loads from: ${delegated.join(', ')}`)
console.log(`Error handled only by the shared boundary: ${boundaryOnly.join(', ') || 'none'}`)
console.log('Companion browser audit contracts:')
for (const check of BROWSER_ONLY_CHECKS) console.log(`  - ${check}`)
