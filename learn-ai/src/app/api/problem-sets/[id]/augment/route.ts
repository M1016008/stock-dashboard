import { NextRequest } from "next/server";
import { augmentProblem } from "@/lib/ai/problem-augment";
import {
  getProblemForAugment,
  saveAugmentation,
} from "@/lib/problem-sets";
import type { AiProvider } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TEXTBOOK_CHARS = 40_000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON body が不正です" }, { status: 400 });
  }

  const problemIndex = Number(body.problemIndex);
  if (!Number.isInteger(problemIndex) || problemIndex < 0) {
    return Response.json(
      { error: "problemIndex が不正です" },
      { status: 400 },
    );
  }
  const provider = (body.provider as AiProvider) ?? "anthropic";

  const data = await getProblemForAugment(id, problemIndex);
  if (!data) {
    return Response.json(
      { error: "対象の問題が見つかりません" },
      { status: 404 },
    );
  }

  const textbookText = data.materialText
    ? data.materialText.length > MAX_TEXTBOOK_CHARS
      ? data.materialText.slice(0, MAX_TEXTBOOK_CHARS)
      : data.materialText
    : null;

  try {
    const augmentation = await augmentProblem({
      questionText: data.questionText,
      choices: data.choices,
      answerText: data.answerText,
      originalExplanation: data.originalExplanation,
      textbookText,
      provider,
    });
    await saveAugmentation(data.problemId, augmentation);
    return Response.json({ augmentation });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
