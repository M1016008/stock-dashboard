import type { ReactNode } from 'react'
import { DataDensityIndicator } from './DataDensityIndicator'
import { DataPopover } from './DataPopover'

interface ObservationCardProps {
  title: string
  primary: ReactNode
  secondary?: ReactNode
  density?: number
  popover?: {
    title: string
    content: ReactNode
  }
  className?: string
}

export function ObservationCard({
  title,
  primary,
  secondary,
  density,
  popover,
  className = '',
}: ObservationCardProps) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] px-[var(--spacing-card-x)] py-[var(--spacing-card-y)] ${className}`}
      style={{ borderLeft: '2px solid var(--color-pattern-500)' }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
          {title}
        </h3>
        <div className="flex items-center gap-2">
          {density !== undefined && <DataDensityIndicator count={density} />}
          {popover && (
            <DataPopover
              trigger={
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <circle
                    cx="7"
                    cy="7"
                    r="6"
                    fill="none"
                    stroke="currentColor"
                  />
                  <text
                    x="7"
                    y="10"
                    textAnchor="middle"
                    fontSize="9"
                    fill="currentColor"
                  >
                    i
                  </text>
                </svg>
              }
              title={popover.title}
            >
              {popover.content}
            </DataPopover>
          )}
        </div>
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">
        {primary}
      </div>
      {secondary && (
        <div className="mt-1 text-xs text-[var(--color-text-secondary)] tabular-nums">
          {secondary}
        </div>
      )}
    </div>
  )
}
