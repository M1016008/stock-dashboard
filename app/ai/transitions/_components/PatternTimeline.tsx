import type { TimelinePoint } from '@/lib/server/transitions'

export function PatternTimeline({ data }: { data: TimelinePoint[] }) {
  if (data.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-tertiary)]">データなし</p>
    )
  }
  const max = Math.max(...data.map(d => d.count))
  return (
    <div className="space-y-1">
      <div className="flex h-12 items-end gap-px overflow-x-auto">
        {data.map(d => (
          <div
            key={d.ym}
            className="min-w-[3px] flex-1 bg-[var(--color-pattern-500)] transition-colors hover:bg-[var(--color-pattern-700)]"
            style={{ height: `${(d.count / max) * 100}%` }}
            title={`${d.ym}: ${d.count.toLocaleString()}件`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
        <span>{data[0].ym}</span>
        <span className="tabular-nums">
          ピーク {max.toLocaleString()}件/月
        </span>
        <span>{data[data.length - 1].ym}</span>
      </div>
    </div>
  )
}
