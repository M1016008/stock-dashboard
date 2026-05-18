import { NextRequest } from "next/server";
import {
  generateExam,
  type Difficulty,
  type QuestionType,
} from "@/lib/ai/quiz";
import { saveQuizSession } from "@/lib/srs";
import { getMaterial } from "@/lib/library";
import { resolveScope, buildScopeText } from "@/lib/exam-scope";
import type { AiProvider } from "@/lib/ai/types";
import type { DocumentStructure } from "@/lib/ai/structure";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_SCOPE_CHARS = 30_000;
const VALID_TYPES = new Set<QuestionType>(["boolean", "choice"]);
const VALID_DIFF = new Set<Difficulty>(["easy", "medium", "hard"]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON body が不正です" }, { status: 400 });
  }

  const materialId =
    typeof body.materialId === "string" && body.materialId.length > 0
      ? body.materialId
      : null;
  const scopeNodeKey =
    typeof body.scopeNodeKey === "string" && body.scopeNodeKey.length > 0
      ? body.scopeNodeKey
      : null;

  let structure: DocumentStructure | null = null;
  let materialTitle: string | null = null;
  if (body.structure && typeof body.structure === "object") {
    structure = body.structure as DocumentStructure;
  } else if (materialId) {
    const m = await getMaterial(materialId);
    if (!m) {
      return Response.json(
        { error: "materialId に該当する教材が見つかりません" },
        { status: 404 },
      );
    }
    structure = m.structure;
    materialTitle = m.title;
  }

  if (!structure || !Array.isArray(structure.nodes)) {
    return Response.json(
      { error: "structure (もしくは materialId) が必要です" },
      { status: 400 },
    );
  }

  if (materialId && !materialTitle) {
    const m = await getMaterial(materialId);
    materialTitle = m?.title ?? null;
  }

  const typesRaw = body.types;
  if (!Array.isArray(typesRaw) || typesRaw.length === 0) {
    return Response.json(
      { error: "types は 1 つ以上の出題形式を指定してください" },
      { status: 400 },
    );
  }
  const types: QuestionType[] = [];
  for (const t of typesRaw) {
    if (typeof t !== "string" || !VALID_TYPES.has(t as QuestionType)) {
      return Response.json({ error: "types が不正です" }, { status: 400 });
    }
    if (!types.includes(t as QuestionType)) types.push(t as QuestionType);
  }

  const difficulty = body.difficulty as Difficulty;
  if (!VALID_DIFF.has(difficulty)) {
    return Response.json({ error: "difficulty が不正です" }, { status: 400 });
  }

  const countRaw = Number(body.count);
  if (!Number.isFinite(countRaw) || countRaw < 1 || countRaw > 30) {
    return Response.json(
      { error: "count は 1〜30 の範囲で指定してください" },
      { status: 400 },
    );
  }
  const count = Math.floor(countRaw);
  const provider = (body.provider as AiProvider) ?? "anthropic";

  const scope = resolveScope(structure, scopeNodeKey);
  if (scope.nodes.length === 0) {
    return Response.json(
      { error: "出題範囲に有効なノードがありません" },
      { status: 400 },
    );
  }

  let scopeText = buildScopeText(scope.nodes);
  if (scopeText.length > MAX_SCOPE_CHARS) {
    scopeText = scopeText.slice(0, MAX_SCOPE_CHARS);
  }

  try {
    const result = await generateExam({
      scopeText,
      scopeLabel: scope.label,
      types,
      difficulty,
      count,
      provider,
    });

    // pick the dominant type label for session metadata
    const dominantType: QuestionType =
      types.length === 1 ? types[0] : "choice";

    const saved = await saveQuizSession({
      materialId,
      materialTitle: materialTitle ?? structure.title,
      nodeKey: scopeNodeKey,
      nodeTitle: `総合演習: ${scope.label}`,
      type: dominantType,
      difficulty,
      questions: result.questions,
    });

    return Response.json({
      ...saved,
      scopeLabel: scope.label,
      scopeNodeCount: scope.nodes.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
