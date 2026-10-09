// components/ui/SectionHeader.tsx
// 枠を作らないセクション見出し。タイトル・一行説明・右端の操作を 1 本の罫線でまとめる。
// level=1 はページ内の大区分 (Dashboard のセクション見出しと同じ太罫線)。

export function SectionHeader({
  title,
  description,
  actions,
  id,
  as: Heading = 'h2',
  level = 2,
  className = '',
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  id?: string
  as?: 'h2' | 'h3'
  /** 1 = ページ内の大区分 (太い罫線) / 2 = 通常の区分 */
  level?: 1 | 2
  className?: string
}) {
  return (
    <div className={`section-head ${className}`} data-level={level}>
      <div className="section-head__copy">
        <Heading id={id}>{title}</Heading>
        {description && <p className="section-head__desc">{description}</p>}
      </div>
      {actions && <div className="section-head__actions">{actions}</div>}
    </div>
  )
}

/** 枠なしのページ区分。旧 Card + CardHeader の組を置き換える (見出し・説明・操作 + 本文) */
export function PageSection({
  title,
  hint,
  action,
  id,
  className = '',
  children,
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  id?: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <section id={id} className={`flex min-w-0 flex-col gap-3 ${className}`}>
      <SectionHeader level={1} title={title} description={hint} actions={action} />
      {children}
    </section>
  )
}
