import { Filter, LayoutGrid } from 'lucide-react'
import { ViewTabs } from '@/components/ui/ViewTabs'

/** コモディティの兄弟ページ (分類別ボード / スクリーナー)。PageTitle 直下に置く */
export function CommodityNav({ current }: { current: 'board' | 'screener' | null }) {
  return (
    <ViewTabs
      label="コモディティ"
      current={current ?? ''}
      items={[
        { key: 'board', href: '/commodities', label: '分類別ボード', icon: <LayoutGrid size={14} aria-hidden /> },
        { key: 'screener', href: '/commodities/screener', label: 'スクリーナー', icon: <Filter size={14} aria-hidden /> },
      ]}
    />
  )
}
