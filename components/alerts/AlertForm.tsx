// components/alerts/AlertForm.tsx
'use client'

import { useState } from 'react'
import { useAlertStore } from '@/lib/alert-store'
import type { AlertCondition } from '@/types/alert'

type CondType = AlertCondition['type']

const COND_LABELS: Record<CondType, string> = {
  PRICE_ABOVE: '株価がしきい値を超えた',
  PRICE_BELOW: '株価がしきい値を下回った',
  MA_ORDER: '移動平均線が上昇/下降配列',
  GOLDEN_CROSS: 'ゴールデンクロス（短期 > 長期）',
  DEAD_CROSS: 'デッドクロス（短期 < 長期）',
  MACD_GOLDEN_CROSS: 'MACDゴールデンクロス',
  MACD_DEAD_CROSS: 'MACDデッドクロス',
}

export function AlertForm() {
  const addAlert = useAlertStore((s) => s.addAlert)
  const [condType, setCondType] = useState<CondType>('PRICE_ABOVE')
  const [ticker, setTicker] = useState('')
  const [market, setMarket] = useState<'JP' | 'US'>('JP')
  const [threshold, setThreshold] = useState('')
  const [order, setOrder] = useState<'BULLISH' | 'BEARISH'>('BULLISH')
  const [shortPeriod, setShortPeriod] = useState('5')
  const [longPeriod, setLongPeriod] = useState('25')
  const [email, setEmail] = useState('')
  const [cooldownMinutes, setCooldownMinutes] = useState('60')
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!ticker.trim()) { setError('ティッカーを入力してください'); return }
    if (!email.trim() || !email.includes('@')) { setError('正しいメールアドレスを入力してください'); return }

    let condition: AlertCondition
    try {
      switch (condType) {
        case 'PRICE_ABOVE':
        case 'PRICE_BELOW':
          if (!threshold || isNaN(Number(threshold))) {
            throw new Error('しきい値を数値で入力してください')
          }
          condition = { type: condType, ticker: ticker.trim(), market, threshold: Number(threshold) }
          break
        case 'MA_ORDER':
          condition = { type: 'MA_ORDER', ticker: ticker.trim(), market, order }
          break
        case 'GOLDEN_CROSS':
        case 'DEAD_CROSS': {
          const sp = Number(shortPeriod)
          const lp = Number(longPeriod)
          if (!Number.isFinite(sp) || !Number.isFinite(lp) || sp >= lp) {
            throw new Error('短期 < 長期 の順番で正の整数を入力してください')
          }
          condition = { type: condType, ticker: ticker.trim(), market, shortPeriod: sp, longPeriod: lp }
          break
        }
        case 'MACD_GOLDEN_CROSS':
        case 'MACD_DEAD_CROSS':
          condition = { type: condType, ticker: ticker.trim(), market }
          break
        default:
          throw new Error('未知の条件タイプです')
      }
    } catch (e) {
      setError((e as Error).message)
      return
    }

    addAlert(condition, {
      notifyRealtime: true,
      notifyDaily: false,
      email: email.trim(),
      enabled: true,
      cooldownMinutes: Number(cooldownMinutes) || 60,
    })

    // フォームリセット（メールは保持）
    setTicker('')
    setThreshold('')
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ padding: '16px' }}>
      <div className="section-header">アラート作成</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '12px' }}>
        <div>
          <label style={labelStyle}>ティッカー</label>
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="7203.T / AAPL"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>市場</label>
          <select value={market} onChange={(e) => setMarket(e.target.value as 'JP' | 'US')} style={inputStyle}>
            <option value="JP">日本（JP）</option>
            <option value="US">米国（US）</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>条件タイプ</label>
          <select value={condType} onChange={(e) => setCondType(e.target.value as CondType)} style={inputStyle}>
            {(Object.keys(COND_LABELS) as CondType[]).map((t) => (
              <option key={t} value={t}>{COND_LABELS[t]}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 条件タイプ別の追加入力 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '12px' }}>
        {(condType === 'PRICE_ABOVE' || condType === 'PRICE_BELOW') && (
          <div>
            <label style={labelStyle}>しきい値</label>
            <input
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              step="0.01"
              placeholder="例: 2500"
              style={inputStyle}
            />
          </div>
        )}
        {condType === 'MA_ORDER' && (
          <div>
            <label style={labelStyle}>方向</label>
            <select value={order} onChange={(e) => setOrder(e.target.value as 'BULLISH' | 'BEARISH')} style={inputStyle}>
              <option value="BULLISH">上昇配列（5 &gt; 25 &gt; 75）</option>
              <option value="BEARISH">下降配列（5 &lt; 25 &lt; 75）</option>
            </select>
          </div>
        )}
        {(condType === 'GOLDEN_CROSS' || condType === 'DEAD_CROSS') && (
          <>
            <div>
              <label style={labelStyle}>短期 MA 期間</label>
              <input type="number" min="1" value={shortPeriod} onChange={(e) => setShortPeriod(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>長期 MA 期間</label>
              <input type="number" min="2" value={longPeriod} onChange={(e) => setLongPeriod(e.target.value)} style={inputStyle} />
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px', marginBottom: '12px' }}>
        <div>
          <label style={labelStyle}>通知先メール</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>クールダウン（分）</label>
          <input
            type="number"
            min="0"
            value={cooldownMinutes}
            onChange={(e) => setCooldownMinutes(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button type="submit" style={submitBtn}>アラート追加</button>
        </div>
      </div>

      {error && (
        <p style={{ color: 'var(--price-down)', fontSize: '11px', margin: 0 }}>{error}</p>
      )}
    </form>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '10px',
  color: 'var(--text-muted)',
  marginBottom: '4px',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  background: 'var(--bg-void)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  boxSizing: 'border-box',
}

const submitBtn: React.CSSProperties = {
  width: '100%',
  padding: '6px 14px',
  background: 'var(--accent-primary)',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  color: '#000',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
}
