import Link from 'next/link'
import { Activity, FlaskConical, GitCompareArrows } from 'lucide-react'

const ITEMS = [
  { href: '/us/analysis/ml-lens', label: 'US AI Lens', icon: Activity },
  { href: '/us/analysis/transitions', label: 'USステージ遷移', icon: GitCompareArrows },
  { href: '/us/analysis/backtest', label: 'US過去検証', icon: FlaskConical },
] as const

export function UsAnalysisNav({ current }: { current: string }) {
  return (
    <nav aria-label="米国株分析" className="flex flex-wrap gap-2 border-b border-[var(--color-border-default)] pb-3">
      {ITEMS.map((item) => {
        const Icon = item.icon
        const active = current === item.href
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex h-9 items-center gap-2 border px-3 text-[12px] font-black ${
              active
                ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white'
                : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-900)] hover:bg-[var(--color-surface-subtle)]'
            }`}
          >
            <Icon size={15} />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
