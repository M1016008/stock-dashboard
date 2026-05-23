import type { Metadata } from 'next'
import { Inter, Noto_Sans_JP } from 'next/font/google'
import { Suspense } from 'react'
import { Header } from '@/components/layout/Header'
import { DataAutoUpdater } from '@/components/layout/DataAutoUpdater'
import { FreshDataRefresher } from '@/components/layout/FreshDataRefresher'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans-next',
  display: 'swap',
})

const notoJP = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-jp-next',
  display: 'swap',
})

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
    <html lang="ja" className={`${inter.variable} ${notoJP.variable}`}>
      <body className="min-h-screen bg-[var(--bg-void)] font-sans text-[var(--color-text-primary)] antialiased">
        <Suspense fallback={null}>
          <DataAutoUpdater />
          <FreshDataRefresher />
        </Suspense>
        <Header />
        <main className="mx-auto w-full max-w-[1480px] px-5 py-5 sm:px-8 lg:px-10 lg:py-7 xl:px-12">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-[1480px] px-5 pb-8 pt-3 text-[11px] text-[var(--color-text-tertiary)] sm:px-8 lg:px-10 xl:px-12">
          表示内容は過去データに基づく統計的観測です。投資判断は自己責任で行ってください。
        </footer>
      </body>
    </html>
  )
}
