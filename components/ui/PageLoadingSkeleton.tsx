export function PageLoadingSkeleton({
  title = 'データを読み込んでいます',
  sections = 3,
}: {
  title?: string
  sections?: number
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] animate-pulse flex-col gap-4" role="status" aria-live="polite">
      <span className="sr-only">{title}</span>
      <div className="border-b border-[var(--color-border-default)] pb-4">
        <div className="h-4 w-28 bg-[var(--color-surface-muted)]" />
        <div className="mt-3 h-7 w-64 max-w-[72vw] bg-[var(--color-surface-muted)]" />
        <div className="mt-2 h-3 w-[520px] max-w-[90vw] bg-[var(--color-surface-subtle)]" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-24 border border-[var(--color-border-default)] bg-white p-4">
            <div className="h-3 w-24 bg-[var(--color-surface-muted)]" />
            <div className="mt-4 h-6 w-32 bg-[var(--color-surface-subtle)]" />
          </div>
        ))}
      </div>
      {Array.from({ length: sections }, (_, index) => (
        <div key={index} className="h-44 border border-[var(--color-border-default)] bg-white p-4">
          <div className="h-4 w-36 bg-[var(--color-surface-muted)]" />
          <div className="mt-4 h-3 w-full bg-[var(--color-surface-subtle)]" />
          <div className="mt-2 h-3 w-5/6 bg-[var(--color-surface-subtle)]" />
          <div className="mt-2 h-3 w-2/3 bg-[var(--color-surface-subtle)]" />
        </div>
      ))}
    </div>
  )
}
