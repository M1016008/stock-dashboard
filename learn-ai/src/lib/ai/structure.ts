import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AiProvider } from "./types";

export interface StructureNode {
  title: string;
  summary: string;
  excerpt?: string;
  children?: StructureNode[];
}

export interface DocumentStructure {
  title: string;
  nodes: StructureNode[];
}

const STRUCTURE_SYSTEM_PROMPT = `あなたは教材を解析して学習用のツリー構造を作る専門家です。
与えられた教材テキストから、章・節・小項目・論点を階層構造で抽出してください。

【ルール】
- 出力は **JSON のみ** (前後の説明文や \`\`\`json などの装飾は一切不要)
- 階層は最大 3 段 (大項目 → 中項目 → 小項目)
- 各ノードに必ず以下を付ける:
  - title: 短く分かりやすい見出し (原文の用語をなるべく使う)
  - summary: そのノードが何を扱うか 1〜2 行で説明
  - excerpt: 原文から該当箇所を 50〜200 文字抜粋 (内容理解の手がかりになる部分)
- 構造が無い文章でも、論点単位で分割してツリー化する
- 全体で 30 ノード前後を上限の目安にする

【JSON スキーマ】
{
  "title": "教材全体のタイトル",
  "nodes": [
    {
      "title": "...",
      "summary": "...",
      "excerpt": "...",
      "children": [
        { "title": "...", "summary": "...", "excerpt": "...", "children": [...] }
      ]
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

export async function analyzeStructure(
  text: string,
  provider: AiProvider,
): Promise<DocumentStructure> {
  if (provider === "openai") {
    const client = new OpenAI();
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: STRUCTURE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `次の教材を解析してツリー構造の JSON を返してください。\n\n---\n${text}\n---`,
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    return JSON.parse(extractJson(raw));
  }

  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: STRUCTURE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `次の教材を解析してツリー構造の JSON を返してください。\n\n---\n${text}\n---`,
      },
    ],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI 応答にテキストブロックがありませんでした");
  }
  return JSON.parse(extractJson(textBlock.text));
}
