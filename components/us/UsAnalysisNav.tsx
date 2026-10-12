import { Activity, FlaskConical, Gauge, GitCompareArrows, Hexagon, Layers, LayoutDashboard, ListFilter } from 'lucide-react'
import { ViewTabs } from '@/components/ui/ViewTabs'

// 米国株エリアの兄弟ページ。各ページの PageTitle 直下に置き、現在地を aria-current で示す。
// 並びは「市場全体 → セクター → 個別銘柄の絞り込み → 分析」の読み下し順。
const ITEMS = [
  { href: '/us', label: 'ダッシュボード', icon: LayoutDashboard },
  { href: '/us/market-momentum', label: 'モメンタム', icon: Gauge },
  { href: '/us/sectors', label: 'セクター', icon: Layers },
  { href: '/us/screener', label: 'スクリーナー', icon: ListFilter },
  { href: '/us/stage-screener', label: 'ステージスクリーナー', icon: Hexagon },
  { href: '/us/analysis/ml-lens', label: 'US AI Lens', icon: Activity },
  { href: '/us/analysis/transitions', label: 'ステージ遷移', icon: GitCompareArrows },
  { href: '/us/analysis/backtest', label: '過去検証', icon: FlaskConical },
] as const

export function UsAnalysisNav({ current }: { current: string }) {
  return (
    <ViewTabs
      label="米国株"
      current={current}
      items={ITEMS.map((item) => {
        const Icon = item.icon
        return { key: item.href, href: item.href, label: item.label, icon: <Icon size={14} aria-hidden /> }
      })}
    />
  )
}
