import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { generateGeminiText } from "./gemini";
import type { AiProvider } from "./types";

export interface StructureNode {
  title: string;
  summary: string;
  learningGoal?: string;
  importance?: string;
  explanation?: string;
  extraKnowledge?: string;
  keyPoint?: string;
  excerpt?: string;
  children?: StructureNode[];
}

export interface KeywordEntry {
  term: string;
  meaning: string;
  example: string;
  image: string;
}

export interface DocumentStructure {
  title: string;
  nodes: StructureNode[];
  keywords?: KeywordEntry[];
}

const STRUCTURE_SYSTEM_PROMPT = [
  "あなたは『小学生でもイメージできる』レベルまで噛み砕いて教材を構造化する、学習ノート作成の専門家です。",
  "入力された教材を、単なる要約ではなく『理解できること』を最優先にした学習ノートへ変換してください。",
  "",
  "出力は JSON のみです。前後の説明文や markdown のコードフェンスは絶対に付けないでください。",
  "",
  "ルール:",
  "- 階層は最大 3 段階まで。",
  "- 各トピックは必ず以下の5項目を持つこと。",
  "  1. learningGoal: 何を学ぶのか。この章・テーマの目的を最初に明示。",
  "  2. importance: なぜ重要なのか。実生活や試験との関係を含めて説明。",
  "  3. explanation: 内容の説明。小学生でもイメージできる言葉、具体例、図解イメージを交えて順番に説明。",
  "  4. extraKnowledge: 補足知識。周辺知識や混同しやすいポイント。",
  "  5. keyPoint: ★ここ大事。試験頻出、間違えやすい箇所、本質部分を強調。",
  "- 専門用語は、できるだけ日常の言葉へ変換すること。",
  "  例: キャッシュフロー → お金の流れ / 債務不履行 → 約束した支払いができない状態。",
  "- summary は、そのノードの内容を1文で短く説明すること。",
  "- excerpt は、原文の根拠になる短い抜粋を入れること。",
  "- keywords には教材内の重要語を 6〜15 個抽出し、意味・具体例・イメージ例を入れること。",
  "- 日本語で、初学者にやさしく、丁寧に書くこと。",
  "",
  "JSON スキーマ:",
  '{',
  '  "title": "教材全体のタイトル",',
  '  "nodes": [',
  '    {',
  '      "title": "トピック名",',
  '      "summary": "1文概要",',
  '      "learningGoal": "何を学ぶのか",',
  '      "importance": "なぜ重要なのか",',
  '      "explanation": "内容の説明",',
  '      "extraKnowledge": "補足知識",',
  '      "keyPoint": "★ここ大事",',
  '      "excerpt": "原文抜粋",',
  '      "children": []',
  '    }',
  '  ],',
  '  "keywords": [',
  '    {',
  '      "term": "用語",',
  '      "meaning": "理解できる言葉での意味",',
  '      "example": "具体例",',
  '      "image": "身近なイメージ例"',
  '    }',
  '  ]',
  '}',
].join("\n");

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("AI 応答から JSON を取り出せませんでした");
  }
  return raw.slice(start, end + 1);
}

function normalizeNode(node: StructureNode): StructureNode {
  return {
    title: node.title || "無題",
    summary: node.summary || node.explanation || "",
    learningGoal: node.learningGoal || "",
    importance: node.importance || "",
    explanation: node.explanation || node.summary || "",
    extraKnowledge: node.extraKnowledge || "",
    keyPoint: node.keyPoint || "",
    excerpt: node.excerpt || "",
    children: Array.isArray(node.children)
      ? node.children.map(normalizeNode)
      : [],
  };
}

function normalizeStructure(input: DocumentStructure): DocumentStructure {
  return {
    title: input.title || "教材ノート",
    nodes: Array.isArray(input.nodes) ? input.nodes.map(normalizeNode) : [],
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map((k) => ({
          term: k.term || "",
          meaning: k.meaning || "",
          example: k.example || "",
          image: k.image || "",
        })).filter((k) => k.term)
      : [],
  };
}

export async function analyzeStructure(
  text: string,
  provider: AiProvider,
): Promise<DocumentStructure> {
  const userPrompt = "次の教材を、5項目つきの超・構造化ノートとキーワード辞典にしてください。\n\n---\n" + text + "\n---";

  if (provider === "openai") {
    const client = new OpenAI();
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: STRUCTURE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    return normalizeStructure(JSON.parse(extractJson(raw)));
  }

  if (provider === "gemini") {
    const raw = await generateGeminiText(STRUCTURE_SYSTEM_PROMPT, userPrompt);
    return normalizeStructure(JSON.parse(extractJson(raw)));
  }

  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    system: STRUCTURE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI 応答にテキストブロックがありませんでした");
  }
  return normalizeStructure(JSON.parse(extractJson(textBlock.text)));
}
