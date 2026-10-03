import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Header } from '@/components/layout/Header'
import { DataStatusBar } from '@/components/layout/DataStatusBar'
import { StockWorkspaceDock } from '@/components/layout/StockWorkspaceDock'
import { FreshDataRefresher } from '@/components/layout/FreshDataRefresher'
import { AssistantDrawer } from '@/components/assistant/AssistantDrawer'
import './globals.css'

export const metadata: Metadata = {
  title: 'StockBoard',
  description: '日本株のチャート構造に基づくパターンライブラリ',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body className="min-h-screen bg-[var(--bg-void)] font-sans text-[var(--color-text-primary)] antialiased">
        <Suspense fallback={null}>
          <FreshDataRefresher />
        </Suspense>
        <div className="site-header-stack">
          <Suspense fallback={null}>
            <Header />
          </Suspense>
          <DataStatusBar />
        </div>
        <main className="page-wide py-5 lg:py-7">
          {children}
        </main>
        <footer className="page-wide pb-8 pt-3 text-[11px] text-[var(--color-text-tertiary)]">
          表示内容は過去データに基づく統計的観測です。投資判断は自己責任で行ってください。
        </footer>
        <AssistantDrawer />
        <StockWorkspaceDock />
      </body>
    </html>
  )
}
