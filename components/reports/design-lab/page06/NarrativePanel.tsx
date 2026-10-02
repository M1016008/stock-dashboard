import type { Page06Narrative } from '@/lib/daily-close-page06-narrative-content'

// Claude Narrative 表示 (headline 行 / 事実・解釈・注意点)。
// 文章の生成・検証・fallback は lib/daily-close-page06-narrative-content.ts と
// lib/server/daily-close-page06-narrative.ts。ここは表示のみ。

export type Page06NarrativeSource =
  | { kind: 'claude'; model: string | null }
  | { kind: 'deterministic'; reason: string | null }

export function narrativeSourceLabel(source: Page06NarrativeSource): string {
  return source.kind === 'claude'
    ? `Claude Code subscription (${source.model ?? 'sonnet'})`
    : `deterministic${source.reason ? ` (fallback: ${source.reason})` : ''}`
}

export function HeadlineRow({ narrative, source }: { narrative: Page06Narrative; source: Page06NarrativeSource }) {
  return (
    <div className="headlineRow">
      <strong>{narrative.headline}</strong>
      <span className="sourceBadge">{source.kind === 'claude' ? 'CLAUDE' : 'DETERMINISTIC'}</span>
    </div>
  )
}

export function NarrativePanel({ narrative }: { narrative: Page06Narrative }) {
  return (
    <div className="narrative">
      <div><span>事実</span><p>{narrative.fact}</p></div>
      <div><span>解釈</span><p>{narrative.interpretation}</p></div>
      <div><span>注意点</span><p>{narrative.caveat}</p></div>
    </div>
  )
}
