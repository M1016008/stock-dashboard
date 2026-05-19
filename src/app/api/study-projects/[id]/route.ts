import { getStudyProject } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await getStudyProject(id);
  if (!project) {
    return Response.json(
      { error: "学習プロジェクトが見つかりません。" },
      { status: 404 },
    );
  }
  return Response.json({ project });
}
