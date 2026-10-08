'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { StageTag } from '@/components/ui/StageTag'
import {
  SIGNAL_AREA,
  SIGNAL_DETAIL_INDENT,
  SIGNAL_ROW_GRID,
  SIGNAL_SUB_GRID,
  TONE_TEXT,
  signedTextClass,
} from '@/components/dashboard/DashboardPrimitives'
import {
  dashboardIndustryOptions,
  dashboardIndustryValue,
  type DashboardIndustryLevel,
} from '@/lib/dashboard-trade-signal-filters'
import { formatShortTermStrength } from '@/lib/short-term-check'
import type {
  DashboardScenarioInterval,
  DashboardTradeSignalMarket,
  DashboardTradeSignalResult,
  DashboardTradeSignalRow,
  DashboardTradeSignalSide,
} from '@/lib/queries/dashboard-trade-signals'

type SideFilter = DashboardTradeSignalSide
type MarketFilter = DashboardTradeSignalMarket
type IndustryLevel = DashboardIndustryLevel
type SortKey = 'confidence' | 'avgVolume' | 'industry' | 'changePct' | 'pms' | 'pfs' | 'physicalStatus'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'confidence', label: '確度スコア' },
  { value: 'avgVolume', label: '平均出来高' },
  { value: 'industry', label: '業種' },
  { value: 'changePct', label: '騰落率' },
  { value: 'pms', label: 'PMS' },
  { value: 'pfs', label: 'PFS' },
  { value: 'physicalStatus', label: '物理状態' },
]

const SCENARIO_INTERVAL_OPTIONS: Array<{
  value: DashboardScenarioInterval
  label: string
  detail: string
}> = [
  { value: 'D', label: '1日', detail: '日足 / 5営業日先' },
  { value: '2D', label: '2日', detail: '2日足 / 10営業日先' },
  { value: 'W', label: '1週間', detail: '週足 / 20営業日先' },
  { value: '2W', label: '2週間', detail: '2週足 / 40営業日先' },
  { value: 'M', label: '1か月', detail: '月足 / 60営業日先' },
  { value: '2M', label: '2か月', detail: '2ヶ月足 / 120営業日先' },
]

/** 一覧の上限は従来どおり 60 件。最初は 20 件だけ描き、残りは操作で開く (順位は変えない) */
const MAX_ROWS = 60
const PAGE_ROWS = 20

const RANGE_TEXT = 'text-[#b45309]'
const RANGE_FILL = '#d97706'

/** 見た目は小さいまま、押せる範囲だけ上下に 8px ずつ広げる (h-7 で 44px 相当) */
const HIT_AREA_Y = "relative after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']"

/** 形状根拠・判断ポイントを最初に見せる件数。残りは詳細内の開閉で読む */
const EVIDENCE_PREVIEW = 5
const DECISION_PREVIEW = 3

function scenarioHref(currentSearch: string, interval: DashboardScenarioInterval): string {
  const params = new URLSearchParams(currentSearch)
  params.set('scenarioInterval', interval)
  const query = params.toString()
  return `/${query ? `?${query}` : ''}#trade-signals`
}

function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function fmtCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPrice(value: number | null | undefined, market: DashboardTradeSignalMarket): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (market === 'US') return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function sideLabel(side: DashboardTradeSignalSide): string {
  return side === 'buy' ? '買う' : '売る'
}

function sideTextClass(side: DashboardTradeSignalSide): string {
  return side === 'buy' ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

function sideRuleClass(side: DashboardTradeSignalSide): string {
  return side === 'buy' ? 'border-l-[var(--color-price-up)]' : 'border-l-[var(--color-price-down)]'
}

function industryValue(row: DashboardTradeSignalRow, level: IndustryLevel): string {
  return dashboardIndustryValue(row, level)
}

function sortValue(row: DashboardTradeSignalRow, sort: SortKey, industryLevel: IndustryLevel): number | string {
  switch (sort) {
    case 'avgVolume': return row.avgVolume ?? -Infinity
    case 'industry': return industryValue(row, industryLevel)
    case 'changePct': return row.changePct ?? -Infinity
    case 'pms': return row.pms ?? -Infinity
    case 'pfs': return row.pfs ?? -Infinity
    case 'physicalStatus': return row.physicalStatusScore ?? -Infinity
    case 'confidence':
    default:
      return row.confidenceScore
  }
}

function compareRows(a: DashboardTradeSignalRow, b: DashboardTradeSignalRow, sort: SortKey, industryLevel: IndustryLevel): number {
  const av = sortValue(a, sort, industryLevel)
  const bv = sortValue(b, sort, industryLevel)
  if (typeof av === 'string' || typeof bv === 'string') {
    const cmp = String(av).localeCompare(String(bv), 'ja')
    if (cmp !== 0) return cmp
    return b.confidenceScore - a.confidenceScore
  }
  if (av !== bv) return Number(bv) - Number(av)
  return a.ticker.localeCompare(b.ticker)
}

function scenarioDirectionClass(direction: 'up' | 'down' | 'range' | 'mixed'): string {
  if (direction === 'up') return 'text-[var(--color-price-up)]'
  if (direction === 'down') return 'text-[var(--color-price-down)]'
  if (direction === 'range') return RANGE_TEXT
  return 'text-[var(--color-text-secondary)]'
}

function scenarioDirectionLabel(direction: 'up' | 'down' | 'range' | 'mixed'): string {
  if (direction === 'up') return '上昇優勢'
  if (direction === 'down') return '下落優勢'
  if (direction === 'range') return '横ばい優勢'
  return '拮抗'
}

function scenarioDecisionClass(tone: string): string {
  if (tone === 'constructive') return 'border-l-[var(--color-price-up)]'
  if (tone === 'caution') return 'border-l-[var(--color-price-down)]'
  if (tone === 'conflict') return 'border-l-[#d97706]'
  return 'border-l-[var(--color-border-strong)]'
}

function shapeEvidenceSentence(chip: string): string {
  if (chip.startsWith('総合:')) return chip.replace('総合:', '総合は')
  if (chip === '日足: 5/25日線上') return '日足は5日線・25日線の上で推移'
  if (chip === '日足: 5/25日線下') return '日足は5日線・25日線を下回る'
  if (chip === '日足: 5日線上抜け') return '日足は5日線を上抜け'
  if (chip === '日足: 5日線下抜け') return '日足は5日線を下抜け'
  if (chip === '日足: 25日線上抜け') return '日足は25日線を上抜け'
  if (chip === '日足: 25日線下抜け') return '日足は25日線を下抜け'
  if (chip === '日足: MA束収縮') return '日足のMA束は収縮。次の拡散方向を確認'
  if (chip === '日足: MA束拡散') return '日足のMA束は拡散。方向性が出ている'
  if (chip === '週足: 5/13週線上') return '週足は5週線・13週線の上'
  if (chip === '週足: 5/13週線下') return '週足は5週線・13週線を下回る'
  if (chip === '週足: 5週線上向き') return '週足5週線は上向き'
  if (chip === '週足: 5週線下向き') return '週足5週線は下向き'
  if (chip === '2日足: 5/25本線上') return '2日足は5本線・25本線の上'
  if (chip === '2日足: 5/25本線下') return '2日足は5本線・25本線を下回る'
  if (chip === '2週足: 5/13本線上') return '2週足は5本線・13本線の上'
  if (chip === '2週足: 5/13本線下') return '2週足は5本線・13本線を下回る'
  if (chip === '物理: 上昇加速') return '物理状態は上昇加速'
  if (chip === '物理: 下落加速') return '物理状態は下落加速'
  if (chip === '物理: 反落警戒') return '物理状態は反落警戒'
  if (chip === '物理: 反発兆候') return '物理状態は反発兆候'
  if (chip.startsWith('日A: S')) return chip.replace('日A:', '日足ステージ')
  if (chip.startsWith('週A: S')) return chip.replace('週A:', '週足ステージ')
  if (chip.startsWith('物理ML上昇#')) return `${chip}が買い側を補強`
  if (chip.startsWith('物理ML下落#')) return `${chip}が売り側を補強`
  if (chip.startsWith('ML上昇#')) return `${chip}が買い側を補強`
  if (chip.startsWith('ML下落#')) return `${chip}が売り側を補強`
  if (chip.startsWith('シナリオ上昇')) return chip.replace('シナリオ', 'シナリオは')
  if (chip.startsWith('シナリオ下落')) return chip.replace('シナリオ', 'シナリオは')
  if (chip.startsWith('シナリオ横ばい')) return chip.replace('シナリオ', 'シナリオは')
  if (chip.startsWith('#1 ')) return `最上位シナリオは${chip.replace('#1 ', '')}`
  if (chip.startsWith('物理状態: ')) return chip.replace('物理状態: ', '物理状態は')
  if (chip.startsWith('注意: ')) return chip
  return chip.replace(/: /g, 'は')
}

function evidencePointClass(point: string): string {
  if (/下|割|警戒|失速|売り|売る|鈍化|弱|注意/.test(point)) return 'before:bg-[var(--color-price-down)]'
  if (/上|突破|反発|好転|強|加速|継続|支持|買い|買う/.test(point)) return 'before:bg-[var(--color-price-up)]'
  if (/収縮|拡散|横|拮抗|過熱|確認/.test(point)) return 'before:bg-[#d97706]'
  return 'before:bg-[var(--color-border-strong)]'
}

type SignalEvidence = { points: string[]; risks: string[] }

/**
 * 形状根拠と注意を分けて返す。件数では切らない (表示側で先頭だけ見せ、残りは開閉)。
 * 注意 (riskChips) は末尾に並ぶため、件数で切ると最初に消える。別欄で常に全件出す。
 */
function shapeEvidence(row: DashboardTradeSignalRow): SignalEvidence {
  const raw = [
    `総合:${row.primaryLabel}。物理状態は${row.physicalStatusLabel}`,
    `短期:${row.shortTermCheckLabel} / ${formatShortTermStrength(row.shortTermCheckLabel, row.shortTermCheckScore)}`,
    ...row.technicalChips,
    ...row.evidenceChips,
  ]
  return {
    points: Array.from(new Set(raw.map(shapeEvidenceSentence))),
    risks: Array.from(new Set(row.riskChips)),
  }
}

function decisionPoints(row: DashboardTradeSignalRow): string[] {
  const scenario = row.scenario
  if (!scenario) return []
  const points = scenario.decisionPoints?.length ? scenario.decisionPoints : [scenario.decisionSummary]
  // 「崩れる条件: …」は専用欄に全文があるので、ここでは重ねない
  return Array.from(new Set(scenario.invalidation ? points.filter((point) => !point.startsWith('崩れる条件:')) : points))
}

/**
 * 並び替えの根拠になる値のうち、今の幅で列が隠れているもの。
 * hiddenFrom: この幅以上では一覧の列に値が出ている (= タグは要らない)
 */
type SortBasis = {
  label: string
  value: React.ReactNode
  title: string
  hiddenFrom: 'md' | 'lg' | 'xl'
}

function sortBasis(row: DashboardTradeSignalRow, sort: SortKey, industryLevel: IndustryLevel): SortBasis | null {
  switch (sort) {
    case 'avgVolume':
      // 出来高列は lg から
      return {
        label: '出来高',
        value: <span className="font-mono tabular-nums">{fmtCompact(row.avgVolume)}</span>,
        title: `平均出来高 ${fmtCompact(row.avgVolume)} (${row.avgVolumeLabel})`,
        hiddenFrom: 'lg',
      }
    case 'industry':
      // 業種は md から銘柄セル 2 段目に出る
      return {
        label: '業種',
        value: <span className="min-w-0 truncate">{industryValue(row, industryLevel)}</span>,
        title: `${industryLevel}業種: ${industryValue(row, industryLevel)}`,
        hiddenFrom: 'md',
      }
    case 'physicalStatus':
      // 物理状態の文言は xl から。並びはスコア順なので値も添える
      return {
        label: '物理',
        value: (
          <>
            <span className="min-w-0 truncate">{row.physicalStatusLabel}</span>
            <span className="shrink-0 font-mono tabular-nums">{fmtNumber(row.physicalStatusScore, 1)}</span>
          </>
        ),
        title: `物理状態 ${row.physicalStatusLabel} / スコア ${fmtNumber(row.physicalStatusScore, 1)}`,
        hiddenFrom: 'xl',
      }
    default:
      // 確度・騰落率・PMS・PFS はどの幅でも行内に見えている
      return null
  }
}

/* ---------- 行のセル ---------- */

/** 順位と確度。高確度 (confidenceBand=high) だけ塗りで示し、優先度を一目で分ける */
function RankScoreCell({ row, rank }: { row: DashboardTradeSignalRow; rank: number }) {
  const high = row.confidenceBand === 'high'
  return (
    <div className={`${SIGNAL_AREA.sc} flex flex-col items-start gap-0.5 self-start md:flex-row md:items-center md:gap-1 md:self-center`}>
      <span className="font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)] max-md:order-2 md:w-6 md:text-right">
        <span className="sr-only">順位</span>#{rank}
      </span>
      <span
        title={`確度スコア ${row.confidenceScore}${high ? ' (高確度)' : ''}`}
        className={`inline-flex h-6 w-9 items-center justify-center rounded-[2px] font-mono text-[13px] font-bold tabular-nums ${high ? 'bg-[var(--color-brand-900)] text-white' : 'bg-[var(--color-surface-muted)] text-[var(--color-brand-900)]'}`}
      >
        <span className="sr-only">確度スコア</span>
        {row.confidenceScore}
      </span>
    </div>
  )
}

/** 並び替えの根拠値。列が隠れる幅でだけ、銘柄セルの空きに小さく出す (行の高さは変えない) */
function SortBasisTag({ basis, className }: { basis: SortBasis; className: string }) {
  return (
    <span
      title={basis.title}
      className={`min-w-0 max-w-full items-baseline gap-1 overflow-hidden whitespace-nowrap rounded-[2px] bg-[var(--color-surface-muted)] px-1 text-[10px] font-semibold leading-4 text-[var(--color-brand-800)] ${className}`}
    >
      <span className="sr-only">並び替え基準 </span>
      <span className="shrink-0 text-[var(--color-text-tertiary)]">{basis.label}</span>
      <span className="flex min-w-0 items-baseline gap-1 overflow-hidden">{basis.value}</span>
    </span>
  )
}

const SORT_TAG_MD_VISIBILITY: Record<SortBasis['hiddenFrom'], string> = {
  md: 'hidden',
  lg: 'hidden md:inline-flex lg:hidden',
  xl: 'hidden md:inline-flex xl:hidden',
}

function IdentityCell({ row, industryLevel, sort }: { row: DashboardTradeSignalRow; industryLevel: IndustryLevel; sort: SortKey }) {
  const basis = sortBasis(row, sort, industryLevel)
  return (
    <div className={`${SIGNAL_AREA.id} grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-1.5 md:grid-cols-[auto_minmax(0,1fr)_auto]`}>
      <Link
        href={row.href}
        prefetch={false}
        className="col-start-1 row-start-1 font-mono text-[13px] font-bold leading-6 text-[var(--color-brand-800)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]"
      >
        {row.ticker}
      </Link>
      <Link
        href={row.href}
        prefetch={false}
        title={row.name}
        className="col-span-3 row-start-2 min-w-0 truncate text-[12px] font-semibold leading-4 text-[var(--color-text-primary)] hover:text-[var(--color-brand-700)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)] md:col-span-1 md:col-start-2 md:row-start-1"
      >
        {row.name}
      </Link>
      <StockPreviewTrigger
        ticker={row.ticker}
        market={row.market}
        analysisDate={row.date}
        context="home"
        className="col-start-2 row-start-1 justify-self-start md:col-start-3 md:justify-self-end"
      />
      {/* 390: 銘柄コード行の右の空きに出す (縦位置を揃えて並びを追えるよう右寄せ) */}
      {basis && (
        <SortBasisTag basis={basis} className="col-start-3 row-start-1 inline-flex justify-self-end md:hidden" />
      )}
      <div className="hidden min-w-0 items-baseline gap-1.5 text-[10px] font-semibold leading-4 text-[var(--color-text-tertiary)] md:col-span-3 md:row-start-2 md:flex">
        <span className="min-w-0 truncate">
          {industryValue(row, industryLevel)}
          {row.marketSegment && <span> · {row.marketSegment}</span>}
        </span>
        {/* md〜: 業種行の右端。列が出る幅になったら消す */}
        {basis && (
          <SortBasisTag basis={basis} className={`ml-auto shrink-0 ${SORT_TAG_MD_VISIBILITY[basis.hiddenFrom]}`} />
        )}
      </div>
    </div>
  )
}

function PriceCell({ row }: { row: DashboardTradeSignalRow }) {
  return (
    <div className={`${SIGNAL_AREA.px} whitespace-nowrap text-right font-mono tabular-nums`}>
      <div className="text-[13px] font-bold leading-5 text-[var(--color-text-primary)]">{fmtPrice(row.price, row.market)}</div>
      <div className={`text-[11px] font-bold leading-4 ${signedTextClass(row.changePct)}`}>
        <span className="sr-only">前日比</span>
        {fmtPct(row.changePct)}
      </div>
    </div>
  )
}

function ScenarioCell({ row }: { row: DashboardTradeSignalRow }) {
  const scenario = row.scenario
  if (!scenario) {
    return (
      <div className={`${SIGNAL_AREA.sn} text-[10px] font-semibold leading-tight text-[var(--color-text-tertiary)]`}>
        シナリオ生成データ不足
      </div>
    )
  }
  return (
    <div className={`${SIGNAL_AREA.sn} flex min-w-0 items-baseline gap-x-2 md:flex-col md:items-start md:gap-0`}>
      <span className={`whitespace-nowrap text-[12px] font-bold leading-5 ${scenarioDirectionClass(scenario.leader)}`}>
        {scenarioDirectionLabel(scenario.leader)}
      </span>
      <span className="whitespace-nowrap font-mono text-[11px] font-bold leading-4 tabular-nums text-[var(--color-brand-900)]" title="シナリオスコア">
        <span className="font-sans text-[9px] font-semibold text-[var(--color-text-tertiary)] md:sr-only">スコア </span>
        {scenario.scenarioScore}
      </span>
    </div>
  )
}

/** シナリオの上/横/下の重み (既存の %) を 1 本の積み上げバーと 3 つの数値で描く */
function WeightCell({ row }: { row: DashboardTradeSignalRow }) {
  const scenario = row.scenario
  if (!scenario) {
    return <div className={`${SIGNAL_AREA.wt} font-mono text-[11px] text-[var(--color-text-tertiary)]`}>-</div>
  }
  const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0)
  const parts = [
    { key: 'up', label: '上', value: scenario.upWeightPct, fill: 'var(--color-price-up)', text: 'text-[var(--color-price-up)]' },
    { key: 'range', label: '横', value: scenario.rangeWeightPct, fill: RANGE_FILL, text: RANGE_TEXT },
    { key: 'down', label: '下', value: scenario.downWeightPct, fill: 'var(--color-price-down)', text: 'text-[var(--color-price-down)]' },
  ]
  return (
    <div className={`${SIGNAL_AREA.wt} min-w-0`}>
      <div className="flex h-[6px] overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]" aria-hidden="true">
        {parts.map((part) => (
          <span key={part.key} style={{ width: `${clamp(part.value)}%`, background: part.fill, opacity: part.key === 'range' ? 0.6 : 0.78 }} />
        ))}
      </div>
      <div className="mt-1 flex justify-between gap-1 font-mono text-[10px] font-bold leading-3 tabular-nums">
        {parts.map((part) => (
          <span key={part.key} className={`whitespace-nowrap ${part.text}`}>
            <span className="font-sans md:sr-only">{part.label} </span>
            {part.value.toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  )
}

function TopScenarioCell({ row }: { row: DashboardTradeSignalRow }) {
  const scenario = row.scenario
  return (
    <div className={`${SIGNAL_AREA.tp} min-w-0`}>
      {scenario ? (
        <div className="flex min-w-0 items-baseline gap-1 text-[11px] leading-4" title={`#1 ${scenario.topLabel} / ${scenario.topScore}`}>
          <span className="shrink-0 font-mono text-[10px] font-bold text-[var(--color-text-tertiary)]">#1</span>
          <span className="min-w-0 truncate font-semibold text-[var(--color-text-primary)]">{scenario.topLabel}</span>
          <span className="shrink-0 font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{scenario.topScore}</span>
        </div>
      ) : (
        <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">-</span>
      )}
    </div>
  )
}

function TargetStopCell({ row }: { row: DashboardTradeSignalRow }) {
  const scenario = row.scenario
  return (
    <div className={`${SIGNAL_AREA.ts} flex min-w-0 flex-wrap items-baseline gap-x-3 font-mono text-[11px] font-semibold leading-4 tabular-nums text-[var(--color-text-secondary)] xl:flex-col xl:items-end xl:gap-0`}>
      <span className="whitespace-nowrap">
        <span className="mr-1 font-sans text-[9px] font-semibold text-[var(--color-text-tertiary)]">目標</span>
        {fmtPrice(scenario?.targetPrice, row.market)}
      </span>
      <span className="whitespace-nowrap">
        <span className="mr-1 font-sans text-[9px] font-semibold text-[var(--color-text-tertiary)]">撤退</span>
        {fmtPrice(scenario?.stopPrice, row.market)}
      </span>
    </div>
  )
}

function StageCell({ row }: { row: DashboardTradeSignalRow }) {
  const groups = [
    ['日', row.stages.dailyA, row.stages.dailyB],
    ['週', row.stages.weeklyA, row.stages.weeklyB],
    ['月', row.stages.monthlyA, row.stages.monthlyB],
  ] as const
  return (
    <div className={`${SIGNAL_AREA.st} grid w-fit grid-cols-3 gap-x-1.5 md:w-auto`}>
      {groups.map(([label, a, b]) => (
        <span
          key={label}
          className="inline-flex items-center gap-0.5 md:justify-center"
          title={`${label}A: ${a ?? '未算出'} / ${label}B: ${b ?? '未算出'}`}
        >
          <span className="w-3 text-[9px] font-bold text-[var(--color-text-tertiary)] md:sr-only">{label}</span>
          <StageTag stage={a} size="xs" />
          <StageTag stage={b} size="xs" />
        </span>
      ))}
    </div>
  )
}

function PhysicsCell({ row, sortByStatus }: { row: DashboardTradeSignalRow; sortByStatus: boolean }) {
  return (
    <div className={`${SIGNAL_AREA.ph} min-w-0`}>
      <dl className="grid grid-cols-3 gap-x-1.5 font-mono tabular-nums">
        {([
          ['PMS', row.pms],
          ['PFS', row.pfs],
          ['PES', row.pes],
        ] as const).map(([label, value]) => (
          <div key={label} className="min-w-0 text-right">
            <dt className="text-[9px] font-semibold leading-3 text-[var(--color-text-tertiary)] md:sr-only">{label}</dt>
            <dd className={`text-[11px] font-bold leading-4 ${signedTextClass(value)}`}>{fmtNumber(value, 2)}</dd>
          </div>
        ))}
      </dl>
      <div
        className={`hidden truncate text-right text-[10px] font-semibold leading-4 xl:block ${sortByStatus ? 'text-[var(--color-brand-800)]' : 'text-[var(--color-text-tertiary)]'}`}
        title={`物理状態: ${row.physicalStatusLabel} / スコア ${fmtNumber(row.physicalStatusScore, 1)}`}
      >
        {row.physicalStatusLabel}
        {/* 物理状態で並べたときは、並びの根拠 (スコア) も添える */}
        {sortByStatus && <span className="ml-1 font-mono tabular-nums">{fmtNumber(row.physicalStatusScore, 1)}</span>}
      </div>
    </div>
  )
}

function VolumeCell({ row }: { row: DashboardTradeSignalRow }) {
  return (
    <div
      className={`${SIGNAL_AREA.vo} whitespace-nowrap text-right font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-secondary)]`}
      title={`平均出来高 ${fmtCompact(row.avgVolume)} · ${row.avgVolumeLabel}`}
    >
      {fmtCompact(row.avgVolume)}
    </div>
  )
}

/* ---------- 詳細 (判断ポイント・崩れる条件・形状根拠・銘柄情報) ---------- */

function DetailHeading({
  children,
  count,
  className = 'text-[var(--color-text-tertiary)]',
}: {
  children: React.ReactNode
  count?: number
  className?: string
}) {
  return (
    <h4 className={`mb-1 text-[10px] font-bold ${className}`}>
      {children}
      {count != null && <span className="ml-1 font-mono font-semibold tabular-nums">{count}</span>}
    </h4>
  )
}

/** 先頭 limit 件だけ見せ、残りは開閉で読む。件数で捨てない */
function ExpandableList({
  items,
  limit,
  className,
  renderItem,
}: {
  items: string[]
  limit: number
  className: string
  renderItem: (item: string) => React.ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const rest = items.length - limit
  const shown = expanded || rest <= 0 ? items : items.slice(0, limit)
  return (
    <>
      <ul id={listId} className={className}>
        {shown.map(renderItem)}
      </ul>
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={listId}
          className={`${HIT_AREA_Y} mt-0.5 inline-flex h-7 items-center gap-1 rounded-[3px] text-[10px] font-bold text-[var(--color-brand-700)] hover:text-[var(--color-brand-900)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]`}
        >
          <ChevronDown size={12} aria-hidden="true" className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? '先頭だけに戻す' : <>残り<span className="font-mono tabular-nums">{rest}</span>件を表示</>}
        </button>
      )}
    </>
  )
}

const EVIDENCE_ITEM_CLASS =
  "relative pl-2.5 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)] before:absolute before:left-0 before:top-[0.6em] before:h-[5px] before:w-[5px] before:rounded-[1px] before:content-['']"

function SignalDetail({
  row,
  id,
  open,
  evidence,
  points,
}: {
  row: DashboardTradeSignalRow
  id: string
  open: boolean
  evidence: SignalEvidence
  points: string[]
}) {
  const scenario = row.scenario
  const hasDownside = Boolean(scenario?.invalidation) || evidence.risks.length > 0
  return (
    <div
      id={id}
      hidden={!open}
      className={`${open ? 'grid' : 'hidden'} mt-2 gap-x-6 gap-y-3 border-t border-dashed border-[var(--color-border-soft)] pb-1 pt-2.5 md:grid-cols-2 lg:grid-cols-3 ${SIGNAL_DETAIL_INDENT}`}
    >
      <section className="min-w-0">
        <DetailHeading>判断ポイント</DetailHeading>
        {scenario ? (
          <>
            <div className="mb-1 font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
              {scenario.intervalLabel} · {scenario.horizonDays}営業日 · 基準 {scenario.baseDate}
            </div>
            <ExpandableList
              items={points}
              limit={DECISION_PREVIEW}
              className={`grid gap-0.5 border-l-2 pl-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)] ${scenarioDecisionClass(scenario.decisionTone)}`}
              renderItem={(point) => <li key={point}>{point}</li>}
            />
            {/* md 以上は一覧の列に #1 がある。390 だけここで読む */}
            <div className="mt-1.5 text-[11px] font-bold text-[var(--color-text-primary)] md:hidden">
              #1 {scenario.topLabel} <span className="font-mono tabular-nums text-[var(--color-text-tertiary)]">/ {scenario.topScore}</span>
            </div>
          </>
        ) : (
          <p className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">シナリオ生成データ不足</p>
        )}
      </section>

      {/* 下振れ側の情報 (崩れる条件・注意) は 1 列にまとめ、件数で切らずに全件出す */}
      {hasDownside && (
        <section className="grid min-w-0 content-start gap-2.5 md:border-l md:border-[var(--color-border-soft)] md:pl-4">
          {scenario?.invalidation && (
            <div className="min-w-0">
              <DetailHeading>崩れる条件</DetailHeading>
              <p className="text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{scenario.invalidation}</p>
            </div>
          )}
          {evidence.risks.length > 0 && (
            <div className="min-w-0">
              <DetailHeading count={evidence.risks.length} className={TONE_TEXT.warning}>注意</DetailHeading>
              <ul className="grid gap-0.5">
                {evidence.risks.map((risk) => (
                  <li key={risk} className={`${EVIDENCE_ITEM_CLASS} before:bg-[#d97706]`}>
                    {risk}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {evidence.points.length > 0 && (
        <section className="min-w-0 lg:border-l lg:border-[var(--color-border-soft)] lg:pl-4">
          <DetailHeading count={evidence.points.length}>形状根拠</DetailHeading>
          <ExpandableList
            items={evidence.points}
            limit={EVIDENCE_PREVIEW}
            className="grid gap-0.5"
            renderItem={(point) => (
              <li key={point} className={`${EVIDENCE_ITEM_CLASS} ${evidencePointClass(point)}`}>
                {point}
              </li>
            )}
          />
        </section>
      )}

      <div className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)] md:col-span-2 lg:col-span-3">
        <span className="font-mono tabular-nums">{row.market} · {row.date ?? '日付なし'}</span>
        <span aria-hidden="true">·</span>
        <span>{row.marketSegment ?? '市場未分類'}</span>
        {row.marginType && <><span aria-hidden="true">·</span><span>{row.marginType}</span></>}
        <span aria-hidden="true">·</span>
        <span>{row.industry17}</span>
        <span aria-hidden="true">·</span>
        <span className="text-[var(--color-text-secondary)]">{row.industry33}</span>
        <span aria-hidden="true">·</span>
        <span>平均出来高 <span className="font-mono tabular-nums">{fmtCompact(row.avgVolume)}</span> ({row.avgVolumeLabel})</span>
      </div>
    </div>
  )
}

function SignalRow({
  row,
  rank,
  open,
  onToggle,
  industryLevel,
  sort,
}: {
  row: DashboardTradeSignalRow
  rank: number
  open: boolean
  onToggle: (id: string) => void
  industryLevel: IndustryLevel
  sort: SortKey
}) {
  const evidence = shapeEvidence(row)
  const points = decisionPoints(row)
  const detailId = `${useId()}-detail`
  const detailSummary = [
    points.length > 0 ? `判断ポイント${points.length}` : null,
    row.scenario?.invalidation ? '崩れる条件' : null,
    evidence.risks.length > 0 ? `注意${evidence.risks.length}` : null,
    evidence.points.length > 0 ? `形状根拠${evidence.points.length}` : null,
  ].filter(Boolean).join('・')

  return (
    <li className={`px-2 py-2.5 transition-colors md:py-2 ${open ? 'bg-[var(--color-surface-subtle)]' : 'hover:bg-[var(--color-surface-subtle)]'}`}>
      <div className={`grid ${SIGNAL_ROW_GRID}`}>
        <RankScoreCell row={row} rank={rank} />
        <IdentityCell row={row} industryLevel={industryLevel} sort={sort} />
        <PriceCell row={row} />
        <ScenarioCell row={row} />
        <WeightCell row={row} />
        <div className={SIGNAL_SUB_GRID}>
          <TopScenarioCell row={row} />
          <TargetStopCell row={row} />
          <StageCell row={row} />
          <PhysicsCell row={row} sortByStatus={sort === 'physicalStatus'} />
          <VolumeCell row={row} />
        </div>
        {/*
          390: 44px 四方を押せる大きさにし、上下の負マージンで行の高さは従来の 32px 分に収める
          (上は段間 6px、下は行の余白 10px の内側へはみ出すだけで、隣の行とは重ならない)。
          md 以上: 見た目は 28px のまま、押せる範囲だけ疑似要素で 44px に広げる。
        */}
        <button
          type="button"
          onClick={() => onToggle(row.id)}
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={`${row.ticker} ${row.name}の${detailSummary || '詳細'}を${open ? '閉じる' : '開く'}`}
          title={detailSummary || '詳細'}
          className={`${SIGNAL_AREA.tg} relative -my-1.5 inline-flex h-11 min-w-11 items-center justify-center gap-1 justify-self-end rounded-[3px] px-2 text-[11px] font-bold text-[var(--color-brand-700)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)] md:my-0 md:h-7 md:w-7 md:min-w-0 md:px-0 md:after:absolute md:after:-inset-2 md:after:content-[''] ${open ? 'bg-[var(--color-surface-muted)]' : ''}`}
        >
          <span className="md:hidden">{open ? '閉じる' : '詳細'}</span>
          <ChevronDown size={14} aria-hidden="true" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <SignalDetail row={row} id={detailId} open={open} evidence={evidence} points={points} />
    </li>
  )
}

/* ---------- 列見出し (md 以上) ---------- */

function sortMark(active: boolean, ascending = false) {
  if (!active) return null
  return <span className="ml-0.5" aria-hidden="true">{ascending ? '↑' : '↓'}</span>
}

function SignalColumnHeader({
  scenarioLabel,
  industryLevel,
  sort,
}: {
  scenarioLabel: string
  industryLevel: IndustryLevel
  sort: SortKey
}) {
  const on = (active: boolean) => (active ? 'text-[var(--color-brand-800)]' : '')
  return (
    <div
      aria-hidden="true"
      className={`hidden border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1.5 text-[10px] font-bold leading-4 text-[var(--color-text-tertiary)] md:grid ${SIGNAL_ROW_GRID}`}
    >
      <div className={`${SIGNAL_AREA.sc} flex items-center gap-1`}>
        <span className="w-6 text-right">順位</span>
        <span className={on(sort === 'confidence')}>確度{sortMark(sort === 'confidence')}</span>
      </div>
      <div className={`${SIGNAL_AREA.id} truncate ${on(sort === 'industry')}`}>
        銘柄 · {industryLevel}業種{sortMark(sort === 'industry', true)}
      </div>
      <div className={`${SIGNAL_AREA.px} text-right ${on(sort === 'changePct')}`}>
        価格 / 前日比{sortMark(sort === 'changePct')}
      </div>
      <div className={`${SIGNAL_AREA.sn} truncate`}>シナリオ {scenarioLabel}</div>
      <div className={`${SIGNAL_AREA.wt} flex justify-between`}>
        <span className="text-[var(--color-price-up)]">上</span>
        <span className={RANGE_TEXT}>横</span>
        <span className="text-[var(--color-price-down)]">下</span>
      </div>
      <div className={SIGNAL_SUB_GRID}>
        <div className={SIGNAL_AREA.tp}>#1 シナリオ</div>
        <div className={`${SIGNAL_AREA.ts} xl:text-right`}>目標 / 撤退</div>
        <div className={`${SIGNAL_AREA.st} grid grid-cols-3 gap-x-1.5 text-center`}>
          <span>日足</span>
          <span>週足</span>
          <span>月足</span>
        </div>
        <div className={`${SIGNAL_AREA.ph} grid grid-cols-3 gap-x-1.5 text-right`}>
          <span className={on(sort === 'pms')}>PMS{sortMark(sort === 'pms')}</span>
          <span className={on(sort === 'pfs')}>PFS{sortMark(sort === 'pfs')}</span>
          <span>PES</span>
          {/* 物理状態の文言は xl で PMS/PFS/PES の下段に出る */}
          <span className={`col-span-3 hidden xl:block ${on(sort === 'physicalStatus')}`}>物理状態{sortMark(sort === 'physicalStatus')}</span>
        </div>
        <div className={`${SIGNAL_AREA.vo} text-right ${on(sort === 'avgVolume')}`}>出来高{sortMark(sort === 'avgVolume')}</div>
      </div>
      <div className={SIGNAL_AREA.tg} />
    </div>
  )
}

/* ---------- 確度帯の区切り (確度順のときだけ) ---------- */

/**
 * 件数は「いま描いている行数」と「絞り込み後の候補数」を並べて書く。
 * 片方だけだと、表示中の件数なのか候補総数なのかが読み取れないため。
 */
function BandHeading({
  band,
  shown,
  total,
  first,
}: {
  band: 'high' | 'candidate'
  shown: number
  total: number
  first: boolean
}) {
  const high = band === 'high'
  return (
    <div className={`flex items-center gap-2 px-2 pb-1 pt-2 text-[10px] font-bold text-[var(--color-text-secondary)] ${first ? '' : 'border-t border-[var(--color-border-default)]'}`}>
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-[1px] ${high ? 'bg-[var(--color-brand-900)]' : 'border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]'}`}
      />
      <span>{high ? '高確度' : '候補'}</span>
      <span className="font-semibold text-[var(--color-text-tertiary)]">
        {shown === total ? (
          <>候補 <span className="font-mono tabular-nums">{total.toLocaleString('ja-JP')}</span>件をすべて表示</>
        ) : (
          <>
            表示 <span className="font-mono tabular-nums text-[var(--color-text-secondary)]">{shown.toLocaleString('ja-JP')}</span>件
            {' '}/ 候補 <span className="font-mono tabular-nums">{total.toLocaleString('ja-JP')}</span>件
          </>
        )}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--color-border-soft)]" />
    </div>
  )
}

/* ---------- フィルタ ---------- */

const selectClass =
  'h-8 min-w-0 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-semibold text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]'

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid min-w-0 gap-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
      {label}
      {children}
    </label>
  )
}

type RowGroup = { key: string; band: 'high' | 'candidate' | null; start: number; rows: DashboardTradeSignalRow[] }

export function DashboardTradeSignalTableClient({ data }: { data: DashboardTradeSignalResult }) {
  const searchParams = useSearchParams()
  const [side, setSide] = useState<SideFilter>('buy')
  const [market, setMarket] = useState<MarketFilter>('JP')
  const [industryLevel, setIndustryLevel] = useState<IndustryLevel>('17')
  const [industry, setIndustry] = useState('all')
  const [minVolume, setMinVolume] = useState('0')
  const [sort, setSort] = useState<SortKey>('confidence')
  const [limit, setLimit] = useState(PAGE_ROWS)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())

  const industries = useMemo(() => {
    return dashboardIndustryOptions(data.rows, market, side, industryLevel)
  }, [data.rows, industryLevel, market, side])

  useEffect(() => {
    setIndustry('all')
  }, [industryLevel, market, side])

  useEffect(() => {
    setLimit(PAGE_ROWS)
  }, [industry, industryLevel, market, minVolume, side, sort])

  const filteredRows = useMemo(() => {
    const min = Number(minVolume)
    return data.rows
      .filter((row) => row.side === side)
      .filter((row) => row.market === market)
      .filter((row) => industry === 'all' || industryValue(row, industryLevel) === industry)
      .filter((row) => !Number.isFinite(min) || min <= 0 || (row.avgVolume ?? 0) >= min)
      .sort((a, b) => compareRows(a, b, sort, industryLevel))
  }, [data.rows, industry, industryLevel, market, minVolume, side, sort])
  const cappedRows = filteredRows.slice(0, MAX_ROWS)
  const visibleRows = cappedRows.slice(0, limit)
  const hiddenCount = cappedRows.length - visibleRows.length

  /* 確度順のときだけ、高確度/候補の境目に区切りを入れる (並び・順位は変えない) */
  const groups = useMemo<RowGroup[]>(() => {
    if (sort !== 'confidence') return [{ key: 'all', band: null, start: 0, rows: visibleRows }]
    const result: RowGroup[] = []
    visibleRows.forEach((row, index) => {
      const last = result[result.length - 1]
      if (last && last.band === row.confidenceBand) last.rows.push(row)
      else result.push({ key: `${row.confidenceBand}-${index}`, band: row.confidenceBand, start: index, rows: [row] })
    })
    return result
  }, [sort, visibleRows])
  /* 確度帯ごとの件数。total は件数行の「候補 N件」と同じ母数 (絞り込み後) */
  const bandCounts = {
    high: {
      shown: visibleRows.filter((row) => row.confidenceBand === 'high').length,
      total: filteredRows.filter((row) => row.confidenceBand === 'high').length,
    },
    candidate: {
      shown: visibleRows.filter((row) => row.confidenceBand === 'candidate').length,
      total: filteredRows.filter((row) => row.confidenceBand === 'candidate').length,
    },
  }

  const allVisibleOpen = visibleRows.length > 0 && visibleRows.every((row) => openIds.has(row.id))
  const toggleRow = (id: string) => {
    setOpenIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setOpenIds(allVisibleOpen ? new Set() : new Set(visibleRows.map((row) => row.id)))
  }

  const buyCount = data.rows.filter((row) => row.side === 'buy').length
  const sellCount = data.rows.filter((row) => row.side === 'sell').length
  const highCount = data.rows.filter((row) => row.confidenceBand === 'high').length
  const search = searchParams?.toString() ?? ''
  const activeInterval = SCENARIO_INTERVAL_OPTIONS.find((option) => option.value === data.scenarioInterval)

  return (
    <div id="trade-signals" className="min-w-0 scroll-mt-4">
      <div className="grid gap-x-8 gap-y-3 border-b border-[var(--color-border-soft)] pb-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-end">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">候補の向き</div>
          <div className="inline-flex rounded-[4px] border border-[var(--color-border-default)] p-0.5" role="group" aria-label="買う候補と売る候補の切り替え">
            {([
              ['buy', buyCount],
              ['sell', sellCount],
            ] as const).map(([value, count]) => {
              const active = side === value
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSide(value)}
                  className={`inline-flex h-8 items-center gap-2 rounded-[3px] px-3 text-[12px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)] ${active ? `bg-[var(--color-surface-muted)] ${sideTextClass(value)}` : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'}`}
                >
                  {sideLabel(value)}
                  <span className="font-mono text-[12px] tabular-nums">{count.toLocaleString('ja-JP')}</span>
                </button>
              )
            })}
          </div>
          <span className="ml-3 align-middle text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            高確度 <span className="font-mono font-bold tabular-nums text-[var(--color-brand-900)]">{highCount.toLocaleString('ja-JP')}</span>
          </span>
        </div>

        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
            <span>シナリオ期間 — 選んだ期間のシナリオチャートを表示候補全件へ適用</span>
            <span className="tabular-nums">
              {activeInterval ? activeInterval.detail : `${data.scenarioIntervalLabel} / ${data.scenarioHorizonDays}営業日先`} · ML補助順位は{data.horizonDays}営業日目線
            </span>
          </div>
          <nav aria-label="シナリオ期間" className="grid grid-cols-3 rounded-[4px] border border-[var(--color-border-default)] p-0.5 sm:grid-cols-6">
            {SCENARIO_INTERVAL_OPTIONS.map((option) => {
              const active = data.scenarioInterval === option.value
              return (
                <Link
                  key={option.value}
                  href={scenarioHref(search, option.value)}
                  prefetch={false}
                  scroll={false}
                  aria-current={active ? 'true' : undefined}
                  title={option.detail}
                  className={`flex h-8 items-center justify-center rounded-[3px] text-[12px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)] ${active ? 'bg-[var(--color-brand-900)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-brand-800)]'}`}
                >
                  {option.label}
                </Link>
              )
            })}
          </nav>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-[var(--color-border-soft)] py-3 sm:grid-cols-3 lg:grid-cols-[repeat(2,minmax(0,7rem))_repeat(3,minmax(0,1fr))]">
        <FilterField label="市場">
          <select value={market} onChange={(event) => setMarket(event.target.value as MarketFilter)} className={selectClass}>
            <option value="JP">JP</option>
            <option value="US">US</option>
          </select>
        </FilterField>
        <FilterField label="業種分類">
          <select value={industryLevel} onChange={(event) => setIndustryLevel(event.target.value as IndustryLevel)} className={selectClass}>
            <option value="17">17業種</option>
            <option value="33">33業種</option>
          </select>
        </FilterField>
        <FilterField label="業種">
          <select value={industry} onChange={(event) => setIndustry(event.target.value)} className={selectClass}>
            <option value="all">すべて</option>
            {industries.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </FilterField>
        <FilterField label="平均出来高下限">
          <select value={minVolume} onChange={(event) => setMinVolume(event.target.value)} className={selectClass}>
            <option value="0">指定なし</option>
            <option value="100000">10万株以上</option>
            <option value="300000">30万株以上</option>
            <option value="1000000">100万株以上</option>
            <option value="3000000">300万株以上</option>
          </select>
        </FilterField>
        <FilterField label="並び替え">
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className={selectClass}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </FilterField>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2 text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
        <span className="min-w-0">
          <span className={`font-bold ${sideTextClass(side)}`}>{sideLabel(side)}候補</span>
          {' '}· 表示 <span className="font-mono font-bold text-[var(--color-text-primary)]">{visibleRows.length.toLocaleString('ja-JP')}</span>件
          {' '}/ 候補 <span className="font-mono font-bold text-[var(--color-text-primary)]">{filteredRows.length.toLocaleString('ja-JP')}</span>件
          {filteredRows.length > MAX_ROWS ? `（上位${MAX_ROWS}件まで）` : ''}
          {' '}· JP <span className="font-mono">{data.jpDate ?? '-'}</span> · US <span className="font-mono">{data.usDate ?? '-'}</span>
          {' '}· {market} / {industryLevel}業種
        </span>
        {visibleRows.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            aria-pressed={allVisibleOpen}
            className={`${HIT_AREA_Y} inline-flex h-7 shrink-0 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)] transition-colors hover:border-[var(--color-brand-500)] hover:bg-[var(--color-surface-subtle)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]`}
          >
            <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${allVisibleOpen ? 'rotate-180' : ''}`} />
            {allVisibleOpen ? '根拠をすべて閉じる' : '根拠をすべて開く'}
          </button>
        )}
        <span className="basis-full">買う/売るはデータ上の方向感で、売買助言ではありません。売る候補は下落/弱含み側の監視候補です。</span>
      </div>

      <div className={`border-y border-l-2 border-y-[var(--color-border-default)] ${sideRuleClass(side)}`}>
        <SignalColumnHeader scenarioLabel={data.scenarioIntervalLabel} industryLevel={industryLevel} sort={sort} />
        {groups.map((group, groupIndex) => (
          <div key={group.key}>
            {group.band && (
              <BandHeading
                band={group.band}
                shown={bandCounts[group.band].shown}
                total={bandCounts[group.band].total}
                first={groupIndex === 0}
              />
            )}
            <ol start={group.start + 1} className="divide-y divide-[var(--color-border-soft)]">
              {group.rows.map((row, index) => (
                <SignalRow
                  key={row.id}
                  row={row}
                  rank={group.start + index + 1}
                  open={openIds.has(row.id)}
                  onToggle={toggleRow}
                  industryLevel={industryLevel}
                  sort={sort}
                />
              ))}
            </ol>
          </div>
        ))}
        {filteredRows.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">
            条件に合う候補がありません。
          </div>
        )}
      </div>
      {hiddenCount > 0 && (
        <div className="flex justify-center pt-3">
          <button
            type="button"
            onClick={() => setLimit((current) => current + PAGE_ROWS)}
            className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-4 text-[12px] font-bold text-[var(--color-brand-800)] transition-colors hover:border-[var(--color-brand-500)] hover:bg-[var(--color-surface-subtle)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]"
          >
            続きを表示
            <span className="font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
              +{Math.min(PAGE_ROWS, hiddenCount)} / 残り{hiddenCount}件
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
