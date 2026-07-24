export default function Loading() {
  return (
    <div className="mx-auto grid w-full max-w-[1480px] gap-3 px-3 py-4" aria-busy="true" aria-label="ページを読み込み中">
      <div className="h-10 animate-pulse border border-[var(--color-border-default)] bg-white" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-20 animate-pulse border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]"
          />
        ))}
      </div>
      <div className="h-[360px] animate-pulse border border-[var(--color-border-default)] bg-white" />
    </div>
  )
}
