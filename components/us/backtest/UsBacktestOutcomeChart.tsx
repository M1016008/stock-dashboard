'use client'

// components/us/backtest/UsBacktestOutcomeChart.tsx
//
// 詳細の終値チャート (SVG)。detail API の chart 系列をそのまま描き、値は作らない。
// - x 軸は営業日の並び (index)。範囲は API の返す「基準日の約120日前〜選択した結果日」
// - 基準日→結果日の区間だけを上昇/下落色で強調し、破線で基準日終値を示す
// - ポインタ/矢印キーで日付・終値・Stage を読み取れる。表でも確認できる

import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react'
import { fmtPct, fmtUsd } from '@/components/us/UsMarketMomentumParts'
import { FOCUS_RING, MUTED_TEXT, type UsBacktestDetailResponse, type UsBacktestMove } from '@/components/us/backtest/usBacktestShared'

const HEIGHT = 196
const PAD = { top: 14, right: 14, bottom: 22, left: 68 }

type Point = UsBacktestDetailResponse['chart'][number]

export function UsBacktestOutcomeChart({
  points,
  basisDate,
  basisClose,
  outcomeDate,
  outcomeReturnPct,
  move,
}: {
  points: Point[]
  basisDate: string
  basisClose: number | null
  outcomeDate: string | null
  outcomeReturnPct: number | null
  move: UsBacktestMove
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [cursor, setCursor] = useState<number | null>(null)
  const tableId = useId()
  const closes = points.flatMap((point) => point.close == null ? [] : [point.close])
  const drawable = closes.length >= 2

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [drawable])

  const moveColor = move === 'down' ? 'var(--color-price-down)' : 'var(--color-price-up)'
  const moveLabel = move === 'down' ? '最大下落' : '最大上昇'

  if (!drawable) {
    return (
      <div className={`flex h-[196px] items-center justify-center rounded-[4px] border border-dashed border-[var(--color-border-default)] text-[12px] ${MUTED_TEXT}`}>
        チャートを描ける終値データがありません
      </div>
    )
  }

  const values = basisClose == null ? closes : [...closes, basisClose]
  const rawLo = Math.min(...values)
  const rawHi = Math.max(...values)
  const margin = (rawHi - rawLo) * 0.06 || Math.abs(rawHi) * 0.02 || 1
  const lo = rawLo - margin
  const hi = rawHi + margin
  const innerW = Math.max(0, width - PAD.left - PAD.right)
  const innerH = HEIGHT - PAD.top - PAD.bottom
  const last = points.length - 1
  const x = (index: number) => PAD.left + (last <= 0 ? innerW / 2 : (index / last) * innerW)
  const y = (value: number) => PAD.top + ((hi - value) / (hi - lo)) * innerH

  const pathFor = (from: number, to: number) => {
    let d = ''
    let pen = false
    for (let index = from; index <= to; index += 1) {
      const close = points[index]?.close
      if (close == null) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${x(index).toFixed(1)},${y(close).toFixed(1)}`
      pen = true
    }
    return d
  }

  let basisIndex = points.findIndex((point) => point.date === basisDate)
  if (basisIndex < 0) basisIndex = points.findIndex((point) => point.date > basisDate)
  const outcomeIndex = outcomeDate ? points.findIndex((point) => point.date === outcomeDate) : -1
  const outcomePoint = outcomeIndex >= 0 ? points[outcomeIndex] : null
  const highlight = basisIndex >= 0 && outcomeIndex > basisIndex ? pathFor(basisIndex, outcomeIndex) : ''
  const ticks = [hi - margin, (hi + lo) / 2, lo + margin]
  const cursorPoint = cursor == null ? null : points[cursor]

  const outcomeX = outcomePoint ? x(outcomeIndex) : 0
  const outcomeY = outcomePoint?.close == null ? null : y(outcomePoint.close)
  const labelOnLeft = outcomeX > PAD.left + innerW * 0.6
  const labelY = outcomeY == null
    ? 0
    : move === 'down'
      ? Math.min(outcomeY + 16, PAD.top + innerH - 4)
      : Math.max(outcomeY - 8, PAD.top + 10)

  function pointAt(clientX: number, rect: DOMRect): number {
    if (innerW <= 0 || last <= 0) return 0
    const ratio = (clientX - rect.left - PAD.left) / innerW
    return Math.min(last, Math.max(0, Math.round(ratio * last)))
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    setCursor(pointAt(event.clientX, event.currentTarget.getBoundingClientRect()))
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 1
    const current = cursor ?? (basisIndex >= 0 ? basisIndex : last)
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = Math.max(0, current - step)
    else if (event.key === 'ArrowRight') next = Math.min(last, current + step)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else if (event.key === 'Escape') { setCursor(null); return }
    if (next == null) return
    event.preventDefault()
    setCursor(next)
  }

  return (
    <div className="min-w-0">
      <div className="mb-1 flex min-h-5 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10px]">
        <span className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 ${MUTED_TEXT}`}>
          <span className="inline-flex items-center gap-1"><span className="h-[2px] w-3 bg-[var(--color-text-secondary)]" aria-hidden />終値</span>
          <span className="inline-flex items-center gap-1"><span className="h-[2px] w-3" style={{ background: moveColor }} aria-hidden />基準日→{moveLabel}日</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 border-t border-dashed border-[var(--color-border-strong)]" aria-hidden />基準日終値</span>
        </span>
        <span className="min-w-0 truncate font-mono tabular-nums text-[var(--color-text-secondary)]" aria-live="polite">
          {cursorPoint
            ? `${cursorPoint.date} 終値 ${fmtUsd(cursorPoint.close)} · Stage ${cursorPoint.stageCode ?? '未取得'}`
            : <span className={`font-sans ${MUTED_TEXT}`}>ポイント / 矢印キーで日付を読み取り</span>}
        </span>
      </div>

      <div
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-label={`${points[0].date}から${points[last].date}までの終値チャート。基準日 ${basisDate}${outcomeDate ? `、${moveLabel}日 ${outcomeDate}` : ''}。左右の矢印キーで日付を移動します。`}
        onKeyDown={onKeyDown}
        className={`relative h-[196px] min-w-0 rounded-[4px] ${FOCUS_RING}`}
      >
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            className="block touch-pan-y select-none"
            onPointerMove={onPointerMove}
            onPointerDown={onPointerMove}
            onPointerLeave={() => setCursor(null)}
            aria-hidden
          >
            {ticks.map((value) => (
              <g key={value}>
                <line x1={PAD.left} x2={PAD.left + innerW} y1={y(value)} y2={y(value)} stroke="var(--color-border-soft)" />
                <text x={PAD.left - 6} y={y(value)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--color-text-tertiary)" className="font-mono">
                  {fmtUsd(value)}
                </text>
              </g>
            ))}
            <text x={PAD.left} y={HEIGHT - 6} fontSize={10} fill="var(--color-text-tertiary)" className="font-mono">{points[0].date}</text>
            <text x={PAD.left + innerW} y={HEIGHT - 6} fontSize={10} textAnchor="end" fill="var(--color-text-tertiary)" className="font-mono">{points[last].date}</text>

            {basisClose != null && (
              <line x1={PAD.left} x2={PAD.left + innerW} y1={y(basisClose)} y2={y(basisClose)} stroke="var(--color-border-strong)" strokeDasharray="3 3" />
            )}
            {basisIndex >= 0 && (
              <g>
                <line x1={x(basisIndex)} x2={x(basisIndex)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--color-border-strong)" />
                <text
                  x={x(basisIndex)}
                  dx={-4}
                  y={PAD.top + innerH - 4}
                  textAnchor="end"
                  fontSize={10}
                  fill="var(--color-text-secondary)"
                >
                  基準日
                </text>
              </g>
            )}

            <path d={pathFor(0, last)} fill="none" stroke="var(--color-text-secondary)" strokeWidth={1.5} strokeLinejoin="round" />
            {highlight && <path d={highlight} fill="none" stroke={moveColor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}

            {outcomePoint && outcomeY != null && (
              <g>
                <circle cx={outcomeX} cy={outcomeY} r={4} fill={moveColor} stroke="#fff" strokeWidth={2} />
                <text
                  x={outcomeX}
                  dx={labelOnLeft ? -8 : 8}
                  y={labelY}
                  textAnchor={labelOnLeft ? 'end' : 'start'}
                  fontSize={10}
                  fontWeight={600}
                  fill="var(--color-text-primary)"
                  paintOrder="stroke"
                  stroke="#fff"
                  strokeWidth={3}
                >
                  {moveLabel} {fmtPct(outcomeReturnPct)}
                </text>
              </g>
            )}

            {cursorPoint && cursor != null && (
              <g pointerEvents="none">
                <line x1={x(cursor)} x2={x(cursor)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--color-text-primary)" strokeOpacity={0.35} />
                {cursorPoint.close != null && <circle cx={x(cursor)} cy={y(cursorPoint.close)} r={4} fill="#fff" stroke="var(--color-text-primary)" strokeWidth={1.5} />}
              </g>
            )}
          </svg>
        )}
      </div>

      <details className="group mt-1">
        <summary className={`inline-flex cursor-pointer list-none items-center gap-1 rounded-[3px] py-0.5 text-[11px] font-medium text-[var(--color-brand-700)] [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
          <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
          終値データを表で見る（{points.length}日）
        </summary>
        <div className="mt-1 max-h-56 overflow-auto rounded-[4px] border border-[var(--color-border-soft)]">
          <table id={tableId} className="w-full text-[11px]">
            <caption className="sr-only">チャートの終値データ</caption>
            <thead className="sticky top-0 bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]">
              <tr>
                <th scope="col" className="px-2 py-1 text-left font-semibold">日付</th>
                <th scope="col" className="px-2 py-1 text-right font-semibold">終値</th>
                <th scope="col" className="px-2 py-1 text-left font-semibold">Stage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)] font-mono tabular-nums">
              {points.map((point) => {
                const mark = point.date === basisDate ? '基準日' : point.date === outcomeDate ? `${moveLabel}日` : null
                return (
                  <tr key={point.date} className={mark ? 'bg-[var(--color-surface-subtle)] font-semibold' : undefined}>
                    <td className="px-2 py-0.5">{point.date}{mark && <span className="ml-1 font-sans text-[10px]">{mark}</span>}</td>
                    <td className="px-2 py-0.5 text-right">{point.close == null ? '未取得' : fmtUsd(point.close)}</td>
                    <td className="px-2 py-0.5">{point.stageCode ?? '未取得'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
