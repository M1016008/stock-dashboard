export function PageLoadingSkeleton({
  title = 'データを読み込んでいます',
  sections = 3,
}: {
  title?: string
  sections?: number
}) {
  return (
    <div className="flex w-full flex-col gap-4" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{title}</span>
      <div className="animate-pulse border-b border-[var(--color-border-default)] pb-4">
        <div className="h-3 w-24 rounded-[3px] bg-[var(--color-surface-muted)]" />
        <div className="mt-3 h-7 w-64 max-w-full rounded-[3px] bg-[var(--color-surface-muted)]" />
        <div className="mt-2.5 h-3 w-[520px] max-w-full rounded-[3px] bg-[var(--color-surface-subtle)]" />
      </div>
      <div className="flex animate-pulse flex-wrap border-y border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="min-w-[150px] flex-1 border-l border-[var(--color-border-soft)] px-4 py-3 first:border-l-0">
            <div className="h-3 w-20 rounded-[3px] bg-[var(--color-surface-muted)]" />
            <div className="mt-2.5 h-5 w-28 rounded-[3px] bg-[var(--color-surface-muted)]" />
          </div>
        ))}
      </div>
      {Array.from({ length: sections }, (_, index) => (
        <div key={index} className="animate-pulse">
          <div className="h-4 w-40 rounded-[3px] bg-[var(--color-surface-muted)]" />
          <div className="mt-3 h-px w-full bg-[var(--color-border-soft)]" />
          <div className="mt-3 h-3 w-full rounded-[3px] bg-[var(--color-surface-subtle)]" />
          <div className="mt-2 h-3 w-5/6 rounded-[3px] bg-[var(--color-surface-subtle)]" />
          <div className="mt-2 h-3 w-2/3 rounded-[3px] bg-[var(--color-surface-subtle)]" />
        </div>
      ))}
    </div>
  )
}
