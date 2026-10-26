'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { Activity, Crosshair, FlaskConical, Gauge, GitCompareArrows, Hexagon, Layers, LayoutDashboard, ListFilter } from 'lucide-react'
import { ViewTabs } from '@/components/ui/ViewTabs'
import { UsDataCoverageStrip, type UsDataCoverageScope } from '@/components/us/UsDataCoverageStrip'

// 米国株エリアの兄弟ページ。各ページの PageTitle 直下に置き、現在地を aria-current で示す。
// 並びは「市場全体 → セクター → 個別銘柄の絞り込み → 分析」の読み下し順。
// coverageScope: その画面で読むデータ鮮度・カバレッジ帯の scope (route ごとの制約文を選ぶ)。
const ITEMS = [
  { href: '/us', label: 'ダッシュボード', icon: LayoutDashboard, coverageScope: 'dashboard' },
  { href: '/us/market-momentum', label: 'モメンタム', icon: Gauge, coverageScope: 'market-momentum' },
  { href: '/us/sectors', label: 'セクター', icon: Layers, coverageScope: 'sectors' },
  { href: '/us/screener', label: 'スクリーナー', icon: ListFilter, coverageScope: 'screener' },
  { href: '/us/stage-screener', label: 'ステージスクリーナー', icon: Hexagon, coverageScope: 'stage-screener' },
  { href: '/us/trigger-discovery', label: '条件トリガー', icon: Crosshair, coverageScope: 'trigger-discovery' },
  { href: '/us/analysis/ml-lens', label: 'US AI Lens', icon: Activity, coverageScope: 'ml-lens' },
  { href: '/us/analysis/transitions', label: 'ステージ遷移', icon: GitCompareArrows, coverageScope: 'transitions' },
  { href: '/us/analysis/backtest', label: '過去検証', icon: FlaskConical, coverageScope: 'backtest' },
] as const satisfies ReadonlyArray<{ href: string; label: string; icon: unknown; coverageScope: UsDataCoverageScope }>

export const US_ANALYSIS_NAV_HREFS: readonly string[] = ITEMS.map((item) => item.href)

// Only these pages implement the shared US as-of contract. Analysis pages with
// their own date semantics must keep their exact route and must not receive a
// dashboard date implicitly.
export const US_ANALYSIS_DATE_CONTEXT_HREFS = new Set<string>([
  '/us',
  '/us/market-momentum',
  '/us/sectors',
  '/us/screener',
  '/us/stage-screener',
])

function isIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

export function usAnalysisNavHref(route: string, date: string | null): string {
  if (!date || !isIsoCalendarDate(date) || !US_ANALYSIS_DATE_CONTEXT_HREFS.has(route)) return route
  const params = new URLSearchParams({ date })
  return `${route}?${params.toString()}`
}

// current route → scope。未知の route では帯を出さない (推測で scope を当てない)。
export function usDataCoverageScopeForRoute(route: string): UsDataCoverageScope | null {
  return ITEMS.find((item) => item.href === route)?.coverageScope ?? null
}

// ViewTabs の後ろにデータ鮮度・カバレッジ帯を置く。帯は order-last + 全幅で、
// PageTitle の帯の最終行 (ページ固有の ViewTabs より下) に並ぶ。
export function UsAnalysisNav({ current }: { current: string }) {
  const searchParams = useSearchParams()
  const navContainerRef = useRef<HTMLDivElement>(null)
  const coverageScope = usDataCoverageScopeForRoute(current)
  const requestedDates = searchParams.getAll('date')
  const dateContext = requestedDates.length === 1 && isIsoCalendarDate(requestedDates[0])
    ? requestedDates[0]
    : null

  useEffect(() => {
    const active = navContainerRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [current])

  return (
    <>
      <div ref={navContainerRef} className="flex w-full min-w-0 flex-col gap-1" data-us-analysis-nav>
        <ViewTabs
          label="米国株"
          current={current}
          className="w-full"
          items={ITEMS.map((item) => {
            const Icon = item.icon
            return {
              key: item.href,
              href: usAnalysisNavHref(item.href, dateContext),
              label: item.label,
              icon: <Icon size={14} aria-hidden />,
            }
          })}
        />
        <p className="m-0 px-1 text-[10px] font-medium text-[var(--color-text-tertiary)] sm:hidden">
          横にスワイプして全9機能を表示
        </p>
      </div>
      {coverageScope && <UsDataCoverageStrip scope={coverageScope} />}
    </>
  )
}
