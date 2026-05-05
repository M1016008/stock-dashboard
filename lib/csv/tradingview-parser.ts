// lib/csv/tradingview-parser.ts
// TradingView から書き出した日本株スクリーナーCSV (TSV) のパーサ。
//
// 想定ヘッダ（順不同・必要なものを名前で取り出す）:
//   シンボル / 名称 / 価格 / 価格 - 通貨 / 価格変動 % 1日 / 出来高 1日 /
//   平均出来高 10日 / 平均出来高 30日 / 時価総額 / 時価総額 - 通貨 /
//   PER (株価収益率) / 配当利回り %, 直近12ヶ月 /
//   パフォーマンス % 1週 / 1ヶ月 / 3ヶ月 / 6ヶ月 / 年初来 /
//   SMA (単純移動平均) (5/25/75/150/300) 1日 /
//   SMA (単純移動平均) (5/13/25/50/100) 1週 /
//   SMA (単純移動平均) (3/5/10/20/25) 1ヶ月 /
//   前回決算発表日 / 次回決算発表日

export interface ParsedRow {
  ticker: string             // ".T" 付き
  name: string
  price: number | null
  currency: string | null
  changePercent1d: number | null
  volume1d: number | null
  avgVolume10d: number | null
  avgVolume30d: number | null
  marketCap: number | null
  marketCapCurrency: string | null
  per: number | null
  dividendYieldPct: number | null
  perfPct1w: number | null
  perfPct1m: number | null
  perfPct3m: number | null
  perfPct6m: number | null
  perfPctYtd: number | null
  sma5d: number | null
  sma25d: number | null
  sma75d: number | null
  sma150d: number | null
  sma300d: number | null
  sma5w: number | null
  sma13w: number | null
  sma25w: number | null
  sma50w: number | null
  sma100w: number | null
  sma3m: number | null
  sma5m: number | null
  sma10m: number | null
  sma20m: number | null
  sma25m: number | null
  earningsLastDate: string | null
  earningsNextDate: string | null
}

export interface ParseResult {
  rows: ParsedRow[]
  errors: string[]
  detectedColumns: string[]
}

const REQUIRED_COLUMNS = ['シンボル', '名称', '価格']

/** カラム名 → ParsedRow のキーへのマッピング */
const COLUMN_MAP: Record<string, keyof ParsedRow> = {
  '名称': 'name',
  '価格': 'price',
  '価格 - 通貨': 'currency',
  '価格変動 % 1日': 'changePercent1d',
  '出来高 1日': 'volume1d',
  '平均出来高 10日': 'avgVolume10d',
  '平均出来高 30日': 'avgVolume30d',
  '時価総額': 'marketCap',
  '時価総額 - 通貨': 'marketCapCurrency',
  'PER (株価収益率)': 'per',
  '配当利回り %, 直近12ヶ月': 'dividendYieldPct',
  'パフォーマンス % 1週': 'perfPct1w',
  'パフォーマンス % 1ヶ月': 'perfPct1m',
  'パフォーマンス % 3ヶ月': 'perfPct3m',
  'パフォーマンス % 6ヶ月': 'perfPct6m',
  'パフォーマンス % 年初来': 'perfPctYtd',
  'SMA (単純移動平均) (5) 1日': 'sma5d',
  'SMA (単純移動平均) (25) 1日': 'sma25d',
  'SMA (単純移動平均) (75) 1日': 'sma75d',
  'SMA (単純移動平均) (150) 1日': 'sma150d',
  'SMA (単純移動平均) (300) 1日': 'sma300d',
  'SMA (単純移動平均) (5) 1週': 'sma5w',
  'SMA (単純移動平均) (13) 1週': 'sma13w',
  'SMA (単純移動平均) (25) 1週': 'sma25w',
  'SMA (単純移動平均) (50) 1週': 'sma50w',
  'SMA (単純移動平均) (100) 1週': 'sma100w',
  'SMA (単純移動平均) (3) 1ヶ月': 'sma3m',
  'SMA (単純移動平均) (5) 1ヶ月': 'sma5m',
  'SMA (単純移動平均) (10) 1ヶ月': 'sma10m',
  'SMA (単純移動平均) (20) 1ヶ月': 'sma20m',
  'SMA (単純移動平均) (25) 1ヶ月': 'sma25m',
  '前回決算発表日': 'earningsLastDate',
  '次回決算発表日': 'earningsNextDate',
}

const STRING_COLUMNS = new Set([
  'name',
  'currency',
  'marketCapCurrency',
  'earningsLastDate',
  'earningsNextDate',
])

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function splitLines(text: string): string[] {
  return stripBom(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0)
}

function parseNumber(raw: string): number | null {
  if (raw === '' || raw === '—' || raw === '--' || raw === 'N/A' || raw === 'null') return null
  const cleaned = raw.replace(/[, %]/g, '').trim()
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function normalizeTicker(symbol: string): string {
  const s = symbol.trim()
  if (/^\d{4,5}$/.test(s)) return `${s}.T`
  return s
}

export function parseTradingViewCsv(text: string): ParseResult {
  const lines = splitLines(text)
  if (lines.length === 0) {
    return { rows: [], errors: ['ファイルが空です'], detectedColumns: [] }
  }

  const header = lines[0].split('\t').map((h) => h.trim())
  const errors: string[] = []

  for (const req of REQUIRED_COLUMNS) {
    if (!header.includes(req)) {
      errors.push(`必須カラム "${req}" が見つかりません`)
    }
  }
  if (errors.length > 0) {
    return { rows: [], errors, detectedColumns: header }
  }

  const symbolIdx = header.indexOf('シンボル')
  const colIndex: Partial<Record<keyof ParsedRow, number>> = {}
  for (const [csvName, key] of Object.entries(COLUMN_MAP)) {
    const idx = header.indexOf(csvName)
    if (idx >= 0) colIndex[key] = idx
  }

  const rows: ParsedRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const symbol = cols[symbolIdx]?.trim()
    if (!symbol) continue

    const row: ParsedRow = {
      ticker: normalizeTicker(symbol),
      name: '',
      price: null,
      currency: null,
      changePercent1d: null,
      volume1d: null,
      avgVolume10d: null,
      avgVolume30d: null,
      marketCap: null,
      marketCapCurrency: null,
      per: null,
      dividendYieldPct: null,
      perfPct1w: null,
      perfPct1m: null,
      perfPct3m: null,
      perfPct6m: null,
      perfPctYtd: null,
      sma5d: null,
      sma25d: null,
      sma75d: null,
      sma150d: null,
      sma300d: null,
      sma5w: null,
      sma13w: null,
      sma25w: null,
      sma50w: null,
      sma100w: null,
      sma3m: null,
      sma5m: null,
      sma10m: null,
      sma20m: null,
      sma25m: null,
      earningsLastDate: null,
      earningsNextDate: null,
    }

    for (const [key, idx] of Object.entries(colIndex) as [keyof ParsedRow, number][]) {
      const raw = (cols[idx] ?? '').trim()
      if (STRING_COLUMNS.has(key)) {
        ;(row[key] as unknown as string | null) = raw === '' ? null : raw
      } else {
        ;(row[key] as unknown as number | null) = parseNumber(raw)
      }
    }

    rows.push(row)
  }

  return { rows, errors, detectedColumns: header }
}

/**
 * ファイル名から取引日を推定する。
 * 対応形式（例）:
 *   "2026-05-05_xxx.csv"
 *   "screener (2026-05-05).csv"
 *   "20260505_xxx.csv"
 *   "2026.05.05.csv"
 *   "2026_5_5.csv"
 *   "May 5 2026.csv"  (英語月名)
 *   "5月5日2026.csv"  (日本語)
 */
export function detectDateFromFileName(fileName: string): string | null {
  const name = fileName.replace(/\.[^.]+$/, '')

  // ISO 風: 2026-05-05 / 2026.05.05 / 2026/05/05 / 2026_5_5 / 2026 5 5
  const iso = name.match(/(\d{4})[\-./_ ](\d{1,2})[\-./_ ](\d{1,2})/)
  if (iso) return formatYmd(+iso[1], +iso[2], +iso[3])

  // 連続8桁: 20260505
  const dense = name.match(/(?<![\d])(\d{4})(\d{2})(\d{2})(?![\d])/)
  if (dense) return formatYmd(+dense[1], +dense[2], +dense[3])

  // 英語月名: May 5 2026 / May 5, 2026 / 5 May 2026
  const monthMap: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  }
  const en1 = name.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})[,\s]+(\d{4})/i)
  if (en1) return formatYmd(+en1[3], monthMap[en1[1].slice(0, 3).toLowerCase()], +en1[2])
  const en2 = name.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})/i)
  if (en2) return formatYmd(+en2[3], monthMap[en2[2].slice(0, 3).toLowerCase()], +en2[1])

  // 日本語: 2026年5月5日 / 5月5日2026
  const ja1 = name.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/)
  if (ja1) return formatYmd(+ja1[1], +ja1[2], +ja1[3])
  const ja2 = name.match(/(\d{1,2})月\s*(\d{1,2})日\s*(\d{4})/)
  if (ja2) return formatYmd(+ja2[3], +ja2[1], +ja2[2])

  return null
}

function formatYmd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 1900 || y > 2100) return null
  if (m < 1 || m > 12) return null
  if (d < 1 || d > 31) return null
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}
