// app/api/admin/batch/ohlcv/route.ts
// 画面/APIからの手動バッチ起動は停止。更新はCLI/定期ジョブへ集約する。

import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'

export const dynamic = 'force-dynamic'

export async function POST() {
  return adminWriteDisabledResponse('OHLCV取得バッチ')
}
