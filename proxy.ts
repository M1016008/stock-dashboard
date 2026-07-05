// proxy.ts
//
// Yoshio 要望: サイトを開いたら/リロードしたら必ず最新の DB を反映するため、
// 全レスポンスに Cache-Control: no-store を付ける。
// 各ルートの export const dynamic = 'force-dynamic' / revalidate = 0 と多重に保険をかけている。

import { NextResponse, type NextRequest } from 'next/server'

const SHARE_AUTH_REALM = 'StockBoard shared preview'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function isShareMode(): boolean {
  return process.env.STOCKBOARD_SHARE_MODE === '1'
}

function isReadOnlyShareMode(): boolean {
  return process.env.STOCKBOARD_SHARE_READ_ONLY !== '0'
}

function isAdminPath(pathname: string): boolean {
  return pathname === '/admin'
    || pathname.startsWith('/admin/')
    || pathname === '/api/admin'
    || pathname.startsWith('/api/admin/')
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function unauthorized() {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${SHARE_AUTH_REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  })
}

function unavailable(message: string) {
  return new NextResponse(message, {
    status: 503,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  })
}

function forbidden(pathname: string, message: string) {
  if (isApiPath(pathname)) {
    return NextResponse.json(
      { error: 'share_access_denied', message },
      {
        status: 403,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        },
      },
    )
  }

  return new NextResponse(message, {
    status: 403,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  })
}

function decodeBasicAuth(value: string | null): { user: string; password: string } | null {
  if (!value?.startsWith('Basic ')) return null
  try {
    const decoded = atob(value.slice('Basic '.length).trim())
    const separator = decoded.indexOf(':')
    if (separator < 0) return null
    return {
      user: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    }
  } catch {
    return null
  }
}

function isAuthorized(req: NextRequest): boolean {
  const expectedUser = process.env.STOCKBOARD_SHARE_BASIC_USER?.trim()
  const expectedPassword = process.env.STOCKBOARD_SHARE_BASIC_PASSWORD?.trim()
  if (!expectedUser || !expectedPassword) return false

  const auth = decodeBasicAuth(req.headers.get('authorization'))
  return auth?.user === expectedUser && auth.password === expectedPassword
}

export function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname

  if (isShareMode()) {
    const hasCredentials = Boolean(
      process.env.STOCKBOARD_SHARE_BASIC_USER?.trim()
      && process.env.STOCKBOARD_SHARE_BASIC_PASSWORD?.trim(),
    )
    if (!hasCredentials) {
      return unavailable('StockBoard sharing credentials are not configured.')
    }
    if (!isAuthorized(req)) {
      return unauthorized()
    }
    if (isAdminPath(pathname) && process.env.STOCKBOARD_SHARE_ALLOW_ADMIN !== '1') {
      return forbidden(pathname, 'Admin routes are disabled in shared preview mode.')
    }
    if (isReadOnlyShareMode() && !SAFE_METHODS.has(req.method)) {
      return forbidden(pathname, 'Write requests are disabled in read-only shared preview mode.')
    }
  }

  const res = NextResponse.next()
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.headers.set('Pragma', 'no-cache')
  res.headers.set('Expires', '0')
  return res
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
}
