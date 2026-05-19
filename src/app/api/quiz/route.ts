import { NextRequest } from "next/server";
import {
  generateQuiz,
  type Difficulty,
  type QuestionType,
} from "@/lib/ai/quiz";
import { saveQuizSession } from "@/lib/srs";
import { getMaterial } from "@/lib/library";
import type { AiProvider } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TEXT_CHARS = 20_000;
const VALID_TYPES = new Set<QuestionType>(["boolean", "choice"]);
const VALID_DIFF = new Set<Difficulty>(["easy", "medium", "hard"]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON body が不正です" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json({ error: "text が空です" }, { status: 400 });
  }

  const type = body.type as QuestionType;
  if (!VALID_TYPES.has(type)) {
    return Response.json({ error: "type が不正です" }, { status: 400 });
  }

  const difficulty = body.difficulty as Difficulty;
  if (!VALID_DIFF.has(difficulty)) {
    return Response.json({ error: "difficulty が不正です" }, { status: 400 });
  }

  const countRaw = Number(body.count);
  if (!Number.isFinite(countRaw) || countRaw < 1 || countRaw > 20) {
    return Response.json(
      { error: "count は 1〜20 の範囲で指定してください" },
      { status: 400 },
    );
  }
  const count = Math.floor(countRaw);
  const provider = (body.provider as AiProvider) ?? "anthropic";

  const materialId =
    typeof body.materialId === "string" && body.materialId.length > 0
      ? body.materialId
      : null;
  const nodeKey =
    typeof body.nodeKey === "string" ? body.nodeKey : null;
  const nodeTitle =
    typeof body.nodeTitle === "string" ? body.nodeTitle : null;

  const trimmed =
    text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

  try {
    const result = await generateQuiz({
      text: trimmed,
      type,
      difficulty,
      count,
      provider,
    });

    let materialTitle: string | null = null;
    if (materialId) {
      const m = await getMaterial(materialId);
      materialTitle = m?.title ?? null;
    }

    const saved = await saveQuizSession({
      materialId,
      materialTitle,
      nodeKey,
      nodeTitle,
      type,
      difficulty,
      questions: result.questions,
    });

    return Response.json(saved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
