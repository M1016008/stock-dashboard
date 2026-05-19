import { analyzeStudyProject } from "@/lib/study-projects";
import type { AiProvider } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const provider = (body.provider ?? "anthropic") as AiProvider;
  try {
    const analysis = await analyzeStudyProject(id, provider);
    return Response.json({ analysis });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
