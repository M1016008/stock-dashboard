import { NextRequest } from "next/server";
import { deleteProblemSet, getProblemSet } from "@/lib/problem-sets";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const detail = await getProblemSet(id);
  if (!detail) {
    return Response.json({ error: "見つかりませんでした" }, { status: 404 });
  }
  return Response.json({ problemSet: detail });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = await deleteProblemSet(id);
  if (!ok) {
    return Response.json({ error: "削除に失敗しました" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
