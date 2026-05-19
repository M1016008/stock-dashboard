import {
  deleteStudyGroup,
  getStudyGroup,
  updateStudyGroup,
} from "@/lib/study-projects";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const group = await getStudyGroup(id);
  if (!group) {
    return Response.json(
      { error: "学習グループが見つかりません。" },
      { status: 404 },
    );
  }
  return Response.json({ group });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const group = await updateStudyGroup(id, {
    title: typeof body.title === "string" ? body.title : undefined,
    purpose: typeof body.purpose === "string" ? body.purpose : undefined,
    targetCompletionDate:
      typeof body.targetCompletionDate === "string"
        ? body.targetCompletionDate
        : undefined,
    memo: typeof body.memo === "string" ? body.memo : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
  });
  if (!group) {
    return Response.json(
      { error: "学習グループが見つかりません。" },
      { status: 404 },
    );
  }
  return Response.json({ group });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = await deleteStudyGroup(id);
  if (!ok) {
    return Response.json(
      { error: "学習グループが見つかりません。" },
      { status: 404 },
    );
  }
  return Response.json({ ok: true });
}
