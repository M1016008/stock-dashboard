import type { MomentumMatrixModel } from '@/lib/daily-close-momentum-matrix'
import {
  PAGE06_HEADLINE_MAX,
  PAGE06_LINE_MAX,
  buildPage06ClaudeInput,
  deterministicPage06Narrative,
  validatePage06Narrative,
  type Page06ClaudeInput,
  type Page06Narrative,
} from '@/lib/daily-close-page06-narrative-content'
import {
  CLAUDE_CODE_PROVIDER,
  runClaudeCode,
  type ClaudeCodeErrorCode,
  type ClaudeCodeRequest,
  type ClaudeCodeResult,
} from '@/lib/server/claude-code-adapter'

// Page 06 Design Lab「Narrative」層 (Claude 呼び出し)。headline / fact / interpretation / caveat を
// Claude Code subscription で 1 回だけ生成し、検証に失敗したら deterministic 文章へ fallback する。

export const PAGE06_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'fact', 'interpretation', 'caveat'],
  properties: {
    headline: { type: 'string', minLength: 1, maxLength: PAGE06_HEADLINE_MAX },
    fact: { type: 'string', minLength: 1, maxLength: PAGE06_LINE_MAX },
    interpretation: { type: 'string', minLength: 1, maxLength: PAGE06_LINE_MAX },
    caveat: { type: 'string', minLength: 1, maxLength: PAGE06_LINE_MAX },
  },
}

export const PAGE06_SYSTEM_PROMPT = [
  'あなたは日本株日次レポートの「60分類 MOMENTUM MATRIX」ページに添える短文の編集者です。',
  '根拠は <data> 内の JSON だけです。入力にない数値・分類名・要因・ニュース・将来予測・売買判断を書かないでください。',
  'Momentum Shift は順位変化 (rank1M - rank1W) であり、リターンの加速度ではありません。「加速」「加速度」と表現しないでください。',
  '分類名は featured に含まれるものだけを使ってください。',
  `headline: ${PAGE06_HEADLINE_MAX}字以内。その日の状態分布の要点を1つ。`,
  `fact: ${PAGE06_LINE_MAX}字以内。入力の件数・順位・数値を述べるだけ。`,
  `interpretation: ${PAGE06_LINE_MAX}字以内。状態の件数や順位関係から直接言えることだけ。因果や理由は書かない。`,
  `caveat: ${PAGE06_LINE_MAX}字以内。定義・meanDriven・lowSample から来る読み方の注意。`,
  '数値は入力の値をそのまま使い、新たに計算した値 (差・比率・合計など) は書かないでください。',
].join('\n')

export type Page06FallbackReason = ClaudeCodeErrorCode | 'INVALID_OUTPUT' | 'ADAPTER_THREW'

export type Page06NarrativeResult =
  | { source: typeof CLAUDE_CODE_PROVIDER; model: string | null; durationMs: number; narrative: Page06Narrative; input: Page06ClaudeInput }
  | { source: 'deterministic'; fallbackReason: Page06FallbackReason; fallbackDetail?: string; narrative: Page06Narrative; input: Page06ClaudeInput }

export type Page06NarrativeDeps = {
  run?: (request: ClaudeCodeRequest) => Promise<ClaudeCodeResult>
  timeoutMs?: number
}

export function buildPage06Prompt(input: Page06ClaudeInput): string {
  return [
    '以下は60分類 MOMENTUM MATRIX の集計値です。この値だけを根拠に headline / fact / interpretation / caveat を書いてください。',
    '<data>',
    JSON.stringify(input),
    '</data>',
  ].join('\n')
}

export async function generatePage06Narrative(model: MomentumMatrixModel, deps: Page06NarrativeDeps = {}): Promise<Page06NarrativeResult> {
  const input = buildPage06ClaudeInput(model)
  const fallback = (fallbackReason: Page06FallbackReason, fallbackDetail?: string): Page06NarrativeResult => ({
    source: 'deterministic', fallbackReason, fallbackDetail, narrative: deterministicPage06Narrative(model), input,
  })
  const run = deps.run ?? runClaudeCode
  let result: ClaudeCodeResult
  try {
    result = await run({ prompt: buildPage06Prompt(input), systemPrompt: PAGE06_SYSTEM_PROMPT, jsonSchema: PAGE06_JSON_SCHEMA, timeoutMs: deps.timeoutMs })
  } catch {
    return fallback('ADAPTER_THREW')
  }
  if (!result.ok) return fallback(result.errorCode)
  const validated = validatePage06Narrative(result.structuredOutput, input, model.points.map((point) => point.name))
  if (!validated.ok) return fallback('INVALID_OUTPUT', validated.reason)
  return { source: CLAUDE_CODE_PROVIDER, model: result.model, durationMs: result.durationMs, narrative: validated.narrative, input }
}
