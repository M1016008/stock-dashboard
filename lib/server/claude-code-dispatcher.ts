import {
  CLAUDE_CODE_PROVIDER,
  redactSecrets,
  runClaudeCode,
  type ClaudeCodeErrorCode,
  type ClaudeCodeModel,
  type ClaudeCodeRequest,
  type ClaudeCodeResult,
} from '@/lib/server/claude-code-adapter'
import {
  PAGE_DESIGN_BUILD_SCHEMA,
  PAGE_DESIGN_BUILD_SYSTEM_PROMPT,
  runClaudeCodeDesignBuild,
  type ClaudeDesignBuildRequest,
  type ClaudeDesignBuildResult,
  type PageDesignBuildOutput,
} from '@/lib/server/claude-code-design-build'

// Claude Code subscription の汎用 dispatcher。
// 呼び出し側は task と JSON input だけを渡し、prompt / schema / model / timeout は
// 固定 profile registry から選択する。自由な prompt 実行 API は提供しない。

export const CLAUDE_TASK_IDS = [
  'market_narrative',
  'page_review',
  'copy_edit',
  'design_review',
  'final_review',
  'page_design_build',
] as const

export type ClaudeTaskId = typeof CLAUDE_TASK_IDS[number]

export type MarketNarrativeOutput = { headline: string; paragraphs: string[] }
export type PageReviewOutput = {
  summary: string
  strengths: string[]
  issues: Array<{ severity: 'high' | 'medium' | 'low'; area: string; issue: string; recommendation: string }>
  suggestedChanges: string[]
}
export type CopyEditOutput = { revisedText: string; changes: string[] }
export type DesignReviewOutput = {
  overallAssessment: string
  hierarchyIssues: string[]
  spacingIssues: string[]
  typographyIssues: string[]
  chartIssues: string[]
  recommendations: string[]
}
export type FinalReviewOutput = { blockingIssues: string[]; nonBlockingIssues: string[]; suggestedFixes: string[] }

export type ClaudeTaskOutputMap = {
  market_narrative: MarketNarrativeOutput
  page_review: PageReviewOutput
  copy_edit: CopyEditOutput
  design_review: DesignReviewOutput
  final_review: FinalReviewOutput
  page_design_build: PageDesignBuildOutput
}

export const MARKET_NARRATIVE_HEADLINE_MAX = 80
export const MARKET_NARRATIVE_PARAGRAPH_MAX = 400
export const MARKET_NARRATIVE_PARAGRAPHS_MAX = 5

export const MARKET_NARRATIVE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'paragraphs'],
  properties: {
    headline: { type: 'string', minLength: 1, maxLength: MARKET_NARRATIVE_HEADLINE_MAX },
    paragraphs: {
      type: 'array',
      minItems: 1,
      maxItems: MARKET_NARRATIVE_PARAGRAPHS_MAX,
      items: { type: 'string', minLength: 1, maxLength: MARKET_NARRATIVE_PARAGRAPH_MAX },
    },
  },
}

export const MARKET_NARRATIVE_SYSTEM_PROMPT = [
  'あなたは日本株の引け後レポートに添える短い市況ナラティブの執筆者です。',
  '根拠は <data> 内の JSON だけです。入力にない数値・銘柄・ニュース・要因・将来予測を作らないでください。',
  '数値は入力値を使い、丸める場合も小数第2位までにしてください。',
  '売買推奨・投資助言はしないでください。Score は保存済み条件への適合度であり売買シグナルではありません。',
  'dataStatus が CURRENT 以外の項目は、データ遅延または未取得であることを明記してください。',
  `出力は日本語で、headline (${MARKET_NARRATIVE_HEADLINE_MAX}字以内) と paragraphs (1〜${MARKET_NARRATIVE_PARAGRAPHS_MAX}段落、各${MARKET_NARRATIVE_PARAGRAPH_MAX}字以内) の構造化出力のみです。`,
].join('\n')

const REVIEW_ITEM_MAX = 500
const REVIEW_ITEMS_MAX = 20
const TEXT_MAX = 20_000
const INPUT_TEXT_MAX = 100_000
const SAFE_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const STRICT_CONTROL_CHARS = /[\u0000-\u001F\u007F]/

type Validation<T> = { ok: true; value: T } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function strictKeys(record: Record<string, unknown>, keys: readonly string[]): string | null {
  const extra = Object.keys(record).filter((key) => !keys.includes(key))
  return extra.length ? `extra_keys:${extra.slice(0, 3).join(',')}` : null
}

function textValue(value: unknown, field: string, max = REVIEW_ITEM_MAX, multiline = false): Validation<string> {
  if (typeof value !== 'string') return { ok: false, reason: `${field}_not_string` }
  const text = value.trim()
  if (!text) return { ok: false, reason: `${field}_empty` }
  if (text.length > max) return { ok: false, reason: `${field}_too_long` }
  if ((multiline ? SAFE_CONTROL_CHARS : STRICT_CONTROL_CHARS).test(text)) return { ok: false, reason: `${field}_control_chars` }
  return { ok: true, value: text }
}

function stringArray(value: unknown, field: string, options: { min?: number; max?: number; itemMax?: number } = {}): Validation<string[]> {
  if (!Array.isArray(value)) return { ok: false, reason: `${field}_not_array` }
  if (value.length < (options.min ?? 0)) return { ok: false, reason: `${field}_too_few` }
  if (value.length > (options.max ?? REVIEW_ITEMS_MAX)) return { ok: false, reason: `${field}_too_many` }
  const items: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const validated = textValue(value[index], `${field}_${index}`, options.itemMax ?? REVIEW_ITEM_MAX, true)
    if (!validated.ok) return validated
    items.push(validated.value)
  }
  return { ok: true, value: items }
}

export function validateMarketNarrative(value: unknown): Validation<MarketNarrativeOutput> {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' }
  const extra = strictKeys(value, ['headline', 'paragraphs'])
  if (extra) return { ok: false, reason: extra }
  if (typeof value.headline !== 'string') return { ok: false, reason: 'headline_not_string' }
  const headline = value.headline.trim()
  if (!headline) return { ok: false, reason: 'headline_empty' }
  if (headline.length > MARKET_NARRATIVE_HEADLINE_MAX) return { ok: false, reason: 'headline_too_long' }
  if (STRICT_CONTROL_CHARS.test(headline)) return { ok: false, reason: 'headline_control_chars' }
  if (!Array.isArray(value.paragraphs)) return { ok: false, reason: 'paragraphs_not_array' }
  if (value.paragraphs.length < 1) return { ok: false, reason: 'paragraphs_empty' }
  if (value.paragraphs.length > MARKET_NARRATIVE_PARAGRAPHS_MAX) return { ok: false, reason: 'paragraphs_too_many' }
  const paragraphs: string[] = []
  for (const item of value.paragraphs) {
    if (typeof item !== 'string') return { ok: false, reason: 'paragraph_not_string' }
    const paragraph = item.trim()
    if (!paragraph) return { ok: false, reason: 'paragraph_empty' }
    if (paragraph.length > MARKET_NARRATIVE_PARAGRAPH_MAX) return { ok: false, reason: 'paragraph_too_long' }
    if (STRICT_CONTROL_CHARS.test(paragraph)) return { ok: false, reason: 'paragraph_control_chars' }
    paragraphs.push(paragraph)
  }
  return { ok: true, value: { headline, paragraphs } }
}

function validatePageReview(value: unknown): Validation<PageReviewOutput> {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' }
  const extra = strictKeys(value, ['summary', 'strengths', 'issues', 'suggestedChanges'])
  if (extra) return { ok: false, reason: extra }
  const summary = textValue(value.summary, 'summary', 1_500, true)
  const strengths = stringArray(value.strengths, 'strengths')
  const suggestedChanges = stringArray(value.suggestedChanges, 'suggestedChanges')
  if (!summary.ok) return summary
  if (!strengths.ok) return strengths
  if (!suggestedChanges.ok) return suggestedChanges
  if (!Array.isArray(value.issues) || value.issues.length > REVIEW_ITEMS_MAX) return { ok: false, reason: 'issues_invalid' }
  const issues: PageReviewOutput['issues'] = []
  for (let index = 0; index < value.issues.length; index += 1) {
    const item = value.issues[index]
    if (!isRecord(item) || strictKeys(item, ['severity', 'area', 'issue', 'recommendation'])) return { ok: false, reason: `issues_${index}_invalid` }
    if (!['high', 'medium', 'low'].includes(String(item.severity))) return { ok: false, reason: `issues_${index}_severity` }
    const area = textValue(item.area, `issues_${index}_area`)
    const issue = textValue(item.issue, `issues_${index}_issue`, REVIEW_ITEM_MAX, true)
    const recommendation = textValue(item.recommendation, `issues_${index}_recommendation`, REVIEW_ITEM_MAX, true)
    if (!area.ok) return area
    if (!issue.ok) return issue
    if (!recommendation.ok) return recommendation
    issues.push({ severity: item.severity as PageReviewOutput['issues'][number]['severity'], area: area.value, issue: issue.value, recommendation: recommendation.value })
  }
  return { ok: true, value: { summary: summary.value, strengths: strengths.value, issues, suggestedChanges: suggestedChanges.value } }
}

function validateCopyEdit(value: unknown): Validation<CopyEditOutput> {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' }
  const extra = strictKeys(value, ['revisedText', 'changes'])
  if (extra) return { ok: false, reason: extra }
  const revisedText = textValue(value.revisedText, 'revisedText', TEXT_MAX, true)
  const changes = stringArray(value.changes, 'changes')
  if (!revisedText.ok) return revisedText
  if (!changes.ok) return changes
  return { ok: true, value: { revisedText: revisedText.value, changes: changes.value } }
}

function validateDesignReview(value: unknown): Validation<DesignReviewOutput> {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' }
  const arrayKeys = ['hierarchyIssues', 'spacingIssues', 'typographyIssues', 'chartIssues', 'recommendations'] as const
  const keys = ['overallAssessment', ...arrayKeys] as const
  const extra = strictKeys(value, keys)
  if (extra) return { ok: false, reason: extra }
  const overallAssessment = textValue(value.overallAssessment, 'overallAssessment', 1_500, true)
  if (!overallAssessment.ok) return overallAssessment
  const arrays = {} as Omit<DesignReviewOutput, 'overallAssessment'>
  for (const key of arrayKeys) {
    const validated = stringArray(value[key], key)
    if (!validated.ok) return validated
    arrays[key] = validated.value
  }
  return { ok: true, value: { overallAssessment: overallAssessment.value, ...arrays } }
}

function validateFinalReview(value: unknown): Validation<FinalReviewOutput> {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' }
  const keys = ['blockingIssues', 'nonBlockingIssues', 'suggestedFixes'] as const
  const extra = strictKeys(value, keys)
  if (extra) return { ok: false, reason: extra }
  const output = {} as FinalReviewOutput
  for (const key of keys) {
    const validated = stringArray(value[key], key)
    if (!validated.ok) return validated
    output[key] = validated.value
  }
  return { ok: true, value: output }
}

function validatePageDesignBuild(value: unknown): Validation<PageDesignBuildOutput> {
  if (!isRecord(value)) return { ok: false, reason: 'not_object' }
  const extra = strictKeys(value, ['summary', 'changedFiles', 'artifacts', 'tests', 'remainingIssues'])
  if (extra) return { ok: false, reason: extra }
  const summary = textValue(value.summary, 'summary', 2_000, true)
  const changedFiles = stringArray(value.changedFiles, 'changedFiles', { max: 100, itemMax: 500 })
  const remainingIssues = stringArray(value.remainingIssues, 'remainingIssues', { max: 30, itemMax: 1_000 })
  if (!summary.ok) return summary
  if (!changedFiles.ok) return changedFiles
  if (!remainingIssues.ok) return remainingIssues
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 30) return { ok: false, reason: 'artifacts_invalid' }
  const artifacts: PageDesignBuildOutput['artifacts'] = []
  for (const item of value.artifacts) {
    if (!isRecord(item) || strictKeys(item, ['kind', 'path']) || !['pdf', 'png', 'html'].includes(String(item.kind))) return { ok: false, reason: 'artifact_invalid' }
    const artifactPath = textValue(item.path, 'artifact_path', 1_000)
    if (!artifactPath.ok) return artifactPath
    artifacts.push({ kind: item.kind as 'pdf' | 'png' | 'html', path: artifactPath.value })
  }
  if (!Array.isArray(value.tests) || value.tests.length > 30) return { ok: false, reason: 'tests_invalid' }
  const tests: PageDesignBuildOutput['tests'] = []
  for (const item of value.tests) {
    if (!isRecord(item) || strictKeys(item, ['name', 'status', 'detail']) || !['pass', 'fail'].includes(String(item.status))) return { ok: false, reason: 'test_invalid' }
    const name = textValue(item.name, 'test_name', 200)
    const detail = typeof item.detail === 'string' && item.detail.length <= 1_000 ? item.detail.trim() : null
    if (!name.ok || detail == null) return { ok: false, reason: 'test_invalid' }
    tests.push({ name: name.value, status: item.status as 'pass' | 'fail', detail })
  }
  return { ok: true, value: { summary: summary.value, changedFiles: changedFiles.value, artifacts, tests, remainingIssues: remainingIssues.value } }
}

const PAGE_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['summary', 'strengths', 'issues', 'suggestedChanges'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 1500 },
    strengths: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
    issues: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'object', additionalProperties: false, required: ['severity', 'area', 'issue', 'recommendation'], properties: { severity: { enum: ['high', 'medium', 'low'] }, area: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX }, issue: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX }, recommendation: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } } } },
    suggestedChanges: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
  },
}

const COPY_EDIT_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['revisedText', 'changes'],
  properties: { revisedText: { type: 'string', minLength: 1, maxLength: TEXT_MAX }, changes: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } } },
}

const DESIGN_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  required: ['overallAssessment', 'hierarchyIssues', 'spacingIssues', 'typographyIssues', 'chartIssues', 'recommendations'],
  properties: {
    overallAssessment: { type: 'string', minLength: 1, maxLength: 1500 },
    hierarchyIssues: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
    spacingIssues: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
    typographyIssues: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
    chartIssues: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
    recommendations: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
  },
}

const FINAL_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['blockingIssues', 'nonBlockingIssues', 'suggestedFixes'],
  properties: {
    blockingIssues: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
    nonBlockingIssues: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
    suggestedFixes: { type: 'array', maxItems: REVIEW_ITEMS_MAX, items: { type: 'string', minLength: 1, maxLength: REVIEW_ITEM_MAX } },
  },
}

type TaskProfile<T extends ClaudeTaskId = ClaudeTaskId> = {
  id: T
  model: ClaudeCodeModel
  systemPrompt: string
  jsonSchema: Record<string, unknown>
  timeoutMs: number
  maxInputBytes: number
  validateInput: (value: unknown) => Validation<Record<string, unknown>>
  validateOutput: (value: unknown) => Validation<ClaudeTaskOutputMap[T]>
  buildPrompt: (input: Record<string, unknown>) => string
  execution: 'structured' | 'design_build'
}

function inputObject(requiredTextField?: string): (value: unknown) => Validation<Record<string, unknown>> {
  return (value) => {
    if (!isRecord(value)) return { ok: false, reason: 'input_not_object' }
    if (requiredTextField) {
      const required = textValue(value[requiredTextField], requiredTextField, INPUT_TEXT_MAX, true)
      if (!required.ok) return required
    }
    return { ok: true, value }
  }
}

function jsonPrompt(instruction: string, tag: string) {
  return (input: Record<string, unknown>) => [instruction, `<${tag}>`, JSON.stringify(input), `</${tag}>`].join('\n')
}

const REVIEW_GROUNDING = '入力JSONだけを根拠にしてください。ファイル、Web、ツール、外部知識へアクセスしたと仮定しないでください。入力にない事実を作らず、売買推奨をしないでください。'

export const CLAUDE_TASK_PROFILES: Readonly<Record<ClaudeTaskId, TaskProfile>> = {
  market_narrative: {
    id: 'market_narrative', model: 'sonnet', systemPrompt: MARKET_NARRATIVE_SYSTEM_PROMPT, jsonSchema: MARKET_NARRATIVE_JSON_SCHEMA,
    timeoutMs: 120_000, maxInputBytes: 80_000,
    validateInput: inputObject(), validateOutput: validateMarketNarrative,
    buildPrompt: jsonPrompt('以下は日次引け後レポートの集計値です。この値だけを根拠に、当日の市況ナラティブを書いてください。', 'data'), execution: 'structured',
  },
  page_review: {
    id: 'page_review', model: 'sonnet', timeoutMs: 120_000, maxInputBytes: 80_000, jsonSchema: PAGE_REVIEW_SCHEMA,
    systemPrompt: `あなたは情報設計と編集品質を評価するレビュアーです。${REVIEW_GROUNDING} 重要度を明示し、修正可能な指摘を構造化出力してください。`,
    validateInput: inputObject('page'), validateOutput: validatePageReview,
    buildPrompt: jsonPrompt('ページ内容と補足文脈をレビューしてください。', 'review_input'), execution: 'structured',
  },
  copy_edit: {
    id: 'copy_edit', model: 'sonnet', timeoutMs: 120_000, maxInputBytes: 60_000, jsonSchema: COPY_EDIT_SCHEMA,
    systemPrompt: `あなたは日本語の金融資料を明瞭で簡潔に整えるコピーエディターです。${REVIEW_GROUNDING} 数値・固有名詞・意味を変更せず、入力文だけを改善してください。`,
    validateInput: inputObject('text'), validateOutput: validateCopyEdit,
    buildPrompt: jsonPrompt('文章を校正し、変更点を列挙してください。', 'copy_input'), execution: 'structured',
  },
  design_review: {
    id: 'design_review', model: 'sonnet', timeoutMs: 120_000, maxInputBytes: 80_000, jsonSchema: DESIGN_REVIEW_SCHEMA,
    systemPrompt: `あなたは金融レポートの視覚設計を評価するデザインレビュアーです。${REVIEW_GROUNDING} 入力された画面説明・抽出テキスト・寸法だけを評価し、実装は行わないでください。`,
    validateInput: inputObject('page'), validateOutput: validateDesignReview,
    buildPrompt: jsonPrompt('ページの階層、余白、文字、チャートをレビューしてください。', 'design_input'), execution: 'structured',
  },
  final_review: {
    id: 'final_review', model: 'sonnet', timeoutMs: 120_000, maxInputBytes: 80_000, jsonSchema: FINAL_REVIEW_SCHEMA,
    systemPrompt: `あなたは完成資料の最終QAレビュアーです。${REVIEW_GROUNDING} blockingとnon-blockingを分離し、確認できない事項をPASS扱いしないでください。`,
    validateInput: inputObject('document'), validateOutput: validateFinalReview,
    buildPrompt: jsonPrompt('完成資料を最終レビューしてください。', 'final_review_input'), execution: 'structured',
  },
  page_design_build: {
    id: 'page_design_build', model: 'sonnet', timeoutMs: 15 * 60_000, maxInputBytes: 20_000,
    systemPrompt: PAGE_DESIGN_BUILD_SYSTEM_PROMPT, jsonSchema: PAGE_DESIGN_BUILD_SCHEMA,
    validateInput: (value) => {
      if (!isRecord(value)) return { ok: false, reason: 'input_not_object' }
      if (value.project !== 'page06') return { ok: false, reason: 'project_not_allowed' }
      const request = textValue(value.request, 'request', 15_000, true)
      return request.ok ? { ok: true, value: { ...value, request: request.value } } : request
    },
    validateOutput: validatePageDesignBuild,
    buildPrompt: jsonPrompt('Page Design Labを実装・生成してください。', 'page_design_build_input'),
    execution: 'design_build',
  },
}

export function getClaudeTaskProfile(task: string): TaskProfile | null {
  return (CLAUDE_TASK_IDS as readonly string[]).includes(task) ? CLAUDE_TASK_PROFILES[task as ClaudeTaskId] : null
}

export type ClaudeDispatcherErrorCode = ClaudeCodeErrorCode | 'UNKNOWN_TASK' | 'INVALID_INPUT' | 'INPUT_TOO_LARGE' | 'INVALID_OUTPUT' | 'ADAPTER_THREW' | 'WORKSPACE_INVALID' | 'POLICY_VIOLATION' | 'ARTIFACT_INVALID'

export type ClaudeDispatchResult<T extends ClaudeTaskId = ClaudeTaskId> =
  | { ok: true; task: T; provider: typeof CLAUDE_CODE_PROVIDER; model: string | null; data: ClaudeTaskOutputMap[T]; durationMs: number }
  | { ok: false; task: string; errorCode: ClaudeDispatcherErrorCode; errorMessage: string }

export type ClaudeDispatcherDeps = {
  runAdapter?: (request: ClaudeCodeRequest) => Promise<ClaudeCodeResult>
  runDesignBuild?: (request: ClaudeDesignBuildRequest) => Promise<ClaudeDesignBuildResult>
  timeoutMs?: number
}

function dispatchFailure(task: string, errorCode: ClaudeDispatcherErrorCode, message: string): ClaudeDispatchResult {
  return { ok: false, task, errorCode, errorMessage: redactSecrets(message).slice(0, 240) }
}

export async function dispatchClaudeCode<T extends ClaudeTaskId>(
  request: { task: T | string; input: unknown },
  deps: ClaudeDispatcherDeps = {},
): Promise<ClaudeDispatchResult<T>> {
  const profile = getClaudeTaskProfile(request.task)
  if (!profile) return dispatchFailure(request.task, 'UNKNOWN_TASK', 'Unknown Claude task profile') as ClaudeDispatchResult<T>

  const input = profile.validateInput(request.input)
  if (!input.ok) return dispatchFailure(request.task, 'INVALID_INPUT', input.reason) as ClaudeDispatchResult<T>

  let serialized: string
  try {
    serialized = JSON.stringify(input.value)
  } catch {
    return dispatchFailure(request.task, 'INVALID_INPUT', 'input_not_serializable') as ClaudeDispatchResult<T>
  }
  if (Buffer.byteLength(serialized, 'utf8') > profile.maxInputBytes) {
    return dispatchFailure(request.task, 'INPUT_TOO_LARGE', `maxInputBytes=${profile.maxInputBytes}`) as ClaudeDispatchResult<T>
  }

  let result: ClaudeCodeResult | ClaudeDesignBuildResult
  try {
    if (profile.execution === 'design_build') {
      const runDesignBuild = deps.runDesignBuild ?? runClaudeCodeDesignBuild
      result = await runDesignBuild({
        instruction: String(input.value.request), model: profile.model,
        systemPrompt: profile.systemPrompt, jsonSchema: profile.jsonSchema,
        timeoutMs: deps.timeoutMs ?? profile.timeoutMs,
      })
    } else {
      const runAdapter = deps.runAdapter ?? runClaudeCode
      result = await runAdapter({
        prompt: profile.buildPrompt(input.value), systemPrompt: profile.systemPrompt,
        jsonSchema: profile.jsonSchema, timeoutMs: deps.timeoutMs ?? profile.timeoutMs,
        model: profile.model,
      })
    }
  } catch {
    return dispatchFailure(request.task, 'ADAPTER_THREW', 'Claude Code adapter threw') as ClaudeDispatchResult<T>
  }
  if (!result.ok) return dispatchFailure(request.task, result.errorCode, result.errorMessage) as ClaudeDispatchResult<T>

  const output = profile.validateOutput(result.structuredOutput)
  if (!output.ok) return dispatchFailure(request.task, 'INVALID_OUTPUT', output.reason) as ClaudeDispatchResult<T>
  return {
    ok: true,
    task: request.task as T,
    provider: result.provider,
    model: result.model,
    data: output.value as ClaudeTaskOutputMap[T],
    durationMs: result.durationMs,
  }
}
