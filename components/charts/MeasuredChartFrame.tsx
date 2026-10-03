'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

interface ChartSize {
  width: number
  height: number
}

interface MeasuredChartFrameProps {
  className?: string
  children: (size: ChartSize) => ReactNode
}

export function MeasuredChartFrame({ className = '', children }: MeasuredChartFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<ChartSize | null>(null)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const update = (width: number, height: number) => {
      const next = { width: Math.floor(width), height: Math.floor(height) }
      setSize(next.width > 0 && next.height > 0 ? next : null)
    }
    const rect = frame.getBoundingClientRect()
    update(rect.width, rect.height)
    const observer = new ResizeObserver((entries) => {
      const content = entries[0]?.contentRect
      if (content) update(content.width, content.height)
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={frameRef} className={`min-w-0 ${className}`}>
      {size ? children(size) : (
        <div className="grid h-full place-items-center text-[10px] font-bold text-[var(--color-text-tertiary)]">
          グラフを準備中...
        </div>
      )}
    </div>
  )
}
