import { NextResponse } from 'next/server'

export function adminWriteDisabledResponse(feature: string) {
  return NextResponse.json(
    {
      error: 'admin_write_disabled',
      message: `${feature} は画面/APIからの手動実行を停止しました。更新はCLIまたは定期バッチで実行してください。`,
    },
    {
      status: 410,
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
