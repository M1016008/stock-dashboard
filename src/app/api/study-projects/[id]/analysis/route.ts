import { getProjectAnalysis } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const analysis = await getProjectAnalysis(id);
  if (!analysis) {
    return Response.json(
      { error: "解析結果がまだありません。" },
      { status: 404 },
    );
  }
  return Response.json({ analysis });
}
