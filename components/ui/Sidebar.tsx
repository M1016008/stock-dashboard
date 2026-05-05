// components/ui/Sidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { StatusDot } from './StatusDot'

const navItems = [
  { href: '/', label: 'ダッシュボード', icon: '⬜' },
  { href: '/hex-stage', label: 'HEXステージマップ', icon: '🔷' },
  { href: '/screener', label: 'スクリーナー', icon: '⧖' },
  { href: '/screener/history', label: 'スクリーナー履歴', icon: '📅' },
  { href: '/high-low', label: '新高値・新安値', icon: '📈' },
  { href: '/watchlist', label: 'ウォッチリスト', icon: '⭐' },
  { href: '/admin/db', label: 'DB管理', icon: '🗄' },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside style={{
      width: '200px',
      flexShrink: 0,
      background: 'var(--bg-base)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      position: 'fixed',
      top: '36px',
      left: 0,
      bottom: 0,
      overflowY: 'auto',
    }}>
      {/* ナビゲーション */}
      <nav style={{ flex: 1, padding: '8px 0' }}>
        {navItems.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                height: '36px',
                padding: '0 12px',
                fontSize: '11px',
                letterSpacing: '0.08em',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                backgroundColor: isActive ? 'var(--bg-elevated)' : 'transparent',
                borderLeft: isActive ? '2px solid var(--accent-primary)' : '2px solid transparent',
                textDecoration: 'none',
                userSelect: 'none',
              }}
            >
              <span style={{ fontSize: '13px' }}>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* 下部: ステータス */}
      <div style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        <StatusDot status="offline" label="TV未接続" />
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          株DB --
        </span>
      </div>
    </aside>
  )
}
