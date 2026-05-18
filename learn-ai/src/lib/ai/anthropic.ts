import Anthropic from "@anthropic-ai/sdk";
import { EXPLAIN_SYSTEM_PROMPT } from "./types";

const MODEL = "claude-opus-4-7";

export async function* streamExplainAnthropic(
  text: string,
): AsyncGenerator<string> {
  const client = new Anthropic();

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: EXPLAIN_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `次の教材を解説してください。\n\n---\n${text}\n---`,
      },
    ],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}
