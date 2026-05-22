// proxy.ts
//
// Yoshio 要望: サイトを開いたら/リロードしたら必ず最新の DB を反映するため、
// 全レスポンスに Cache-Control: no-store を付ける。
// 各ルートの export const dynamic = 'force-dynamic' / revalidate = 0 と多重に保険をかけている。

import { NextResponse, type NextRequest } from 'next/server'

export function proxy(_req: NextRequest) {
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
