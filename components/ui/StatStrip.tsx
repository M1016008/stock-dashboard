// components/ui/StatStrip.tsx
// ページ上部の要約帯。値は呼び出し側で整形済みのものをそのまま描く (計算しない)。
// 幅に応じて折り返し、各行の先頭では区切り線を出さない。

export type StatItem = {
  label: React.ReactNode
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'up' | 'down' | 'muted'
}

export function StatStrip({
  items,
  label,
  className = '',
}: {
  items: StatItem[]
  label?: string
  className?: string
}) {
  return (
    <dl className={`stat-strip ${className}`} aria-label={label}>
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd data-tone={item.tone}>{item.value}</dd>
          {item.sub != null && <small>{item.sub}</small>}
        </div>
      ))}
    </dl>
  )
}
