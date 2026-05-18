import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiProvider } from "./types";

export interface ProblemAugmentation {
  keyPoint: string;
  reasoning: string;
  textbookReference: string;
  connection: string;
  beginnerNotes: string;
}

export interface AugmentInput {
  questionText: string;
  choices: string[] | null;
  answerText: string | null;
  originalExplanation: string;
  textbookText: string | null;
  provider: AiProvider;
}

const SYSTEM_PROMPT_WITH_TEXTBOOK = `あなたは学習教材の補足解説を作る教育の専門家です。
与えられた【問題】と【元の解説】、そして関連教材の【テキスト本文】を読んで、学習者がこの問題から最大限学べるよう、5 つの観点で補足を書いてください。

【出力の 5 観点 — 必ずすべて含める】
1. keyPoint: この問題で問われている **核心概念** を 1〜3 行で言語化
2. reasoning: 解答に至る **思考プロセス** を順序立てて丁寧に。学習者が「次回も自分で解ける」状態を目指す
3. textbookReference: **テキスト本文の関連箇所を抜粋** (200 字以内目安、原文ママ)。複数あれば箇条書きで。
4. connection: その概念が **テキストのどこに位置づけられ、何と繋がっているか**。前後の単元との関係も含めて
5. beginnerNotes: **初学者でも理解できる追加説明** (専門用語の噛み砕き / 典型的な誤解 / 覚え方のコツ / 関連例)

【ルール】
- 出力は **JSON のみ** (前後の説明禁止)
- 文体は丁寧で噛み砕いた日本語
- 元の解説をなぞるだけでなく、視点を **拡張** する
- テキスト本文に書いていないことは作らない (textbookReference / connection は本文から)
- beginnerNotes は問題と本文の知識を補強する一般知識を含めて OK

【JSON スキーマ】
{
  "keyPoint": "...",
  "reasoning": "...",
  "textbookReference": "...",
  "connection": "...",
  "beginnerNotes": "..."
}`;

const SYSTEM_PROMPT_NO_TEXTBOOK = `あなたは学習教材の補足解説を作る教育の専門家です。
与えられた【問題】と【元の解説】を読んで、学習者がこの問題から最大限学べるよう、5 つの観点で補足を書いてください。

【出力の 5 観点 — 必ずすべて含める】
1. keyPoint: この問題で問われている **核心概念** を 1〜3 行で言語化
2. reasoning: 解答に至る **思考プロセス** を順序立てて丁寧に。学習者が「次回も自分で解ける」状態を目指す
3. textbookReference: テキスト本文は与えられていないため **空文字 ""** とする
4. connection: テキストとの紐付けは与えられていないため **空文字 ""** とする
5. beginnerNotes: **初学者でも理解できる追加説明** (専門用語の噛み砕き / 典型的な誤解 / 覚え方のコツ / 関連する具体例)

【ルール】
- 出力は **JSON のみ** (前後の説明禁止)
- 文体は丁寧で噛み砕いた日本語
- 元の解説をなぞるだけでなく、視点を **拡張** する

【JSON スキーマ】
{
  "keyPoint": "...",
  "reasoning": "...",
  "textbookReference": "",
  "connection": "",
  "beginnerNotes": "..."
}`;

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("AI 応答から JSON を取り出せませんでした");
  }
  return raw.slice(start, end + 1);
}

function validate(a: ProblemAugmentation): ProblemAugmentation {
  if (!a || typeof a !== "object") {
    throw new Error("補足解説の JSON が不正です");
  }
  const out: ProblemAugmentation = {
    keyPoint: typeof a.keyPoint === "string" ? a.keyPoint : "",
    reasoning: typeof a.reasoning === "string" ? a.reasoning : "",
    textbookReference:
      typeof a.textbookReference === "string" ? a.textbookReference : "",
    connection: typeof a.connection === "string" ? a.connection : "",
    beginnerNotes:
      typeof a.beginnerNotes === "string" ? a.beginnerNotes : "",
  };
  if (!out.keyPoint || !out.reasoning || !out.beginnerNotes) {
    throw new Error("補足解説の必須項目が欠落しています");
  }
  return out;
}

export async function augmentProblem(
  input: AugmentInput,
): Promise<ProblemAugmentation> {
  const hasTextbook = !!(input.textbookText && input.textbookText.trim());
  const systemPrompt = hasTextbook
    ? SYSTEM_PROMPT_WITH_TEXTBOOK
    : SYSTEM_PROMPT_NO_TEXTBOOK;

  const parts = [
    `【問題 (${input.questionText.slice(0, 40)}...)】`,
    input.questionText,
  ];
  if (input.choices && input.choices.length > 0) {
    parts.push("【選択肢】", input.choices.join("\n"));
  }
  if (input.answerText) {
    parts.push("【解答】", input.answerText);
  }
  parts.push(
    "【元の解説】",
    input.originalExplanation || "(問題集に解説の記載なし)",
  );
  if (hasTextbook) {
    parts.push("【関連テキスト本文】", input.textbookText as string);
  }
  const userPrompt = parts.join("\n\n");

  if (input.provider === "openai") {
    const client = new OpenAI();
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    return validate(JSON.parse(extractJson(raw)));
  }

  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI 応答にテキストブロックがありませんでした");
  }
  return validate(JSON.parse(extractJson(textBlock.text)));
}
