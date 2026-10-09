// 存在しない銘柄・商品・投資家などで notFound() が呼ばれたときの画面。
// ヘッダーとナビは残し、よく使う入口へ戻れるようにする。

import Link from 'next/link'
import { SearchX } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'

const ENTRY_LINKS = [
  { href: '/', label: 'ダッシュボード' },
  { href: '/screener', label: 'スクリーナー' },
  { href: '/us', label: '米国株' },
  { href: '/commodities', label: 'コモディティ' },
] as const

export default function NotFound() {
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="404"
        title="ページが見つかりません"
        subtitle="URLの銘柄コード・商品コードが誤っているか、対象がユニバースから外れた可能性があります。"
      />
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
        <div className="empty-state">
          <SearchX size={22} aria-hidden />
          <p className="empty-state__title">お探しの画面はありません</p>
          <p className="empty-state__desc">ヘッダーの銘柄検索を使うか、次の画面から探し直してください。</p>
          <nav aria-label="主な画面" className="mt-1 flex flex-wrap justify-center gap-2">
            {ENTRY_LINKS.map((link, index) => (
              <Link key={link.href} href={link.href} prefetch={false} className="btn" data-variant={index === 0 ? 'primary' : undefined}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </div>
  )
}
