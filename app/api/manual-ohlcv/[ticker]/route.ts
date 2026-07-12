import { NextRequest, NextResponse } from 'next/server'
import {
  getManualOhlcvSummary,
  normalizeManualTicker,
  parseManualOhlcvCsv,
  upsertManualOhlcvRows,
} from '@/lib/manual-ohlcv'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

interface ManualOhlcvImportBody {
  csv?: string
  sourceName?: string
  sourceNote?: string
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = normalizeManualTicker(decodeURIComponent(rawTicker))
    const summary = await getManualOhlcvSummary(ticker)
    return NextResponse.json({
      ok: true,
      source: 'manual_ohlcv',
      summary,
    })
  } catch (error) {
    console.error('Manual OHLCV summary error:', error)
    return NextResponse.json(
      { ok: false, error: 'Failed to load manual OHLCV summary', message: (error as Error).message },
      { status: 500 },
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = normalizeManualTicker(decodeURIComponent(rawTicker))
    const body = await readImportBody(request)
    const csv = body.csv?.trim() ?? ''

    if (!csv) {
      return NextResponse.json(
        { ok: false, error: 'CSV is required' },
        { status: 400 },
      )
    }
    if (csv.length > 2_000_000) {
      return NextResponse.json(
        { ok: false, error: 'CSV is too large. Keep it under 2MB.' },
        { status: 413 },
      )
    }

    const parsed = parseManualOhlcvCsv(csv)
    if (parsed.errors.length > 0) {
      return NextResponse.json(
        { ok: false, error: 'CSV validation failed', errors: parsed.errors },
        { status: 422 },
      )
    }

    const summary = await upsertManualOhlcvRows({
      ticker,
      rows: parsed.rows,
      sourceName: body.sourceName ?? 'manual_csv',
      sourceNote: body.sourceNote,
    })

    return NextResponse.json({
      ok: true,
      source: 'manual_ohlcv',
      imported: parsed.rows.length,
      summary,
    })
  } catch (error) {
    console.error('Manual OHLCV import error:', error)
    return NextResponse.json(
      { ok: false, error: 'Failed to import manual OHLCV', message: (error as Error).message },
      { status: 500 },
    )
  }
}

async function readImportBody(request: NextRequest): Promise<ManualOhlcvImportBody> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData()
    const file = form.get('file')
    const csvFromFile = isTextBlob(file) ? await file.text() : null
    return {
      csv: csvFromFile ?? stringValue(form.get('csv')),
      sourceName: stringValue(form.get('sourceName')),
      sourceNote: stringValue(form.get('sourceNote')),
    }
  }

  const body = await request.json().catch(() => ({})) as ManualOhlcvImportBody
  return {
    csv: typeof body.csv === 'string' ? body.csv : '',
    sourceName: typeof body.sourceName === 'string' ? body.sourceName : undefined,
    sourceNote: typeof body.sourceNote === 'string' ? body.sourceNote : undefined,
  }
}

function isTextBlob(value: FormDataEntryValue | null): value is File {
  return typeof value === 'object' && value !== null && typeof value.text === 'function'
}

function stringValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' ? value : undefined
}
