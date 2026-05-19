// components/dashboard/NewHighVolume.tsx
// Phase 4 B7: 新高値・新安値・出来高急増

'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Card, CardHeader } from '@/components/ui/Card'

interface NewHighVolumeRow {
  ticker: string
  name: string | null
  type: string
  changePct: number
}

function fmtPct(v: number | null) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function tagStyle(type: string): { bg: string; text: string } {
  if (type === '新高値') return { bg: 'var(--color-price-up-bg)', text: 'var(--color-price-up)' }
  if (type === '新安値') return { bg: 'var(--color-price-down-bg)', text: 'var(--color-price-down)' }
  return { bg: 'var(--color-pattern-50)', text: 'var(--color-pattern-700)' }
}

export function NewHighVolume() {
  const [rows, setRows] = useState<NewHighVolumeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetch('/api/dashboard/new-high-volume', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
        if (!cancelled) setRows(data.rows ?? [])
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  return (
    <Card size="sm">
      <CardHeader title="新高値・出来高急増" hint="252日基準" />
      {loading ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">読込中...</div>
      ) : error ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-price-down)]">エラー: {error}</div>
      ) : rows.length === 0 ? (
        <div className="py-7 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">該当なし</div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          <div className="grid grid-cols-[58px_1fr_78px_74px] gap-3 px-2 pb-3 text-[12px] font-bold text-[var(--color-text-tertiary)]">
            <span>コード</span><span>銘柄</span><span>タイプ</span><span className="text-right">変化率</span>
          </div>
          {rows.map(r => {
            const styleObj = tagStyle(r.type)
            const tone = r.changePct > 0 ? 'text-[var(--color-price-up)]' : r.changePct < 0 ? 'text-[var(--color-price-down)]' : ''
            // 出来高比率 "2.30x量" を短縮 → "2.3x量"
            const typeLabel = /^\d/.test(r.type)
              ? r.type.replace(/^(\d+(?:\.\d)?).*/, '$1') + 'x 量'
              : r.type
            return (
              <Link
                key={r.ticker + r.type}
                href={`/stock/${r.ticker}`}
                prefetch={false}
                className="grid grid-cols-[58px_1fr_78px_74px] gap-3 rounded-[8px] px-2 py-2.5 text-[14px] font-medium hover:bg-[var(--color-surface-subtle)]"
              >
                <span className="tabular-nums text-[var(--color-text-secondary)]">{r.ticker}</span>
                <span className="truncate">{r.name ?? r.ticker}</span>
                <span
                  className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums"
                  style={{ backgroundColor: styleObj.bg, color: styleObj.text }}
                >
                  {typeLabel}
                </span>
                <span className={`tabular-nums text-right ${tone}`}>{fmtPct(r.changePct)}</span>
              </Link>
            )
          })}
        </div>
      )}
    </Card>
  )
}
