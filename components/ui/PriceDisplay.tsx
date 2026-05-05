// components/ui/PriceDisplay.tsx
'use client'

import { useEffect, useRef } from 'react'

interface PriceDisplayProps {
  value: number
  change?: number
  changePercent?: number
  currency?: 'JPY' | 'USD'
  size?: 'sm' | 'md' | 'lg' | 'xl'
  showChange?: boolean
}

const sizeMap = {
  sm: { price: '12px', change: '11px' },
  md: { price: '14px', change: '12px' },
  lg: { price: '20px', change: '13px' },
  xl: { price: '28px', change: '14px' },
}

function formatPrice(value: number, currency: 'JPY' | 'USD'): string {
  if (currency === 'JPY') {
    return '¥' + value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })
  }
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function PriceDisplay({
  value,
  change,
  changePercent,
  currency = 'JPY',
  size = 'md',
  showChange = true,
}: PriceDisplayProps) {
  const priceRef = useRef<HTMLSpanElement>(null)
  const prevValueRef = useRef(value)

  useEffect(() => {
    if (prevValueRef.current !== value && priceRef.current) {
      priceRef.current.classList.add('price-flash')
      setTimeout(() => priceRef.current?.classList.remove('price-flash'), 100)
    }
    prevValueRef.current = value
  }, [value])

  const isUp = (change ?? 0) >= 0
  const colorClass = change === 0 ? 'neutral' : isUp ? 'up' : 'down'
  const { price: priceSize, change: changeSize } = sizeMap[size]

  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px', fontFamily: 'var(--font-mono)' }}>
      <span ref={priceRef} style={{ fontSize: priceSize, fontWeight: 600 }} data-price>
        {formatPrice(value, currency)}
      </span>
      {showChange && change !== undefined && changePercent !== undefined && (
        <span className={colorClass} style={{ fontSize: changeSize }} data-percent>
          {isUp ? '+' : ''}{change.toFixed(currency === 'JPY' ? 0 : 2)} ({isUp ? '+' : ''}{changePercent.toFixed(2)}%)
        </span>
      )}
    </span>
  )
}
