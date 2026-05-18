import OpenAI from "openai";
import { EXPLAIN_SYSTEM_PROMPT } from "./types";

const MODEL = "gpt-4o";

export async function* streamExplainOpenAI(
  text: string,
): AsyncGenerator<string> {
  const client = new OpenAI();

  const stream = await client.chat.completions.create({
    model: MODEL,
    stream: true,
    messages: [
      { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
      {
        role: "user",
        content: `次の教材を解説してください。\n\n---\n${text}\n---`,
      },
    ],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}
