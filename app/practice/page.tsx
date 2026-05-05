// app/practice/page.tsx
'use client'

export default function PracticePage() {
  return (
    <div style={{ padding: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px', marginBottom: '16px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>🎯 トレード練習</h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          TradingViewリプレイ機能を使った過去チャート練習
        </p>
      </div>
      <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
        <div style={{ fontSize: '32px', marginBottom: '16px' }}>🎯</div>
        <h2 style={{ fontSize: '14px', marginBottom: '8px' }}>トレード練習（PHASE 11で実装）</h2>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          TradingView MCP連携で過去チャートのリプレイ練習が可能になります
        </p>
      </div>
    </div>
  )
}
