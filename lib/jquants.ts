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
// API: 上場銘柄一覧 (/equities/listed/info)
// ─────────────────────────────────────

interface JListedInfoRow {
  Date: string
  Code: string
  CompanyName: string
  CompanyNameEnglish?: string
  Sector17Code?: string
  Sector17CodeName?: string
  Sector33Code?: string
  Sector33CodeName?: string
  ScaleCategory?: string
  MarketCode?: string
  MarketCodeName?: string
}

interface JListedInfoResponse {
  data?: JListedInfoRow[]
  info?: JListedInfoRow[]  // v1 互換のキー名にも備える
}

/**
 * 上場銘柄一覧。code を指定すれば 1 銘柄、省略すれば全銘柄。
 */
export async function fetchJQuantsListedInfo(ticker?: string): Promise<JListedInfoRow[]> {
  const apiKey = getApiKey()
  const params = new URLSearchParams()
  if (ticker) params.set('code', toJQuantsCode(ticker))

  const res = await fetch(`${BASE_URL}/equities/master${params.size > 0 ? `?${params}` : ''}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!res.ok) {
    throw new Error(`J-Quants equities/master 失敗: ${res.status} ${await res.text()}`)
  }
  const json = await res.json() as JListedInfoResponse
  return json.data ?? json.info ?? []
}
