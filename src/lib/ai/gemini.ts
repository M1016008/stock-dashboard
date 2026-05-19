import { EXPLAIN_SYSTEM_PROMPT } from "./types";

const DEFAULT_MODEL = "gemini-2.0-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  error?: {
    message?: string;
  };
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY が設定されていません");
  }
  return key;
}

function responseText(data: GeminiResponse): string {
  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("");
  if (!text) {
    throw new Error(data.error?.message ?? "Gemini からテキスト応答がありませんでした");
  }
  return text;
}

export async function generateGeminiText(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": getApiKey(),
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
    }),
  });

  const data = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Gemini API error: ${res.status}`);
  }
  return responseText(data);
}

export async function* streamExplainGemini(
  text: string,
): AsyncGenerator<string> {
  const result = await generateGeminiText(
    EXPLAIN_SYSTEM_PROMPT,
    `次の教材を解説してください。\n\n---\n${text}\n---`,
  );
  yield result;
}
