import { NextRequest } from "next/server";
import { deleteMaterial, getMaterial } from "@/lib/library";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const material = await getMaterial(id);
  if (!material) {
    return Response.json({ error: "見つかりませんでした" }, { status: 404 });
  }
  return Response.json({ material });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = await deleteMaterial(id);
  if (!ok) {
    return Response.json({ error: "削除に失敗しました" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
