import { NextRequest } from "next/server";
import { analyzeStructure } from "@/lib/ai/structure";
import type { AiProvider } from "@/lib/ai/types";
import { extractPdfText } from "@/lib/pdf";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TEXT_CHARS = 80_000;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const provider = (form.get("provider") ?? "anthropic") as AiProvider;
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
      { error: "テキストまたはファイルを入力してください" },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
  }

  try {
    const structure = await analyzeStructure(text, provider);
    return Response.json({ structure, sourceText: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
