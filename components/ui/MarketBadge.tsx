// components/ui/MarketBadge.tsx
interface MarketBadgeProps {
  market: 'JP' | 'US'
}

export function MarketBadge({ market }: MarketBadgeProps) {
  const label = market === 'JP' ? '東証' : 'NYSE'
  const color = market === 'JP' ? '#f5a623' : '#4080ff'

  return (
    <span style={{
      fontFamily: 'var(--font-mono)',
      fontSize: '10px',
      letterSpacing: '0.05em',
      color,
      border: `1px solid ${color}`,
      borderRadius: '2px',
      padding: '1px 5px',
      lineHeight: 1.4,
    }}>
      {label}
    </span>
  )
}
