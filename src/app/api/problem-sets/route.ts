import { NextRequest } from "next/server";
import { extractProblems } from "@/lib/ai/problem-extract";
import { createProblemSet, listProblemSets } from "@/lib/problem-sets";
import { extractPdfText } from "@/lib/pdf";
import type { AiProvider } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TEXT_CHARS = 80_000;

export async function GET() {
  const items = await listProblemSets();
  return Response.json({ items });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const provider = (form.get("provider") ?? "anthropic") as AiProvider;
  const title = typeof form.get("title") === "string"
    ? (form.get("title") as string)
    : "";
  const materialIdRaw = form.get("materialId");
  const materialId =
    typeof materialIdRaw === "string" && materialIdRaw.length > 0
      ? materialIdRaw
      : null;
  const rawText = form.get("text");
  const file = form.get("file");

  let text = "";
  if (typeof rawText === "string" && rawText.trim().length > 0) {
    text = rawText.trim();
  } else if (file instanceof File && file.size > 0) {
    const buf = await file.arrayBuffer();
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      text = await extractPdfText(buf);
    } else {
      text = new TextDecoder("utf-8").decode(buf);
    }
  }

  text = text.trim();
  if (!text) {
    return Response.json(
      { error: "問題集のテキストまたはファイルを入力してください" },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
  }

  try {
    const extracted = await extractProblems(text, provider);
    const created = await createProblemSet({
      title,
      materialId,
      sourceText: text,
      extracted,
    });
    return Response.json({ id: created.id, problemCount: extracted.problems.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
