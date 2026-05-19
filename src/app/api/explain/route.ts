import { NextRequest } from "next/server";
import { streamExplainAnthropic } from "@/lib/ai/anthropic";
import { streamExplainGemini } from "@/lib/ai/gemini";
import { streamExplainOpenAI } from "@/lib/ai/openai";
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
    return new Response(
      JSON.stringify({ error: "テキストまたはファイルを入力してください" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
  }

  const generator =
    provider === "openai"
      ? streamExplainOpenAI(text)
      : provider === "gemini"
        ? streamExplainGemini(text)
        : streamExplainAnthropic(text);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of generator) {
          controller.enqueue(encoder.encode(delta));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`\n\n[エラー] ${msg}`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
