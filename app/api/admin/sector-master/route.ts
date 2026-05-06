// app/api/admin/sector-master/route.ts
// Excel (.xlsx) を受け取り、コード/銘柄名/大分類/業種細分類 の4列を sector_master に保存する。

import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { execAll, execBatch, execRun, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// ヘッダ行のエイリアス（途中で表記揺れがあっても拾えるように）
const COL_ALIAS: Record<string, string[]> = {
  code:         ['コード', '銘柄コード', 'ticker', 'symbol'],
  name:         ['銘柄名', '名称', 'name'],
  sectorLarge:  ['大分類', '業種大分類', 'sector_large'],
  sectorSmall:  ['業種細分類', '小分類', '中分類', '業種小分類', 'sector_small'],
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

interface ImportSummary {
  fileName: string
  totalRows: number
  inserted: number
  skipped: number
  detectedColumns: { code: string | null; name: string | null; sectorLarge: string | null; sectorSmall: string | null }
  errors: string[]
}

export async function POST(request: Request) {
  try {
    await ensureReady()
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'ファイルが指定されていません' }, { status: 400 })
    }

    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheetName = wb.SheetNames[0]
    if (!sheetName) {
      return NextResponse.json({ error: 'シートが見つかりません' }, { status: 400 })
    }
    const sheet = wb.Sheets[sheetName]
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false })
    if (rows.length < 2) {
      return NextResponse.json({ error: 'データ行がありません' }, { status: 400 })
    }

    // ヘッダ行を自動検出: コードと大分類を含む最初の行をヘッダとする
    let headerIdx = -1
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const codeIdx = findColumnIndex(rows[i], COL_ALIAS.code)
      const largeIdx = findColumnIndex(rows[i], COL_ALIAS.sectorLarge)
      if (codeIdx >= 0 && largeIdx >= 0) {
        headerIdx = i
        break
      }
    }
    if (headerIdx < 0) {
      return NextResponse.json({
        error: 'ヘッダ行が検出できませんでした。"コード" と "大分類" 列が必要です',
      }, { status: 400 })
    }

    const header = rows[headerIdx]
    const codeIdx = findColumnIndex(header, COL_ALIAS.code)
    const nameIdx = findColumnIndex(header, COL_ALIAS.name)
    const largeIdx = findColumnIndex(header, COL_ALIAS.sectorLarge)
    const smallIdx = findColumnIndex(header, COL_ALIAS.sectorSmall)

    const summary: ImportSummary = {
      fileName: file.name,
      totalRows: 0,
      inserted: 0,
      skipped: 0,
      detectedColumns: {
        code:        codeIdx >= 0 ? String(header[codeIdx]) : null,
        name:        nameIdx >= 0 ? String(header[nameIdx]) : null,
        sectorLarge: largeIdx >= 0 ? String(header[largeIdx]) : null,
        sectorSmall: smallIdx >= 0 ? String(header[smallIdx]) : null,
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
      const name = nameIdx >= 0 ? (String(r[nameIdx] ?? '').trim() || null) : null
      const sectorLarge = largeIdx >= 0 ? (String(r[largeIdx] ?? '').trim() || null) : null
      const sectorSmall = smallIdx >= 0 ? (String(r[smallIdx] ?? '').trim() || null) : null
      if (!sectorLarge && !sectorSmall) {
        summary.skipped++
        continue
      }
      inserts.push({
        sql: `INSERT INTO sector_master (ticker, name, sector_large, sector_small, updated_at, source_file)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(ticker) DO UPDATE SET
                name = COALESCE(excluded.name, sector_master.name),
                sector_large = excluded.sector_large,
                sector_small = excluded.sector_small,
                updated_at = excluded.updated_at,
                source_file = excluded.source_file`,
        args: [ticker, name, sectorLarge, sectorSmall, updatedAt, file.name],
      })
    }

    const CHUNK = 500
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await execBatch(inserts.slice(i, i + CHUNK))
    }
    summary.inserted = inserts.length

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
    const totals = await execAll<{ total: number; large_count: number; latest: string | null }>(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT sector_large) AS large_count,
              MAX(updated_at) AS latest
       FROM sector_master`,
    )
    const byLarge = await execAll<{ sector_large: string | null; n: number }>(
      `SELECT sector_large, COUNT(*) AS n FROM sector_master GROUP BY sector_large ORDER BY n DESC`,
    )
    return NextResponse.json({ totals: totals[0] ?? null, byLarge })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
