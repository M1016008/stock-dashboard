import type { Metadata } from 'next'
import { Inter, Noto_Sans_JP } from 'next/font/google'
import { Header } from '@/components/layout/Header'
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" className={`${inter.variable} ${notoJP.variable}`}>
      <body className="min-h-screen bg-[var(--color-surface-subtle)] font-sans text-[var(--color-text-primary)] antialiased">
        <Header />
        <main className="mx-auto max-w-[1440px] px-6 py-6">
          {children}
        </main>
        <footer className="mx-auto max-w-[1440px] px-6 py-8 text-xs text-[var(--color-text-tertiary)]">
          表示内容は過去データに基づく統計的観測です。投資判断は自己責任で行ってください。
        </footer>
      </body>
    </html>
  )
}
