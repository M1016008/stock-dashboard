// app/api/admin/universe/[ticker]/route.ts
// 個別銘柄の active トグル / 削除は読み取り専用運用へ移行したため停止。
import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'

export const dynamic = 'force-dynamic'

export async function PATCH() {
  return adminWriteDisabledResponse('銘柄ユニバース更新')
}

export async function DELETE() {
  return adminWriteDisabledResponse('銘柄ユニバース削除')
}
