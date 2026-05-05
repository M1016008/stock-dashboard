// app/layout.tsx
import type { Metadata } from 'next'
import { IBM_Plex_Mono, Space_Grotesk } from 'next/font/google'
import './globals.css'
import { Sidebar } from '@/components/ui/Sidebar'
import { TopBar } from '@/components/ui/TopBar'

const ibmPlexMono = IBM_Plex_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-mono-next',
})

const spaceGrotesk = Space_Grotesk({
  weight: ['500', '700'],
  subsets: ['latin'],
  variable: '--font-display-next',
})

export const metadata: Metadata = {
  title: 'StockBoard — 株式分析ダッシュボード',
  description: '日本株・米国株のリアルタイム分析ダッシュボード。HEXステージ分析、スクリーナー、ポートフォリオ管理機能を搭載。',
  keywords: ['株式', '投資', 'ダッシュボード', 'スクリーナー', 'HEXステージ'],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" className={`${ibmPlexMono.variable} ${spaceGrotesk.variable}`}>
      <body>
        {/* TOPBAR */}
        <TopBar />

        {/* MAIN LAYOUT */}
        <div style={{
          display: 'flex',
          height: 'calc(100vh - 36px)',
          marginTop: '36px',
        }}>
          {/* SIDEBAR */}
          <Sidebar />

          {/* MAIN CONTENT */}
          <main style={{
            marginLeft: '200px',
            flex: 1,
            overflowY: 'auto',
            background: 'var(--bg-void)',
            minHeight: '100%',
          }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
