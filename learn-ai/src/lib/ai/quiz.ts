import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiProvider } from "./types";

export type QuestionType = "boolean" | "choice";
export type Difficulty = "easy" | "medium" | "hard";

export interface QuizQuestion {
  type: QuestionType;
  question: string;
  choices?: string[];
  answer: number;
  explanation: string;
}

export interface SavedQuizQuestion extends QuizQuestion {
  id: string;
}

export interface QuizResult {
  questions: QuizQuestion[];
}

export interface SavedQuizResult {
  sessionId: string;
  questions: SavedQuizQuestion[];
}

export interface QuizParams {
  text: string;
  type: QuestionType;
  difficulty: Difficulty;
  count: number;
  provider: AiProvider;
}

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "初級 (用語の意味や定義を直接問う)",
  medium: "中級 (内容の理解・適用を問う)",
  hard: "上級 (応用・推論・複数概念の組み合わせを問う)",
};

function buildSystemPrompt(
  type: QuestionType,
  difficulty: Difficulty,
  count: number,
): string {
  const common = `あなたは学習教材から問題を作る教育専門家です。
与えられた教材の内容に**忠実に**問題を作成してください。
難易度: ${DIFFICULTY_LABEL[difficulty]}
問題数: ${count} 問

【重要】
- 出力は **JSON のみ** (前後の説明や \`\`\`json などの装飾不要)
- 教材に書かれていないことを問題化しない
- 問題どうしは内容が被らないようにする`;

  const explanationGuide = `
【解説 (explanation) の書き方 — これは最重要】
解説は **学習者を一段成長させる教材** です。短い「正解は○○です」では NG。
次の構成を順に **必ず** 含めてください。改行 (\\n) で段落を分けること。

1. 「ポイント」: この問題で押さえるべき核心概念を 1〜2 行で言語化する
2. 「考え方」: 正解にたどり着くための思考プロセス・着眼点を順を追って説明する
   (例: まず何に注目し、次にどう判断するか。教材中の根拠も示す)
3. 「正解の根拠」: なぜそれが正しいのかを具体的に説明する`;

  if (type === "boolean") {
    return `${common}
${explanationGuide}
4. 「誤りの典型パターン」: この命題を逆に覚えてしまいがちな落とし穴・混同しやすい概念があれば指摘する

文体は丁寧で噛み砕いた日本語。専門用語が出る場合は簡潔に補足する。
explanation は最低でも 4〜6 文を目安に、内容に応じて十分な長さで書く。

【形式: ○× 問題】
- 各問題に short な日本語の文を 1 文用意し、それが正しいか誤りかを判定させる
- answer は 0 (正しい) または 1 (誤り)

【JSON スキーマ】
{
  "questions": [
    {
      "type": "boolean",
      "question": "判定対象の文",
      "answer": 0,
      "explanation": "【ポイント】...\\n\\n【考え方】...\\n\\n【正解の根拠】...\\n\\n【よくある誤解】..."
    }
  ]
}`;
  }

  return `${common}
${explanationGuide}
4. 「他の選択肢の検討」: 残り 3 つの選択肢それぞれについて、**1 つずつ順番に**「なぜ誤りか」を具体的に説明する
   - その選択肢が一見もっともらしく見える理由 (どんな誤解・混同から生まれるか) にも触れる
   - 「教材のこの部分と矛盾する」「この概念と取り違えている」など根拠を明示する
   - 例: 「選択肢A: 〜と書かれているが、教材では〜なので誤り。〜と混同しやすい」

文体は丁寧で噛み砕いた日本語。専門用語が出る場合は簡潔に補足する。
explanation は十分な長さで書く (目安: 全部で 8 文以上、他の選択肢の検討だけで 3 段落)。

【形式: 4 択問題】
- 各問題に選択肢を **必ず 4 つ** 用意する (choices)
- 正解は 1 つだけ、紛らわしい誤答を 3 つ作る (教材内の別概念や典型的な誤解を活用)
- answer は正解の choices インデックス (0〜3)

【JSON スキーマ】
{
  "questions": [
    {
      "type": "choice",
      "question": "問題文",
      "choices": ["選択肢A", "選択肢B", "選択肢C", "選択肢D"],
      "answer": 2,
      "explanation": "【ポイント】...\\n\\n【考え方】...\\n\\n【正解の根拠】選択肢C が正しい理由...\\n\\n【他の選択肢の検討】\\n・選択肢A: ...\\n・選択肢B: ...\\n・選択肢D: ..."
    }
  ]
}`;
}

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("AI 応答から JSON を取り出せませんでした");
  }
  return raw.slice(start, end + 1);
}

function validate(result: QuizResult, type: QuestionType): QuizResult {
  if (!Array.isArray(result.questions) || result.questions.length === 0) {
    throw new Error("問題が生成されませんでした");
  }
  for (const q of result.questions) {
    q.type = type;
    if (type === "choice") {
      if (!Array.isArray(q.choices) || q.choices.length !== 4) {
        throw new Error("4 択の選択肢数が不正です");
      }
      if (typeof q.answer !== "number" || q.answer < 0 || q.answer > 3) {
        throw new Error("answer のインデックスが不正です");
      }
    } else {
      if (q.answer !== 0 && q.answer !== 1) {
        throw new Error("○× の answer が不正です (0 か 1)");
      }
    }
  }
  return result;
}

export async function generateQuiz(params: QuizParams): Promise<QuizResult> {
  const { text, type, difficulty, count, provider } = params;
  const systemPrompt = buildSystemPrompt(type, difficulty, count);
  const userPrompt = `次の教材から ${count} 問の${
    type === "boolean" ? "○×" : "4 択"
  }問題を作ってください。\n\n---\n${text}\n---`;

  if (provider === "openai") {
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
    return validate(JSON.parse(extractJson(raw)), type);
  }

  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI 応答にテキストブロックがありませんでした");
  }
  return validate(JSON.parse(extractJson(textBlock.text)), type);
}

export interface ExamParams {
  scopeText: string;
  scopeLabel: string;
  types: QuestionType[];
  difficulty: Difficulty;
  count: number;
  provider: AiProvider;
}

function buildExamSystemPrompt(
  types: QuestionType[],
  difficulty: Difficulty,
  count: number,
): string {
  const formatLabel =
    types.length === 1
      ? types[0] === "boolean"
        ? "○× 問題のみ"
        : "4 択問題のみ"
      : "○× と 4 択の混合 (両方を半々程度バランスよく)";

  const explanationGuide = `
【解説 (explanation) の書き方 — これは最重要】
解説は **学習者を一段成長させる教材** です。改行 (\\n) で段落を分け、次の構成を含めてください:

1. 「ポイント」: この問題で押さえるべき核心概念を 1〜2 行で言語化
2. 「考え方」: 正解にたどり着くための思考プロセス・着眼点
3. 「正解の根拠」: なぜそれが正しいかを具体的に
4. 4 択の場合は「他の選択肢の検討」: 残り 3 つそれぞれについて "なぜ誤りか + どんな誤解から生まれるか" を明示
   ○× の場合は「よくある誤解」: 逆に覚えてしまいがちな落とし穴

文体は丁寧で噛み砕いた日本語。専門用語は簡潔に補足。十分な長さで書く。`;

  const choiceSchema = `{ "type": "choice", "question": "問題文", "choices": ["A","B","C","D"], "answer": 0..3, "explanation": "..." }`;
  const boolSchema = `{ "type": "boolean", "question": "判定する文", "answer": 0 (正) または 1 (誤), "explanation": "..." }`;

  let schemaExample: string;
  if (types.length === 1 && types[0] === "boolean") {
    schemaExample = `{
  "questions": [
    ${boolSchema}
  ]
}`;
  } else if (types.length === 1 && types[0] === "choice") {
    schemaExample = `{
  "questions": [
    ${choiceSchema}
  ]
}`;
  } else {
    schemaExample = `{
  "questions": [
    ${choiceSchema},
    ${boolSchema}
  ]
}`;
  }

  return `あなたは学習教材から総合演習問題を作る教育専門家です。
与えられた教材全体から **幅広いトピック** を網羅する問題を作ってください。

難易度: ${DIFFICULTY_LABEL[difficulty]}
問題数: ${count} 問
出題形式: ${formatLabel}

【重要】
- 出力は **JSON のみ** (前後の説明や \`\`\`json 等の装飾は禁止)
- 教材内の **複数のトピック** から出題し、同じ項目に偏らない (各 # 見出しから最低 1 問ずつを目安)
- 教材に書かれていないことを問題化しない
- 問題どうしの内容が被らないようにする
- 各問題の "type" フィールドで形式を明示する
${explanationGuide}

【JSON スキーマ】
${schemaExample}`;
}

function validateMixed(
  result: QuizResult,
  allowedTypes: QuestionType[],
): QuizResult {
  if (!Array.isArray(result.questions) || result.questions.length === 0) {
    throw new Error("問題が生成されませんでした");
  }
  const allowed = new Set(allowedTypes);
  for (const q of result.questions) {
    if (!allowed.has(q.type)) {
      throw new Error(`許可されていない type が含まれています: ${q.type}`);
    }
    if (q.type === "choice") {
      if (!Array.isArray(q.choices) || q.choices.length !== 4) {
        throw new Error("4 択の選択肢数が不正です");
      }
      if (typeof q.answer !== "number" || q.answer < 0 || q.answer > 3) {
        throw new Error("answer のインデックスが不正です");
      }
    } else {
      q.choices = undefined;
      if (q.answer !== 0 && q.answer !== 1) {
        throw new Error("○× の answer が不正です (0 か 1)");
      }
    }
  }
  return result;
}

export async function generateExam(params: ExamParams): Promise<QuizResult> {
  const { scopeText, scopeLabel, types, difficulty, count, provider } = params;
  if (types.length === 0) {
    throw new Error("出題形式が指定されていません");
  }
  const systemPrompt = buildExamSystemPrompt(types, difficulty, count);
  const userPrompt = `次の教材 (${scopeLabel}) から ${count} 問の総合演習問題を作ってください。教材内の複数のトピックを網羅するように出題範囲を散らしてください。\n\n---\n${scopeText}\n---`;

  if (provider === "openai") {
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
    return validateMixed(JSON.parse(extractJson(raw)), types);
  }

  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI 応答にテキストブロックがありませんでした");
  }
  return validateMixed(JSON.parse(extractJson(textBlock.text)), types);
}
