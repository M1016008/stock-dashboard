'use client'

import * as Popover from '@radix-ui/react-popover'
import { type ReactNode, useRef, useState } from 'react'
import { PatternBadge } from './PatternBadge'

interface DataPopoverProps {
  trigger: ReactNode
  title: string
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
  triggerAriaLabel?: string
  triggerTitle?: string
  triggerClassName?: string
  showPatternBadge?: boolean
  openOnHover?: boolean
}

export function DataPopover({
  trigger,
  title,
  children,
  align = 'center',
  className = '',
  triggerAriaLabel,
  triggerTitle,
  triggerClassName = '',
  showPatternBadge = true,
  openOnHover = false,
}: DataPopoverProps) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerType = useRef<string | null>(null)

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const openPopover = () => {
    cancelClose()
    setOpen(true)
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 120)
  }

  return (
    <Popover.Root
      open={openOnHover ? open : undefined}
      onOpenChange={openOnHover ? setOpen : undefined}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={triggerAriaLabel}
          title={triggerTitle}
          onPointerEnter={(event) => {
            if (openOnHover && event.pointerType === 'mouse') openPopover()
          }}
          onPointerLeave={() => {
            if (openOnHover) scheduleClose()
          }}
          onPointerDown={(event) => {
            pointerType.current = event.pointerType
          }}
          onFocus={() => {
            if (openOnHover && pointerType.current !== 'touch') openPopover()
          }}
          onBlur={() => {
            if (openOnHover) scheduleClose()
          }}
          onClick={(event) => {
            if (openOnHover && pointerType.current === 'mouse') {
              event.preventDefault()
              openPopover()
            }
            pointerType.current = null
          }}
          className={`inline-flex items-center text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)] ${triggerClassName}`}
        >
          {trigger}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          onPointerEnter={() => {
            if (openOnHover) cancelClose()
          }}
          onPointerLeave={() => {
            if (openOnHover) scheduleClose()
          }}
          onFocusCapture={() => {
            if (openOnHover) cancelClose()
          }}
          onBlurCapture={() => {
            if (openOnHover) scheduleClose()
          }}
          className={`z-50 w-80 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] p-4 shadow-lg ${className}`}
        >
          <div className="mb-2 flex items-center gap-2">
            {showPatternBadge && <PatternBadge variant="subtle" />}
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
