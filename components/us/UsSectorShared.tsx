// components/us/UsSectorShared.tsx
//
// /us/sectors の比較指標・並び替え・色の定義。
// 集計値は lib/server/us-market-intelligence の UsMarketGroup をそのまま使い、ここでは並べ替えと書式だけを行う。

import type { UsMarketGroup, UsMarketMomentumRow } from '@/lib/server/us-market-intelligence'
import { sicMajorGroupFromCode } from '@/lib/us-classification'
import { fmtPct, fmtRatio, fmtScore, usScreenerHref } from '@/components/us/UsMarketMomentumParts'

export type UsSectorMetric = 'pms' | 'pfs' | 'pes' | '1d' | '1w' | '1m' | 'breadth' | 'stage1'

type MetricKind = 'score' | 'return' | 'ratio'

export const US_SECTOR_METRICS: Record<UsSectorMetric, {
  label: string
  short: string
  kind: MetricKind
  /** 色の濃さが最大になる絶対値 (return / score) */
  scale: number
  value: (group: UsMarketGroup) => number | null
}> = {
  pms: { label: '平均PMS', short: 'PMS', kind: 'score', scale: 1, value: (g) => g.avgPms },
  pfs: { label: '平均PFS', short: 'PFS', kind: 'score', scale: 1, value: (g) => g.avgPfs },
  pes: { label: '平均PES', short: 'PES', kind: 'score', scale: 1, value: (g) => g.avgPes },
  '1d': { label: '平均1D', short: '1D', kind: 'return', scale: 3, value: (g) => g.avgChangePct },
  '1w': { label: '平均1W', short: '1W', kind: 'return', scale: 6, value: (g) => g.avgReturn1w },
  '1m': { label: '平均1M', short: '1M', kind: 'return', scale: 12, value: (g) => g.avgReturn1m },
  breadth: { label: 'PMS+比率', short: 'PMS+', kind: 'ratio', scale: 50, value: (g) => g.positivePmsPct },
  stage1: { label: '日A Stage 1比率', short: 'S1', kind: 'ratio', scale: 50, value: (g) => g.stage1Pct },
}

export const US_SECTOR_METRIC_ORDER: UsSectorMetric[] = ['pms', 'pfs', 'pes', '1d', '1w', '1m', 'breadth', 'stage1']

/** これ未満の銘柄数は平均が数銘柄に振られるため「少数サンプル」として扱う */
export const US_SECTOR_SMALL_SAMPLE = 5

export function parseUsSectorMetric(value: string | null): UsSectorMetric {
  return value != null && (US_SECTOR_METRIC_ORDER as string[]).includes(value) ? value as UsSectorMetric : 'pms'
}

export function fmtMetric(metric: UsSectorMetric, value: number | null | undefined): string {
  const kind = US_SECTOR_METRICS[metric].kind
  if (kind === 'score') return fmtScore(value)
  if (kind === 'return') return fmtPct(value)
  return fmtRatio(value)
}

/** 指標の降順。欠損は末尾、同値は銘柄数の多い順 → 名前順 */
export function sortUsGroups(groups: UsMarketGroup[], metric: UsSectorMetric): UsMarketGroup[] {
  const valueOf = US_SECTOR_METRICS[metric].value
  return [...groups].sort((a, b) => {
    const av = valueOf(a)
    const bv = valueOf(b)
    if (av == null && bv != null) return 1
    if (bv == null && av != null) return -1
    if (av != null && bv != null && av !== bv) return bv - av
    return b.count - a.count || a.label.localeCompare(b.label, 'en')
  })
}

/** 指標値の方向 (比率は 50% を基準、Stage 1 比率は方向を持たせない) */
function direction(metric: UsSectorMetric, value: number | null): { sign: number; strength: number } {
  if (value == null || !Number.isFinite(value)) return { sign: 0, strength: 0 }
  const meta = US_SECTOR_METRICS[metric]
  if (metric === 'stage1') return { sign: 0, strength: Math.min(1, value / 100) }
  const centered = meta.kind === 'ratio' ? value - 50 : value
  return { sign: Math.sign(centered), strength: Math.min(1, Math.abs(centered) / meta.scale) }
}

export function metricTint(metric: UsSectorMetric, value: number | null): { bg: string; border: string; accent: string; text: string } {
  const { sign, strength } = direction(metric, value)
  const alpha = (0.05 + strength * 0.25).toFixed(3)
  if (metric === 'stage1' && value != null) {
    return { bg: `rgba(0,75,147,${(0.04 + strength * 0.2).toFixed(3)})`, border: 'rgba(0,75,147,0.18)', accent: 'rgba(0,75,147,0.7)', text: 'var(--color-brand-800)' }
  }
  if (sign > 0) return { bg: `rgba(220,38,38,${alpha})`, border: 'rgba(220,38,38,0.18)', accent: 'rgba(220,38,38,0.72)', text: 'var(--color-price-up)' }
  if (sign < 0) return { bg: `rgba(37,99,235,${alpha})`, border: 'rgba(37,99,235,0.18)', accent: 'rgba(37,99,235,0.72)', text: 'var(--color-price-down)' }
  return { bg: 'var(--color-surface-subtle)', border: 'var(--color-border-soft)', accent: 'var(--color-border-default)', text: 'var(--color-text-secondary)' }
}

/** 指標値の文字色 (比率は 50% を基準) */
export function metricTextClass(metric: UsSectorMetric, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (metric === 'stage1') return 'text-[var(--color-text-primary)]'
  const { sign } = direction(metric, value)
  if (sign > 0) return 'text-[var(--color-price-up)]'
  if (sign < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

const SIC_ACRONYMS = new Set(['NEC', 'REIT', 'REITS', 'TV', 'US', 'CATV', 'LP', 'ADR'])

/**
 * SEC の SIC description は全大文字 (例: SERVICES-PREPACKAGED SOFTWARE)。密な表で読めるよう表示だけ語頭大文字にする。
 * スクリーナーへ渡す値・title 属性には元の文字列を使う。
 */
export function displaySicName(name: string): string {
  if (name !== name.toUpperCase()) return name
  return name.toLowerCase().replace(/[a-z0-9.]+/g, (word) => {
    const upper = word.toUpperCase()
    return SIC_ACRONYMS.has(upper) ? upper : word.charAt(0).toUpperCase() + word.slice(1)
  })
}

export type UsIndustryParent = { sectorCode: string; sectorLabel: string }

/** SIC industry → SEC broad sector の対応。最新日の行が持つ分類をそのまま引く (集計はしない) */
export function buildUsIndustryParents(rows: UsMarketMomentumRow[]): Map<string, UsIndustryParent> {
  const parents = new Map<string, UsIndustryParent>()
  for (const row of rows) {
    const code = row.industryCode?.trim()
    if (!code || parents.has(code) || !row.sectorCode || !row.sector) continue
    parents.set(code, { sectorCode: row.sectorCode, sectorLabel: row.sector })
  }
  return parents
}

export function usSectorsHref(params: {
  metric?: UsSectorMetric
  sector?: string | null
  sample?: 'small' | null
  industryPage?: number | null
}, hash = ''): string {
  const search = new URLSearchParams()
  if (params.metric && params.metric !== 'pms') search.set('metric', params.metric)
  if (params.sector) search.set('sector', params.sector)
  if (params.sample === 'small') search.set('sample', 'small')
  if (params.industryPage && params.industryPage > 1) search.set('industryPage', String(params.industryPage))
  const query = search.toString()
  return `/us/sectors${query ? `?${query}` : ''}${hash}`
}

/** 最新日のスクリーナーへ。/api/us/screener の sector (= sector_name 完全一致) を使う */
export function usSectorScreenerHref(sectorLabel: string): string {
  return usScreenerHref({ sector: sectorLabel, sort: 'pms', dir: 'desc' })
}

/**
 * SIC industry をスクリーナーで開く。画面の段階選択 (セクター → 業種グループ → 詳細産業) と同じ 3 条件を渡す。
 * industryGroup は SIC 上 2 桁、industry は SEC の SIC description (完全一致)。
 */
export function usIndustryScreenerHref(group: UsMarketGroup, parent: UsIndustryParent | undefined): string {
  const major = sicMajorGroupFromCode(group.key)
  return usScreenerHref({
    sector: parent?.sectorLabel ?? null,
    industryGroup: major?.code ?? null,
    industry: group.label,
    sort: 'pms',
    dir: 'desc',
  })
}
