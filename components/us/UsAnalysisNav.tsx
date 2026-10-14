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

// current route → scope。未知の route では帯を出さない (推測で scope を当てない)。
export function usDataCoverageScopeForRoute(route: string): UsDataCoverageScope | null {
  return ITEMS.find((item) => item.href === route)?.coverageScope ?? null
}

// ViewTabs の後ろにデータ鮮度・カバレッジ帯を置く。帯は order-last + 全幅で、
// PageTitle の帯の最終行 (ページ固有の ViewTabs より下) に並ぶ。
export function UsAnalysisNav({ current }: { current: string }) {
  const coverageScope = usDataCoverageScopeForRoute(current)
  return (
    <>
      <ViewTabs
        label="米国株"
        current={current}
        items={ITEMS.map((item) => {
          const Icon = item.icon
          return { key: item.href, href: item.href, label: item.label, icon: <Icon size={14} aria-hidden /> }
        })}
      />
      {coverageScope && <UsDataCoverageStrip scope={coverageScope} />}
    </>
  )
}
