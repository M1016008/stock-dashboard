import type { ClassificationMomentum, DailyCloseReport, ReportTakeaway, SectorRotationRow } from '@/lib/daily-close-report'
import {
  CLAUDE_CODE_PROVIDER,
  type ClaudeCodeErrorCode,
  type ClaudeCodeRequest,
  type ClaudeCodeResult,
} from '@/lib/server/claude-code-adapter'
import {
  MARKET_NARRATIVE_HEADLINE_MAX,
  MARKET_NARRATIVE_JSON_SCHEMA,
  MARKET_NARRATIVE_PARAGRAPH_MAX,
  MARKET_NARRATIVE_PARAGRAPHS_MAX,
  MARKET_NARRATIVE_SYSTEM_PROMPT,
  dispatchClaudeCode,
  validateMarketNarrative,
  type ClaudeDispatcherErrorCode,
} from '@/lib/server/claude-code-dispatcher'

// Daily close report の Narrative を Claude Code subscription 経由で生成する独立経路。
// 既存の deterministic takeaways (buildTakeaways) は変更せず、失敗時はそれをそのまま返す。
// Phase 1 では既存レポート生成経路・UI には組み込まない。

export const NARRATIVE_HEADLINE_MAX = MARKET_NARRATIVE_HEADLINE_MAX
export const NARRATIVE_PARAGRAPH_MAX = MARKET_NARRATIVE_PARAGRAPH_MAX
export const NARRATIVE_PARAGRAPHS_MAX = MARKET_NARRATIVE_PARAGRAPHS_MAX
export const NARRATIVE_JSON_SCHEMA = MARKET_NARRATIVE_JSON_SCHEMA
export const NARRATIVE_SYSTEM_PROMPT = MARKET_NARRATIVE_SYSTEM_PROMPT

export type Narrative = { headline: string; paragraphs: string[] }

export type NarrativeFallbackReason = ClaudeCodeErrorCode | ClaudeDispatcherErrorCode | 'INVALID_OUTPUT' | 'ADAPTER_THREW'

export type DailyCloseNarrative =
  | ({ source: typeof CLAUDE_CODE_PROVIDER; model: string | null; durationMs: number } & Narrative)
  | ({ source: 'deterministic'; takeaways: Record<number, ReportTakeaway>; fallbackReason: NarrativeFallbackReason } & Narrative)

export type NarrativeDeps = {
  run?: (request: ClaudeCodeRequest) => Promise<ClaudeCodeResult>
  timeoutMs?: number
}

export function validateNarrative(value: unknown): { ok: true; narrative: Narrative } | { ok: false; reason: string } {
  const validated = validateMarketNarrative(value)
  return validated.ok ? { ok: true, narrative: validated.value } : { ok: false, reason: validated.reason }
}

function round2(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100
}

function sectorView(row: SectorRotationRow) {
  return { name: row.name, return1D: round2(row.return1D), return5D: round2(row.return5D), rankChange: row.rankChange }
}

function classificationView(row: ClassificationMomentum) {
  return {
    name: row.name,
    meanReturn1W: round2(row.oneWeek.meanReturn),
    medianReturn1W: round2(row.oneWeek.medianReturn),
    winRate1W: round2(row.oneWeek.winRate),
    lowSample: row.oneWeek.lowSample,
  }
}

function orderedTakeaways(takeaways: Record<number, ReportTakeaway>): ReportTakeaway[] {
  return Object.keys(takeaways).map(Number).sort((a, b) => a - b).map((key) => takeaways[key])
}

// Claude に渡す集計値。銘柄単位の明細・Watchlist の銘柄コードは渡さない。
// 比較を汚染しないよう、既存の deterministic takeaways (report.takeaways) も渡さない。
export function buildNarrativeInput(report: DailyCloseReport) {
  const byOneWeek = [...report.classifications60]
    .filter((row) => row.oneWeek.meanReturn != null)
    .sort((a, b) => b.oneWeek.meanReturn! - a.oneWeek.meanReturn!)
  return {
    reportDate: report.reportDate,
    priceDate: report.priceDate,
    current: report.current,
    dataStatus: {
      jpPrice: report.dataStatus.jpPrice.status,
      jpDerived: report.dataStatus.jpDerived.status,
      trigger: report.dataStatus.trigger.status,
      largeHolder: report.dataStatus.largeHolder.status,
    },
    market: {
      advances: report.market.advances,
      declines: report.market.declines,
      unchanged: report.market.unchanged,
      newHighs: report.market.newHighs,
      newLows: report.market.newLows,
      tradingValue: report.market.tradingValue,
      indices: report.market.indices.map((index) => ({ label: index.label, value: round2(index.value), changePct: round2(index.changePct), note: index.note ?? null })),
    },
    sectors33: { top: report.sectors33.slice(0, 3).map(sectorView), bottom: report.sectors33.slice(-3).map(sectorView) },
    classifications60OneWeek: { top: byOneWeek.slice(0, 3).map(classificationView), bottom: byOneWeek.slice(-3).map(classificationView) },
    trigger: {
      available: report.trigger.available,
      candidateCount: report.trigger.candidateCount,
      currentCounts: report.trigger.currentCounts,
      previousCounts: report.trigger.previousCounts,
    },
    watchlist: { total: report.watchlist.total, changedCount: report.watchlist.changed.length },
    events: {
      earningsCount: report.events.earnings.length,
      largeHolderStatus: report.events.largeHolder.status,
      largeHolderEventCount: report.events.largeHolder.events.length,
    },
  }
}

export function buildNarrativePrompt(report: DailyCloseReport): string {
  return [
    '以下は日次引け後レポートの集計値です。この値だけを根拠に、当日の市況ナラティブを書いてください。',
    '<data>',
    JSON.stringify(buildNarrativeInput(report)),
    '</data>',
  ].join('\n')
}

// Claude 失敗時の fallback。既存の report.takeaways をそのまま使う。
export function deterministicNarrative(report: DailyCloseReport, fallbackReason: NarrativeFallbackReason): DailyCloseNarrative {
  const ordered = orderedTakeaways(report.takeaways)
  return {
    source: 'deterministic',
    headline: ordered[0]?.headline ?? '日次引け後レポート',
    paragraphs: ordered.map((takeaway) => takeaway.detail.length ? `${takeaway.headline}（${takeaway.detail.join(' / ')}）` : takeaway.headline),
    takeaways: report.takeaways,
    fallbackReason,
  }
}

export async function generateClaudeNarrative(report: DailyCloseReport, deps: NarrativeDeps = {}): Promise<DailyCloseNarrative> {
  const result = await dispatchClaudeCode(
    { task: 'market_narrative', input: buildNarrativeInput(report) },
    { runAdapter: deps.run, timeoutMs: deps.timeoutMs },
  )
  if (!result.ok) return deterministicNarrative(report, result.errorCode)

  const validated = validateNarrative(result.data)
  if (!validated.ok) return deterministicNarrative(report, 'INVALID_OUTPUT')
  return { source: CLAUDE_CODE_PROVIDER, model: result.model, durationMs: result.durationMs, ...validated.narrative }
}
