import type { AssistantOpenAIStatus } from '@/lib/assistant/types'

export const DEFAULT_ASSISTANT_MODEL = 'gpt-5.4-mini'
export const ASSISTANT_REQUEST_TIMEOUT_MS = 9_000
export const ASSISTANT_MAX_OUTPUT_TOKENS = 700

const PLACEHOLDER_KEY_PATTERNS = [
  /^your_openai_api_key$/i,
  /^sk-proj_xxx/i,
  /^sk-xxx/i,
  /paste_openai_api_key/i,
  /example/i,
]

export interface AssistantOpenAIConfig {
  enabled: boolean
  configured: boolean
  apiKey: string | null
  model: string | null
  reason?: AssistantOpenAIStatus['reason']
}

export function isPlaceholderOpenAIKey(value: string): boolean {
  const trimmed = value.trim()
  return PLACEHOLDER_KEY_PATTERNS.some((pattern) => pattern.test(trimmed))
}

export function getAssistantOpenAIConfig(): AssistantOpenAIConfig {
  const enabled = process.env.OPENAI_ASSISTANT_ENABLED !== '0'
  const model = process.env.OPENAI_ASSISTANT_MODEL ?? process.env.OPENAI_ANALYSIS_MODEL ?? DEFAULT_ASSISTANT_MODEL
  const rawKey = process.env.OPENAI_API_KEY?.trim() ?? ''

  if (!enabled) {
    return { enabled: false, configured: false, apiKey: null, model: null, reason: 'disabled' }
  }
  if (!rawKey) {
    return { enabled: true, configured: false, apiKey: null, model: null, reason: 'missing_api_key' }
  }
  if (isPlaceholderOpenAIKey(rawKey)) {
    return { enabled: true, configured: false, apiKey: null, model: null, reason: 'placeholder_api_key' }
  }
  return { enabled: true, configured: true, apiKey: rawKey, model }
}

export function assistantOpenAIStatusFromConfig(config: AssistantOpenAIConfig): AssistantOpenAIStatus {
  return {
    enabled: config.enabled,
    configured: config.configured,
    attempted: false,
    used: false,
    model: config.configured ? config.model : null,
    reason: config.reason,
  }
}
