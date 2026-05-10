'use client'

import * as Popover from '@radix-ui/react-popover'
import type { ReactNode } from 'react'
import { PatternBadge } from './PatternBadge'

interface DataPopoverProps {
  trigger: ReactNode
  title: string
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}

export function DataPopover({
  trigger,
  title,
  children,
  align = 'center',
  className = '',
}: DataPopoverProps) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)]"
        >
          {trigger}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          className={`z-50 w-80 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] p-4 shadow-lg ${className}`}
        >
          <div className="mb-2 flex items-center gap-2">
            <PatternBadge variant="subtle" />
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
          <div className="text-xs text-[var(--color-text-secondary)]">
            {children}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
