import {
  createStudyNoteExport,
  listStudyNoteExports,
} from "@/lib/study-projects";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const notes = await listStudyNoteExports(id);
  return Response.json({ notes });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.topicTitle !== "string" || !body.topicTitle.trim()) {
    return Response.json(
      { error: "topicTitle が必要です。" },
      { status: 400 },
    );
  }
  try {
    const note = await createStudyNoteExport({
      projectId: id,
      title: typeof body.title === "string" ? body.title : body.topicTitle,
      topicKey: typeof body.topicKey === "string" ? body.topicKey : null,
      topicTitle: body.topicTitle,
      content:
        typeof body.content === "object" && body.content
          ? body.content
          : {},
    });
    return Response.json({ note });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
