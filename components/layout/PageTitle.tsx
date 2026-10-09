// components/layout/PageTitle.tsx
//
// ページ先頭の見出し帯。枠やグラデーションを持たず、下罫線 1 本で本文と区切る。
// - eyebrow: 所属する機能群 (例: 市場・業種)。英字の装飾ラベルは使わない
// - badge:   現在の表示状態 (例: 日経225 / 過去日表示)
// - meta:    基準日・件数など、ページ全体に効く事実
// - rightSlot: ページ単位の操作
// - children: ローカルナビ (ViewTabs) など、見出しと一体で読む帯

type StatusTone = 'neutral' | 'brand' | 'positive' | 'warning' | 'danger'

interface PageTitleProps {
  title: string
  subtitle?: React.ReactNode
  eyebrow?: string
  badge?: string
  badgeTone?: StatusTone
  meta?: React.ReactNode
  rightSlot?: React.ReactNode
  children?: React.ReactNode
}

export function PageTitle({
  title,
  subtitle,
  eyebrow,
  badge,
  badgeTone = 'brand',
  meta,
  rightSlot,
  children,
}: PageTitleProps) {
  return (
    <header className="page-header">
      <div className="page-header__row">
        <div className="page-header__copy">
          {eyebrow && <p className="page-header__eyebrow">{eyebrow}</p>}
          <div className="page-header__title">
            <h1>{title}</h1>
            {badge && <StatusTag tone={badgeTone}>{badge}</StatusTag>}
          </div>
          {subtitle && <p className="page-header__desc">{subtitle}</p>}
          {meta && <div className="page-header__meta">{meta}</div>}
        </div>
        {rightSlot && <div className="page-header__aside">{rightSlot}</div>}
      </div>
      {children && <div className="page-header__nav">{children}</div>}
    </header>
  )
}

export const PageHeader = PageTitle

export function StatusTag({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: StatusTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={`status-tag ${className}`} data-tone={tone}>
      {children}
    </span>
  )
}
