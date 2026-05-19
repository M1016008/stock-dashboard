import { createStudyGroup, listStudyGroups } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function GET() {
  try {
    const groups = await listStudyGroups();
    return Response.json({ groups });
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
      { error: "グループ名を入力してください。" },
      { status: 400 },
    );
  }
  const group = await createStudyGroup({
    title,
    purpose: typeof body.purpose === "string" ? body.purpose : "",
    targetCompletionDate:
      typeof body.targetCompletionDate === "string"
        ? body.targetCompletionDate
        : "",
    memo: typeof body.memo === "string" ? body.memo : "",
  });
  return Response.json({ group });
}
