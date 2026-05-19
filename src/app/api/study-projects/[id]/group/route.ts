import { setProjectGroup } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const studyGroupId =
    typeof body.studyGroupId === "string" && body.studyGroupId.length > 0
      ? body.studyGroupId
      : null;
  try {
    const project = await setProjectGroup(id, studyGroupId);
    if (!project) {
      return Response.json(
        { error: "学習プロジェクトが見つかりません。" },
        { status: 404 },
      );
    }
    return Response.json({ project });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
