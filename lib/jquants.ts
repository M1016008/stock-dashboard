// lib/jquants.ts
//
// J-Quants API v2 クライアント (Phase 3 で OHLCV を Yahoo Finance から置換するため)。
//
// v2 認証: 単純な API キー方式。ダッシュボードで発行したキーを x-api-key ヘッダに渡すだけ。
// (v1 の refresh token / id token フローは廃止)
//
// 環境変数 (.env.local):
//   JQUANTS_API_KEY    ダッシュボードから発行
//
// 公式仕様: https://jpx-jquants.com/ja/spec/eq-bars-daily

import type { OHLCV } from '@/types/stock'

const BASE_URL = 'https://api.jquants.com/v2'

function getApiKey(): string {
  const key = process.env.JQUANTS_API_KEY
  if (!key) {
    throw new Error('JQUANTS_API_KEY が未設定です。.env.local に追加してください。J-Quants ダッシュボードから発行できます。')
  }
  return key
}

// ─────────────────────────────────────
// ティッカー記号の正規化
// ─────────────────────────────────────

/**
 * J-Quants v2 は 4 桁 or 5 桁コード両対応。
 * - 4 桁指定: 普通株式のみ取得 (推奨、よくある用途)
 * - 5 桁指定: 優先株や種類株式も含む
 *
 * `.T` サフィックス (Yahoo 形式) は除去する。
 */
export function toJQuantsCode(ticker: string): string {
  return ticker.replace(/\.T$/i, '')
}

// ─────────────────────────────────────
// API: 日足 OHLCV (/equities/bars/daily)
// ─────────────────────────────────────

interface JBarRow {
  Date: string         // "2023-03-24"
  Code: string         // 5桁、例 "86970"
  O: number | null     // open
  H: number | null     // high
  L: number | null     // low
  C: number | null     // close
  UL: number | null    // upper limit (ストップ高)
  LL: number | null    // lower limit (ストップ安)
  Vo: number | null    // volume
  Va: number | null    // value (売買代金)
  AdjFactor: number | null
  AdjO: number | null  // 調整後 open
  AdjH: number | null
  AdjL: number | null
  AdjC: number | null
  AdjVo: number | null
}

interface JBarsResponse {
  data: JBarRow[]
  pagination_key?: string
}

/**
 * 指定銘柄の日足 OHLCV を J-Quants v2 から取得する。
 * - 調整後価格 (AdjO/H/L/C) を優先 (株式分割の影響を吸収)
 * - 期間指定なしの場合、契約プランで取得可能な全期間 (Standard 以上で 2008-)
 *
 * @param ticker  "7203" (.T は内部で除去、4 桁ベースをそのまま使う)
 * @param from    取得開始日 (YYYY-MM-DD 形式、含む)、省略時は最古
 * @param to      取得終了日 (YYYY-MM-DD 形式、含む)、省略時は最新
 */
export async function fetchJQuantsDaily(
  ticker: string,
  from?: string,
  to?: string,
): Promise<OHLCV[]> {
  const code = toJQuantsCode(ticker)
  const apiKey = getApiKey()

  const params = new URLSearchParams({ code })
  if (from) params.set('from', from)  // v2 は ISO 形式そのまま受ける
  if (to)   params.set('to', to)

  const all: JBarRow[] = []
  let paginationKey: string | undefined

  do {
    const url = `${BASE_URL}/equities/bars/daily?${params.toString()}${paginationKey ? `&pagination_key=${encodeURIComponent(paginationKey)}` : ''}`
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`J-Quants bars/daily 失敗 (${ticker}): ${res.status} ${txt.slice(0, 300)}`)
    }
    const json = await res.json() as JBarsResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)

  // OHLCV 型に変換。Adj* (株式分割調整済) を優先、なければ raw を使う
  return all
    .filter(r => r.AdjC != null || r.C != null)
    .map(r => {
      const close = r.AdjC ?? r.C!
      const open  = r.AdjO ?? r.O ?? close
      const high  = r.AdjH ?? r.H ?? close
      const low   = r.AdjL ?? r.L ?? close
      const vol   = r.AdjVo ?? r.Vo ?? 0
      return {
        date:   r.Date,
        open,
        high,
        low,
        close,
        volume: Math.round(vol),
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ─────────────────────────────────────
// API: 上場銘柄一覧 (/equities/master)
// v2 仕様のフィールド名: CoName, S17, S17Nm, S33, S33Nm, ScaleCat, Mkt, MktNm, Mrgn, MrgnNm
// ─────────────────────────────────────

export interface JListedInfoRow {
  Date: string
  Code: string
  CoName: string             // 銘柄名
  CoNameEn?: string          // 英語銘柄名
  S17?: string               // 17 業種コード
  S17Nm?: string             // 17 業種名 (例: 自動車・輸送機)
  S33?: string               // 33 業種コード
  S33Nm?: string             // 33 業種名 (例: 輸送用機器)
  ScaleCat?: string          // 規模区分 (例: TOPIX Core30)
  Mkt?: string               // 市場コード
  MktNm?: string             // 市場名 (例: プライム)
  Mrgn?: string              // 信用区分コード
  MrgnNm?: string            // 信用区分名 (例: 貸借)
}

interface JListedInfoResponse {
  data?: JListedInfoRow[]
  pagination_key?: string
}

/**
 * 上場銘柄一覧。code を指定すれば 1 銘柄、省略すれば全銘柄。
 * 全件取得時はページネーションで自動連結。
 */
export async function fetchJQuantsListedInfo(ticker?: string): Promise<JListedInfoRow[]> {
  const apiKey = getApiKey()

  const all: JListedInfoRow[] = []
  let paginationKey: string | undefined

  do {
    const params = new URLSearchParams()
    if (ticker) params.set('code', toJQuantsCode(ticker))
    if (paginationKey) params.set('pagination_key', paginationKey)
    const url = `${BASE_URL}/equities/master${params.size > 0 ? `?${params}` : ''}`

    const res = await fetch(url, { headers: { 'x-api-key': apiKey } })
    if (!res.ok) {
      throw new Error(`J-Quants equities/master 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JListedInfoResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)

  return all
}

// ─────────────────────────────────────
// API: 財務サマリ (/fins/summary) — Premium プラン
// ─────────────────────────────────────

export interface JFinsSummaryRow {
  DiscDate: string           // 開示日 "2024-05-08"
  DiscTime: string           // 開示時刻
  Code: string               // 5 桁コード
  DiscNo: string             // 開示番号
  DocType: string            // 例: "1QFinancialStatements_Consolidated_US"
  CurPerType: string         // "1Q" | "2Q" | "3Q" | "FY" | "Other"
  CurPerSt: string           // 当期会計期間開始日
  CurPerEn: string           // 当期会計期間終了日
  CurFYSt: string            // 当期会計年度開始日
  CurFYEn: string            // 当期会計年度終了日
  Sales: string              // 売上 (空文字あり)
  OP: string                 // 営業利益
  NP: string                 // 純利益
  EPS: string                // 1株あたり純利益
  DEPS: string               // 潜在株式調整後 1 株純利益
  TA: string                 // 総資産
  Eq: string                 // 自己資本
  EqAR: string               // 自己資本比率
  BPS: string                // 1株あたり純資産
  Div1Q: string              // 期別配当
  Div2Q: string
  Div3Q: string
  DivFY: string              // 期末配当
  DivAnn: string             // 年間配当
  FDivAnn: string            // 予想年間配当
  PayoutRatioAnn: string     // 配当性向
  ShOutFY: string            // 期末発行済株式数
  TrShFY: string             // 期末自己株式数
  AvgSh: string              // 期中平均株式数
  // ほか多数フィールドあり (連結/非連結別など、必要に応じて追加)
}

interface JFinsSummaryResponse {
  data?: JFinsSummaryRow[]
  pagination_key?: string
}

/**
 * 財務サマリを開示日の昇順で全部取得 (古い分から最新まで)。
 * 1 銘柄あたり数十件 (各四半期 + 通期)、ページネーションは少銘柄では不要だが念のため対応。
 */
export async function fetchJQuantsFinsSummary(ticker: string): Promise<JFinsSummaryRow[]> {
  const code = toJQuantsCode(ticker)
  const apiKey = getApiKey()

  const all: JFinsSummaryRow[] = []
  let paginationKey: string | undefined

  do {
    const params = new URLSearchParams({ code })
    if (paginationKey) params.set('pagination_key', paginationKey)
    const url = `${BASE_URL}/fins/summary?${params.toString()}`
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } })
    if (!res.ok) {
      throw new Error(`J-Quants fins/summary 失敗 (${ticker}): ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JFinsSummaryResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)

  return all
}

// ─────────────────────────────────────
// 派生: PER / PBR / ROE / 配当利回り を計算して返す
// ─────────────────────────────────────

export interface FundamentalsResult {
  per?: number           // current_price / EPS_annual
  pbr?: number           // current_price / BPS
  roe?: number           // NP / Eq * 100  (%)
  dividendYield?: number // DivAnn / current_price * 100  (%)
  eps?: number           // 1 株純利益 (円)
  bps?: number           // 1 株純資産 (円)
  netProfit?: number     // 純利益 (円)
  equity?: number        // 自己資本 (円)
  sharesOutstanding?: number  // 期末発行済株式数
  // 引いた財務レコードのメタ
  source_disc_date?: string   // 元になった開示日
  source_period?: string      // 元になった期 (CurPerType)
}

/**
 * 財務サマリ + 現在価格から PER/PBR/ROE/配当利回りを計算。
 * - 通期 (FY) の最新レコードを優先、なければ直近の四半期を使う。
 * - 値が空欄のフィールドは undefined にする。
 */
export function computeFundamentals(
  rows: JFinsSummaryRow[],
  currentPrice: number | null,
): FundamentalsResult {
  if (rows.length === 0) return {}

  // 開示日降順にソート、FY (通期) を優先
  const sorted = [...rows].sort((a, b) => {
    const t = b.DiscDate.localeCompare(a.DiscDate)
    if (t !== 0) return t
    // 同じ日付なら CurPerType を FY 優先
    return (b.CurPerType === 'FY' ? 1 : 0) - (a.CurPerType === 'FY' ? 1 : 0)
  })

  // 通期があれば優先、なければ最新のレコード
  const fyRow = sorted.find(r => r.CurPerType === 'FY')
  const latest = fyRow ?? sorted[0]
  if (!latest) return {}

  const num = (s: string | undefined): number | undefined => {
    if (s == null || s === '') return undefined
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : undefined
  }

  const eps      = num(latest.EPS)
  const bps      = num(latest.BPS)
  const np       = num(latest.NP)
  const eq       = num(latest.Eq)
  const divAnn   = num(latest.DivAnn) ?? num(latest.FDivAnn)
  const shOut    = num(latest.ShOutFY)

  const result: FundamentalsResult = {
    eps,
    bps,
    netProfit: np,
    equity: eq,
    sharesOutstanding: shOut,
    source_disc_date: latest.DiscDate,
    source_period: latest.CurPerType,
  }

  if (currentPrice != null && currentPrice > 0) {
    if (eps != null && eps > 0)    result.per = currentPrice / eps
    if (bps != null && bps > 0)    result.pbr = currentPrice / bps
    if (divAnn != null)            result.dividendYield = (divAnn / currentPrice) * 100
  }

  if (np != null && eq != null && eq > 0) {
    result.roe = (np / eq) * 100
  }

  return result
}
