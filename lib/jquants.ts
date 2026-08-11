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

export function fromJQuantsCode(code: string): string {
  const normalized = toJQuantsCode(code)
  return normalized.length === 5 && normalized.endsWith('0')
    ? normalized.slice(0, -1)
    : normalized
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

function toOhlcv(row: JBarRow): OHLCV | null {
  if (row.AdjC == null && row.C == null) return null
  const close = row.AdjC ?? row.C!
  const open  = row.AdjO ?? row.O ?? close
  const high  = row.AdjH ?? row.H ?? close
  const low   = row.AdjL ?? row.L ?? close
  const vol   = row.AdjVo ?? row.Vo ?? 0
  return {
    date:   row.Date,
    open,
    high,
    low,
    close,
    volume: Math.round(vol),
  }
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
    .map(toOhlcv)
    .filter((row): row is OHLCV => row !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export interface JQuantsDailyByDateRow extends OHLCV {
  ticker: string
  adjustmentFactor: number
}

export function hasJQuantsCorporateAction(adjustmentFactor: number | null | undefined): boolean {
  return typeof adjustmentFactor === 'number'
    && Number.isFinite(adjustmentFactor)
    && Math.abs(adjustmentFactor - 1) > Number.EPSILON
}

export function shouldApplyJQuantsLegacyAdjustment(input: {
  adjustmentFactor: number | null | undefined
  adjustedProviderStartClose: number | null | undefined
  existingProviderStartClose: number | null | undefined
  legacyLastClose: number | null | undefined
}): boolean {
  const factor = input.adjustmentFactor
  const adjustedClose = input.adjustedProviderStartClose
  if (!hasJQuantsCorporateAction(factor) || factor! <= 0 || !adjustedClose || adjustedClose <= 0) {
    return false
  }

  const referenceCloses = [input.existingProviderStartClose, input.legacyLastClose]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)

  return referenceCloses.some((referenceClose) => {
    const observedFactor = adjustedClose / referenceClose
    return Math.abs(Math.log(observedFactor / factor!)) <= Math.log(1.35)
  })
}

export async function fetchJQuantsDailyByDate(date: string): Promise<JQuantsDailyByDateRow[]> {
  const apiKey = getApiKey()
  const all: JQuantsDailyByDateRow[] = []
  let paginationKey: string | undefined

  do {
    const params = new URLSearchParams({ date })
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/equities/bars/daily?${params}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      throw new Error(`J-Quants bars/daily date=${date} 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JBarsResponse
    for (const row of json.data ?? []) {
      const ohlcv = toOhlcv(row)
      if (!ohlcv) continue
      all.push({
        ticker: fromJQuantsCode(row.Code),
        adjustmentFactor: row.AdjFactor ?? 1,
        ...ohlcv,
      })
    }
    paginationKey = json.pagination_key
  } while (paginationKey)

  return all.sort((a, b) => a.ticker.localeCompare(b.ticker))
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
  OdP?: string               // 経常利益
  CFO?: string               // 営業キャッシュフロー
  CFI?: string               // 投資キャッシュフロー
  CFF?: string               // 財務キャッシュフロー
  CashEq?: string            // 現金及び現金同等物
  DivAnn?: string            // 年間配当
  PayoutRatioAnn?: string    // 配当性向
  FSales?: string            // 通期会社予想 売上高
  FOP?: string               // 通期会社予想 営業利益
  FNP?: string               // 通期会社予想 純利益
  FEPS?: string              // 通期会社予想 EPS
  FDivAnn?: string           // 通期会社予想 年間配当
  NxFSales?: string          // 次期会社予想 売上高
  NxFOP?: string             // 次期会社予想 営業利益
  NxFNp?: string             // 次期会社予想 純利益
  NxFEPS?: string            // 次期会社予想 EPS
  NxFDivAnn?: string         // 次期会社予想 年間配当
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

export async function fetchJQuantsFinsSummaryByDate(date: string): Promise<JFinsSummaryRow[]> {
  const apiKey = getApiKey()
  const all: JFinsSummaryRow[] = []
  let paginationKey: string | undefined

  do {
    const params = new URLSearchParams({ date })
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/fins/summary?${params.toString()}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      throw new Error(`J-Quants fins/summary 失敗 (${date}): ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JFinsSummaryResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)

  return all
}

// ─────────────────────────────────────
// API: 日々公表信用取引残高 (/markets/margin-alert)
// ─────────────────────────────────────

export interface JMarginAlertRow {
  PubDate: string
  Code: string
  AppDate: string
  PubReason?: Record<string, string> | string | null
  ShrtOut?: number | null
  ShrtOutChg?: number | null
  ShrtOutRatio?: number | null
  LongOut?: number | null
  LongOutChg?: number | null
  LongOutRatio?: number | null
  SLRatio?: number | null
  ShrtNegOut?: number | null
  ShrtNegOutChg?: number | null
  ShrtStdOut?: number | null
  ShrtStdOutChg?: number | null
  LongNegOut?: number | null
  LongNegOutChg?: number | null
  LongStdOut?: number | null
  LongStdOutChg?: number | null
  TSEMrgnRegCls?: string | null
}

interface JMarginAlertResponse {
  data?: JMarginAlertRow[]
  pagination_key?: string
}

export async function fetchJQuantsMarginAlert(options: {
  ticker?: string
  date?: string
  from?: string
  to?: string
} = {}): Promise<JMarginAlertRow[]> {
  const apiKey = getApiKey()
  const all: JMarginAlertRow[] = []
  let paginationKey: string | undefined

  do {
    const params = new URLSearchParams()
    if (options.ticker) params.set('code', toJQuantsCode(options.ticker))
    if (options.date) {
      params.set('date', options.date)
    } else {
      if (options.from) params.set('from', options.from)
      if (options.to) params.set('to', options.to)
    }
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/markets/margin-alert${params.size > 0 ? `?${params}` : ''}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      throw new Error(`J-Quants markets/margin-alert 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JMarginAlertResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)

  return all.sort((a, b) => (
    a.AppDate.localeCompare(b.AppDate)
    || a.PubDate.localeCompare(b.PubDate)
    || a.Code.localeCompare(b.Code)
  ))
}

// ─────────────────────────────────────
// 派生: PBR / ROE などを計算して返す
// ─────────────────────────────────────

export interface FundamentalsResult {
  pbr?: number           // current_price / BPS
  roe?: number           // NP / Eq * 100  (%)
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
 * 財務サマリ + 現在価格から PBR/ROE などを計算。
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
    if (bps != null && bps > 0)    result.pbr = currentPrice / bps
  }

  if (np != null && eq != null && eq > 0) {
    result.roe = (np / eq) * 100
  }

  return result
}

// ─────────────────────────────────────
// API: 信用残高 (/markets/margin-interest) — 週次
// ─────────────────────────────────────

export interface JMarginRow {
  Date: string                  // 報告基準日 "YYYY-MM-DD"
  Code: string                  // 5 桁コード
  ShortMarginTradeVolume?: string  // 信用売残 (株)
  LongMarginTradeVolume?: string   // 信用買残 (株)
  ShortNegotiableMarginTradeVolume?: string
  LongNegotiableMarginTradeVolume?: string
  ShortStandardizedMarginTradeVolume?: string
  LongStandardizedMarginTradeVolume?: string
  ShrtVol?: number
  LongVol?: number
  ShrtNegVol?: number
  LongNegVol?: number
  ShrtStdVol?: number
  LongStdVol?: number
}

interface JMarginResponse {
  data?: JMarginRow[]
  pagination_key?: string
}

export async function fetchJQuantsWeeklyMargin(ticker: string, from?: string): Promise<JMarginRow[]> {
  const apiKey = getApiKey()
  const all: JMarginRow[] = []
  let paginationKey: string | undefined
  do {
    const params = new URLSearchParams({ code: toJQuantsCode(ticker) })
    if (from) params.set('from', from)
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/markets/margin-interest?${params}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      // Standard プラン外なら 403。空配列で吸収する。
      if (res.status === 403 || res.status === 404) return []
      throw new Error(`J-Quants margin-interest 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JMarginResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)
  return all
}

export async function fetchJQuantsWeeklyMarginByDate(date: string): Promise<JMarginRow[]> {
  const apiKey = getApiKey()
  const all: JMarginRow[] = []
  let paginationKey: string | undefined
  do {
    const params = new URLSearchParams({ date })
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/markets/margin-interest?${params}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) return []
      throw new Error(`J-Quants margin-interest(date) 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JMarginResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)
  return all
}

// ─────────────────────────────────────
// API: 決算発表予定 (/fins/announcement) — 14 日先まで
// ─────────────────────────────────────

export interface JAnnouncementRow {
  Date: string             // 発表日 "YYYY-MM-DD"
  Code: string             // 5 桁コード
  CompanyName?: string
  FiscalYear?: string
  SectorName?: string
  FiscalQuarter?: string
  Section?: string
}

interface JAnnouncementResponse {
  announcement?: JAnnouncementRow[]
  pagination_key?: string
}

// ─────────────────────────────────────
// API: 指数四本値 (/indices/bars/daily)
//   code 例: 0000=TOPIX, 0070=東証グロース250, 0500=プライム指数,
//            0501=スタンダード指数, 0502=グロース指数, 0503=JPXプライム150
//   日経225は公式の指数コード表に存在しないため、J-Quantsでは取れない。
// ─────────────────────────────────────

export interface JIndexBarRow {
  Date: string
  Code: string
  O: number | null
  H: number | null
  L: number | null
  C: number | null
}

interface JIndexBarsResponse {
  data?: JIndexBarRow[]
  pagination_key?: string
}

export async function fetchJQuantsIndexBars(code: string, from?: string, to?: string): Promise<JIndexBarRow[]> {
  const apiKey = getApiKey()
  const all: JIndexBarRow[] = []
  let paginationKey: string | undefined
  do {
    const params = new URLSearchParams({ code })
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/indices/bars/daily?${params}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) return []
      throw new Error(`J-Quants indices/bars/daily 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JIndexBarsResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)
  return all
}

// ─────────────────────────────────────
// API: 決算発表予定 (/equities/earnings-calendar) — 14 日先まで
// 旧 /fins/announcement は廃止または変更。/equities/earnings-calendar が現行。
// ─────────────────────────────────────

export interface JEarningsCalRow {
  Date: string             // 発表予定日 "YYYY-MM-DD"
  Code: string             // 5 桁コード
  CoName?: string
  FY?: string              // 例 "3月31日"
  FQ?: string              // 例 "本決算" / "第1四半期"
  SectorNm?: string
  Section?: string
}

interface JEarningsCalResponse {
  data?: JEarningsCalRow[]
  pagination_key?: string
}

export async function fetchJQuantsEarningsCalendar(): Promise<JEarningsCalRow[]> {
  const apiKey = getApiKey()
  const all: JEarningsCalRow[] = []
  let paginationKey: string | undefined
  do {
    const params = new URLSearchParams()
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/equities/earnings-calendar${params.size > 0 ? `?${params}` : ''}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) return []
      throw new Error(`J-Quants earnings-calendar 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JEarningsCalResponse
    all.push(...(json.data ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)
  return all
}

export async function fetchJQuantsAnnouncement(): Promise<JAnnouncementRow[]> {
  const apiKey = getApiKey()
  const all: JAnnouncementRow[] = []
  let paginationKey: string | undefined
  do {
    const params = new URLSearchParams()
    if (paginationKey) params.set('pagination_key', paginationKey)
    const res = await fetch(`${BASE_URL}/fins/announcement${params.size > 0 ? `?${params}` : ''}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) return []
      throw new Error(`J-Quants announcement 失敗: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as JAnnouncementResponse
    all.push(...(json.announcement ?? []))
    paginationKey = json.pagination_key
  } while (paginationKey)
  return all
}
