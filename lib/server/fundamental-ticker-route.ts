import { NextResponse } from 'next/server'
import { decodePathSegment } from '@/lib/url-path'

function validAsOf(value: string | null): value is string {
  if (!value) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  return !Number.isNaN(Date.parse(value))
}

/** JP 銘柄単位の財務系 read model を返す GET ハンドラ (ticker / as_of 検証・404・キャッシュ・500 を共通化)。 */
export function fundamentalTickerRoute<T>(config: {
  label: string
  load: (ticker: string, requestedAsOf: string | null) => Promise<T>
  isNotFound: (model: T) => boolean
  notFoundError: string
  unavailableError: string
}) {
  return async function GET(
    request: Request,
    { params }: { params: Promise<{ ticker: string }> },
  ) {
    const ticker = decodePathSegment((await params).ticker).replace(/\.T$/i, '')
    if (!/^[0-9A-Z]{4,5}$/i.test(ticker)) {
      return NextResponse.json({ error: 'invalid_ticker' }, { status: 400 })
    }
    const requestedAsOf = new URL(request.url).searchParams.get('as_of')
    if (requestedAsOf && !validAsOf(requestedAsOf)) {
      return NextResponse.json({ error: 'invalid_as_of' }, { status: 400 })
    }

    try {
      const model = await config.load(ticker, requestedAsOf)
      if (config.isNotFound(model)) {
        return NextResponse.json({ error: config.notFoundError }, { status: 404 })
      }
      return NextResponse.json(model, {
        headers: {
          'Cache-Control': requestedAsOf
            ? 'private, max-age=300, stale-while-revalidate=3600'
            : 'private, max-age=60, stale-while-revalidate=300',
        },
      })
    } catch (error) {
      console.error(`[${config.label}] ticker=${ticker}`, error)
      return NextResponse.json({ error: config.unavailableError }, { status: 500 })
    }
  }
}
