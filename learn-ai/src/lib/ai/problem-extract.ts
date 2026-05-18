import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiProvider } from "./types";

export interface ExtractedProblem {
  numberLabel: string;
  questionText: string;
  choices: string[] | null;
  answerText: string | null;
  originalExplanation: string;
}

export interface ExtractedProblemSet {
  title: string;
  problems: ExtractedProblem[];
}

const SYSTEM_PROMPT = `あなたは問題集 PDF の構造化抽出を行う専門家です。
与えられた問題集テキストから、各問題とその解説をペアで取り出してください。

【ルール】
- 出力は **JSON のみ** (前後の説明や \`\`\`json 等の装飾禁止)
- 元の問題集の文言を **そのまま** 保持する (要約・言い換えしない)
- 1 問につき 1 オブジェクト
- 各フィールドの意味:
  - numberLabel: 問題番号の表記 ("問1", "Q3", "第2問" など、元の表記をそのまま)
  - questionText: 設問の本文 (改行は半角スペースにまとめる)
  - choices: 選択肢があれば文字列配列 (① ② ... の記号も含めて。番号順)。なければ null
  - answerText: 解答が示されていれば "正解: ②" など。なければ null
  - originalExplanation: 問題集に書かれている解説をそのまま (なければ空文字)
- 解説と問題の対応関係は番号や見出し ("解説1", "問1の解答" など) を手がかりに正しく結びつける

【JSON スキーマ】
{
  "title": "問題集のタイトル (推測 / 文中から / なければ '問題集')",
  "problems": [
    {
      "numberLabel": "問1",
      "questionText": "...",
      "choices": ["① ...", "② ...", "③ ...", "④ ..."],
      "answerText": "正解: ②",
      "originalExplanation": "..."
    }
  ]
}`;

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("AI 応答から JSON を取り出せませんでした");
  }
  return raw.slice(start, end + 1);
}

function validate(input: ExtractedProblemSet): ExtractedProblemSet {
  if (!input || typeof input !== "object") {
    throw new Error("AI 応答が不正です");
  }
  if (!Array.isArray(input.problems) || input.problems.length === 0) {
    throw new Error("問題が抽出できませんでした");
  }
  for (const p of input.problems) {
    if (typeof p.questionText !== "string" || p.questionText.trim() === "") {
      throw new Error("問題文が空のものが含まれています");
    }
    if (typeof p.numberLabel !== "string") p.numberLabel = "";
    if (typeof p.originalExplanation !== "string") p.originalExplanation = "";
    if (p.choices !== null && !Array.isArray(p.choices)) p.choices = null;
    if (p.answerText !== null && typeof p.answerText !== "string")
      p.answerText = null;
  }
  if (typeof input.title !== "string" || input.title.trim() === "") {
    input.title = "問題集";
  }
  return input;
}

export async function extractProblems(
  text: string,
  provider: AiProvider,
): Promise<ExtractedProblemSet> {
  const userPrompt = `次の問題集テキストから問題と解説のペアを構造化して取り出してください。\n\n---\n${text}\n---`;

  if (provider === "openai") {
    const client = new OpenAI();
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    return validate(JSON.parse(extractJson(raw)));
  }

  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI 応答にテキストブロックがありませんでした");
  }
  return validate(JSON.parse(extractJson(textBlock.text)));
}
