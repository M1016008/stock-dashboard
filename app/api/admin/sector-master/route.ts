// app/api/admin/sector-master/route.ts
// Excel (.xlsx / .xls) を受け取り、コード/銘柄名/市場区分/33業種/業種小分類 を sector_master に保存する。
// アップロード経由のほか、JPX 公式の data_j.xls を直接フェッチして取り込む POST?source=jpx もサポート。

import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { execAll, execBatch, execRun, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

// JPX 上場銘柄一覧 (毎営業日更新)。
// https://www.jpx.co.jp/markets/statistics-equities/misc/01.html
const JPX_DATA_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls'

// ヘッダ行のエイリアス（途中で表記揺れがあっても拾えるように）。
// 33業種区分（JPX 由来）と 業種小分類（ユーザ CSV 由来）は別フィールドとして
// 独立に保持する。両方が存在しない Excel ではそのカラムは null のまま。
const COL_ALIAS: Record<string, string[]> = {
  code:          ['コード', '銘柄コード', 'ticker', 'symbol'],
  name:          ['銘柄名', '名称', 'name'],
  // JPX 公式の「市場・商品区分」やユーザ提供 Excel の「市場区分」「区分」など
  marketSegment: ['市場・商品区分', '市場区分', '区分', '上場区分'],
  // 33業種区分（JPX のみ）
  sector33:      ['33業種区分'],
  // 17業種 / 大分類（ユーザ CSV / JPX 17業種区分どちらでも）
  sectorLarge:   ['17業種区分', '大分類', '業種大分類', 'sector_large'],
  // ユーザ CSV の業種小分類（業種細分類 / 中分類 / 小分類 等）
  sectorSmall:   ['業種小分類', '業種細分類', '中分類', '小分類', 'sector_small'],
}

function findColumnIndex(header: unknown[], aliases: string[]): number {
  const norm = header.map((h) => String(h ?? '').trim())
  for (const a of aliases) {
    const idx = norm.findIndex((h) => h === a)
    if (idx >= 0) return idx
  }
  return -1
}

function normalizeTicker(raw: unknown): string | null {
  if (raw == null) return null
  let s = String(raw).trim()
  // Excel が数値として読んだ場合は小数点が付くことがあるので除去
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '')
  if (/^\d{4,5}$/.test(s)) return `${s}.T`
  if (/^\d{4,5}\.T$/.test(s)) return s
  return null
}

/**
 * 「プライム（内国株式）」のようなJPX表記から「プライム」だけを抜き出す。
 * 内国株式以外（ETF、REIT 等）は null を返してマスタに含めない。
 */
function normalizeMarketSegment(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (s.includes('プライム')) return 'プライム'
  if (s.includes('スタンダード')) return 'スタンダード'
  if (s.includes('グロース')) return 'グロース'
  // 既にユーザ Excel が「プライム」だけ書いてある場合などはそのまま許容
  if (/^(プライム|スタンダード|グロース)$/.test(s)) return s
  return null
}

interface ImportSummary {
  fileName: string
  totalRows: number
  inserted: number
  skipped: number
  detectedColumns: {
    code: string | null
    name: string | null
    marketSegment: string | null
    sector33: string | null
    sectorLarge: string | null
    sectorSmall: string | null
  }
  errors: string[]
}

async function importWorkbook(buf: ArrayBuffer, fileName: string): Promise<ImportSummary> {
  const wb = XLSX.read(buf, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('シートが見つかりません')

  const sheet = wb.Sheets[sheetName]
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false })
  if (rows.length < 2) throw new Error('データ行がありません')

  // ヘッダ行を自動検出: コードを含む最初の行
  let headerIdx = -1
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (findColumnIndex(rows[i], COL_ALIAS.code) >= 0) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) {
    throw new Error('ヘッダ行が検出できませんでした（"コード" 列が必要です）')
  }

  const header = rows[headerIdx]
  const codeIdx          = findColumnIndex(header, COL_ALIAS.code)
  const nameIdx          = findColumnIndex(header, COL_ALIAS.name)
  const marketSegmentIdx = findColumnIndex(header, COL_ALIAS.marketSegment)
  const sector33Idx      = findColumnIndex(header, COL_ALIAS.sector33)
  const sectorLargeIdx   = findColumnIndex(header, COL_ALIAS.sectorLarge)
  const sectorSmallIdx   = findColumnIndex(header, COL_ALIAS.sectorSmall)

  const summary: ImportSummary = {
    fileName,
    totalRows: 0,
    inserted: 0,
    skipped: 0,
    detectedColumns: {
      code:          codeIdx          >= 0 ? String(header[codeIdx])          : null,
      name:          nameIdx          >= 0 ? String(header[nameIdx])          : null,
      marketSegment: marketSegmentIdx >= 0 ? String(header[marketSegmentIdx]) : null,
      sector33:      sector33Idx      >= 0 ? String(header[sector33Idx])      : null,
      sectorLarge:   sectorLargeIdx   >= 0 ? String(header[sectorLargeIdx])   : null,
      sectorSmall:   sectorSmallIdx   >= 0 ? String(header[sectorSmallIdx])   : null,
    },
    errors: [],
  }

  const updatedAt = new Date().toISOString()
  const inserts: { sql: string; args: (string | null)[] }[] = []

  for (let i = headerIdx + 1; i < rows.length; i++) {
    summary.totalRows++
    const r = rows[i]
    const ticker = normalizeTicker(r[codeIdx])
    if (!ticker) {
      summary.skipped++
      continue
    }
    const name           = nameIdx          >= 0 ? (String(r[nameIdx]          ?? '').trim() || null) : null
    const sectorLarge    = sectorLargeIdx   >= 0 ? (String(r[sectorLargeIdx]   ?? '').trim() || null) : null
    const sector33       = sector33Idx      >= 0 ? (String(r[sector33Idx]      ?? '').trim() || null) : null
    const sectorSmall    = sectorSmallIdx   >= 0 ? (String(r[sectorSmallIdx]   ?? '').trim() || null) : null
    const marketSegment  = marketSegmentIdx >= 0 ? normalizeMarketSegment(String(r[marketSegmentIdx] ?? '')) : null

    // 何も区分情報が無い行はスキップ（合計行や見出し行など）
    if (!sectorLarge && !sector33 && !sectorSmall && !marketSegment) {
      summary.skipped++
      continue
    }

    // 各カラムは独立して保存。新規アップロードで欠けている値は既存値を残す（COALESCE）。
    inserts.push({
      sql: `INSERT INTO sector_master (ticker, name, sector_large, sector_small, sector33, market_segment, updated_at, source_file)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
              name = COALESCE(excluded.name, sector_master.name),
              sector_large = COALESCE(excluded.sector_large, sector_master.sector_large),
              sector_small = COALESCE(excluded.sector_small, sector_master.sector_small),
              sector33 = COALESCE(excluded.sector33, sector_master.sector33),
              market_segment = COALESCE(excluded.market_segment, sector_master.market_segment),
              updated_at = excluded.updated_at,
              source_file = excluded.source_file`,
      args: [ticker, name, sectorLarge, sectorSmall, sector33, marketSegment, updatedAt, fileName],
    })
  }

  const CHUNK = 500
  for (let i = 0; i < inserts.length; i += CHUNK) {
    await execBatch(inserts.slice(i, i + CHUNK))
  }
  summary.inserted = inserts.length
  return summary
}

export async function POST(request: Request) {
  try {
    await ensureReady()
    const url = new URL(request.url)
    const source = url.searchParams.get('source')

    // JPX 公式から直接取得
    if (source === 'jpx') {
      const res = await fetch(JPX_DATA_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (StockBoard JPX fetcher)' },
        cache: 'no-store',
      })
      if (!res.ok) {
        return NextResponse.json(
          { error: 'JPX fetch failed', message: `HTTP ${res.status} from ${JPX_DATA_URL}` },
          { status: 502 },
        )
      }
      const buf = await res.arrayBuffer()
      const summary = await importWorkbook(buf, 'data_j.xls (JPX)')
      return NextResponse.json({ summary, source: 'jpx', url: JPX_DATA_URL })
    }

    // 通常: ユーザがアップロードした Excel
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'ファイルが指定されていません' }, { status: 400 })
    }
    const buf = await file.arrayBuffer()
    const summary = await importWorkbook(buf, file.name)
    return NextResponse.json({ summary })
  } catch (error) {
    console.error('Sector master import error:', error)
    return NextResponse.json(
      { error: 'Import failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

export async function GET() {
  try {
    await ensureReady()
    const totals = await execAll<{ total: number; large_count: number; segment_count: number; latest: string | null }>(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT sector_large) AS large_count,
              COUNT(DISTINCT market_segment) AS segment_count,
              MAX(updated_at) AS latest
       FROM sector_master`,
    )
    const byLarge = await execAll<{ sector_large: string | null; n: number }>(
      `SELECT sector_large, COUNT(*) AS n FROM sector_master GROUP BY sector_large ORDER BY n DESC`,
    )
    const bySegment = await execAll<{ market_segment: string | null; n: number }>(
      `SELECT market_segment, COUNT(*) AS n FROM sector_master GROUP BY market_segment ORDER BY n DESC`,
    )
    return NextResponse.json({ totals: totals[0] ?? null, byLarge, bySegment })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

// 任意の execRun 等の未使用 import を抑制
void execRun
