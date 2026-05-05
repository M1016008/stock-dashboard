// components/alerts/AlertRow.tsx
'use client'

import Link from 'next/link'
import { useAlertStore } from '@/lib/alert-store'
import type { Alert } from '@/types/alert'

interface AlertRowProps {
  alert: Alert
}

function getConditionLabel(alert: Alert): string {
  const c = alert.condition
  switch (c.type) {
    case 'PRICE_ABOVE': return `株価 ≥ ${c.threshold.toLocaleString()}`
    case 'PRICE_BELOW': return `株価 ≤ ${c.threshold.toLocaleString()}`
    case 'MA_ORDER':    return c.order === 'BULLISH' ? 'MA上昇配列 (5>25>75)' : 'MA下降配列 (5<25<75)'
    case 'GOLDEN_CROSS': return `GC (MA${c.shortPeriod}/MA${c.longPeriod})`
    case 'DEAD_CROSS':   return `DC (MA${c.shortPeriod}/MA${c.longPeriod})`
    case 'MACD_GOLDEN_CROSS': return 'MACD GC'
    case 'MACD_DEAD_CROSS':   return 'MACD DC'
    default: return '?'
  }
}

export function AlertRow({ alert }: AlertRowProps) {
  const toggleAlert = useAlertStore((s) => s.toggleAlert)
  const removeAlert = useAlertStore((s) => s.removeAlert)

  const handleRemove = () => {
    if (confirm('このアラートを削除しますか?')) {
      removeAlert(alert.id)
    }
  }

  const ticker = alert.condition.ticker
  const lastTriggered = alert.lastTriggeredAt
    ? new Date(alert.lastTriggeredAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '未発火'

  return (
    <tr style={{ borderBottom: '1px solid var(--border-subtle)', opacity: alert.enabled ? 1 : 0.5 }}>
      <td style={{ padding: '8px 12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={alert.enabled}
            onChange={() => toggleAlert(alert.id)}
            style={{ accentColor: 'var(--accent-primary)' }}
          />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {alert.enabled ? '有効' : '無効'}
          </span>
        </label>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <Link
          href={`/stock/${encodeURIComponent(ticker)}`}
          style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none', fontSize: '12px' }}
        >
          {ticker.replace('.T', '')}
        </Link>
        <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--text-muted)' }}>
          [{alert.condition.market}]
        </span>
      </td>
      <td style={cellStyle}>{getConditionLabel(alert)}</td>
      <td style={cellStyle}>{alert.email}</td>
      <td style={cellStyle}>{alert.cooldownMinutes}分</td>
      <td style={{ ...cellStyle, color: 'var(--text-muted)', fontSize: '11px' }}>{lastTriggered}</td>
      <td style={{ padding: '8px 12px', textAlign: 'right' }}>
        <button onClick={handleRemove} style={removeBtn}>削除</button>
      </td>
    </tr>
  )
}

const cellStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: '12px',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
}

const removeBtn: React.CSSProperties = {
  padding: '3px 10px',
  background: 'transparent',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  color: 'var(--price-down)',
}
