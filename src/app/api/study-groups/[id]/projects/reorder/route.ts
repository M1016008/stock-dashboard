import { reorderProjectsInGroup } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const projectIds = Array.isArray(body.projectIds)
    ? body.projectIds.filter((value: unknown): value is string => typeof value === "string")
    : [];
  if (projectIds.length === 0) {
    return Response.json(
      { error: "projectIds を指定してください。" },
      { status: 400 },
    );
  }
  const group = await reorderProjectsInGroup(id, projectIds);
  return Response.json({ group });
}
