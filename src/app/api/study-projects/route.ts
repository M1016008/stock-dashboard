import { createStudyProject, listStudyProjects } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function GET() {
  try {
    const projects = await listStudyProjects();
    return Response.json({ projects });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json(
      { error: "プロジェクト名を入力してください。" },
      { status: 400 },
    );
  }
  const project = await createStudyProject({
    title,
    purpose: typeof body.purpose === "string" ? body.purpose : "",
    memo: typeof body.memo === "string" ? body.memo : "",
    targetCompletionDate:
      typeof body.targetCompletionDate === "string"
        ? body.targetCompletionDate
        : "",
    studyGroupId:
      typeof body.studyGroupId === "string" && body.studyGroupId.length > 0
        ? body.studyGroupId
        : null,
  });
  return Response.json({ project });
}
