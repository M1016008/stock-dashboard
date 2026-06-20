// app/api/admin/sector-master/[ticker]/route.ts
// 単一銘柄のマスタ手動補完用エンドポイントは読み取り専用運用へ移行したため停止。

import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'

export const dynamic = 'force-dynamic'

export async function PUT() {
  return adminWriteDisabledResponse('業種マスター手動補完')
}
