// app/api/admin/batch/snapshots/route.ts
// 画面/APIからの手動 snapshot 計算は停止。更新はCLI/定期ジョブへ集約する。
import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'

export const dynamic = 'force-dynamic'

export async function POST() {
  return adminWriteDisabledResponse('スナップショット計算バッチ')
}
