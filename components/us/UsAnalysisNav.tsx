import { Activity, FlaskConical, GitCompareArrows, Hexagon, LayoutDashboard, ListFilter } from 'lucide-react'
import { ViewTabs } from '@/components/ui/ViewTabs'

// 米国株エリアの兄弟ページ。各ページの PageTitle 直下に置き、現在地を aria-current で示す。
const ITEMS = [
  { href: '/us', label: 'ダッシュボード', icon: LayoutDashboard },
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
