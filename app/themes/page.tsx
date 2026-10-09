import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { PageTitle, StatusTag } from '@/components/layout/PageTitle'
import { StatStrip } from '@/components/ui/StatStrip'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { getKabutanThemes, stockboardThemePath, type KabutanTheme, type KabutanThemeRun } from '@/lib/queries/kabutan-themes'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export const metadata: Metadata = {
  title: 'テーマ — StockBoard',
  description: '株探の人気テーマランキング、概要、関連銘柄を確認します。',
}

function formatRunTime(value: number | null | undefined): string {
  if (!value) return '未取得'
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tokyo',
  }).format(new Date(value * 1000))
}

function runTone(status: string | null | undefined, isStale: boolean): 'positive' | 'warning' | 'danger' | 'neutral' {
  if (isStale) return 'warning'
  if (status === 'success') return 'positive'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'danger'
  return 'neutral'
}

function StockChip({ stock }: { stock: KabutanTheme['representativeStocks'][number] }) {
  return (
    <Link
      href={`/stock/${encodeURIComponent(stock.ticker)}`}
      prefetch={false}
      className="inline-flex min-w-0 items-center gap-1 rounded-[4px] border border-[var(--color-border-soft)] bg-white px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-brand-800)] hover:border-[var(--color-brand-400)] hover:text-[var(--color-brand-900)]"
    >
      <span className="font-mono">{stock.ticker}</span>
      <span className="max-w-[120px] truncate text-[var(--color-text-secondary)]">{stock.name}</span>
    </Link>
  )
}

function ThemeRow({ theme }: { theme: KabutanTheme }) {
  const path = stockboardThemePath(theme.themeId)
  const previewStocks = theme.representativeStocks.slice(0, 4)
  const relatedCount = theme.stockCount ?? theme.relatedStocks.length
  const podium = theme.rank != null && theme.rank <= 3

  return (
    <li className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 hover:bg-[var(--color-surface-subtle)] sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:px-4">
      <span
        className={`inline-flex h-8 w-8 items-center justify-center rounded-[4px] font-mono text-[15px] font-bold tabular-nums ${
          podium ? 'bg-[var(--color-brand-800)] text-white' : 'bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]'
        }`}
        aria-label={theme.rank ? `${theme.rank}位` : '順位なし'}
      >
        {theme.rank ?? '-'}
      </span>
      <div className="min-w-0">
        <Link href={path} prefetch={false} className="text-[15px] font-bold text-[var(--color-text-primary)] hover:text-[var(--color-brand-700)] hover:underline">
          {theme.name}
        </Link>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-[var(--color-text-secondary)]">
          {theme.description ?? '概要は未取得です。関連銘柄と原文リンクで確認してください。'}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {previewStocks.length > 0 ? previewStocks.map((stock) => (
            <StockChip key={`${theme.themeId}-${stock.ticker}`} stock={stock} />
          )) : (
            <span className="text-[11px] text-[var(--color-text-tertiary)]">代表銘柄未取得</span>
          )}
          {theme.representativeStocks.length > previewStocks.length && (
            <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
              ほか{theme.representativeStocks.length - previewStocks.length}銘柄
            </span>
          )}
        </div>
      </div>
      <div className="col-start-2 flex items-center gap-3 sm:col-start-3 sm:flex-col sm:items-end sm:justify-between">
        <span className="text-[12px] tabular-nums text-[var(--color-text-secondary)]">
          {relatedCount ? `関連 ${relatedCount}銘柄` : '銘柄数未取得'}
        </span>
        <Link href={path} prefetch={false} className="btn" data-size="sm">
          詳細
          <ChevronRight size={13} aria-hidden />
        </Link>
      </div>
    </li>
  )
}

export default async function ThemesPage() {
  const { themes, lastRun } = await getKabutanThemes(30)
  const topTheme = themes[0]
  const relatedTotal = themes.reduce((sum, theme) => sum + (theme.stockCount ?? theme.relatedStocks.length), 0)
  const hasError = lastRun?.status === 'failed' || lastRun?.status === 'partial'
  const lastCompletedAt = lastRun?.finishedAt ?? null
  const isStale = !lastCompletedAt || Date.now() / 1000 - lastCompletedAt > 36 * 60 * 60

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <PageTitle
        eyebrow="市場・業種"
        title="テーマ"
        subtitle="株探の人気テーマランキングを、概要と関連銘柄から確認します。"
        meta={<>
          <span>ランキング {topTheme?.rankingAsOf ?? '日時未取得'}</span>
          <StatusTag tone={runTone(lastRun?.status ?? null, isStale)}>
            最終取得 {formatRunTime(lastRun?.finishedAt ?? lastRun?.startedAt)}{isStale ? ' · 要更新' : ''}
          </StatusTag>
        </>}
        rightSlot={
          <a
            href="https://kabutan.jp/info/accessranking/3_2"
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
          >
            株探で開く
            <ExternalLink size={13} aria-hidden />
          </a>
        }
      />

      {hasError && lastRun?.errorSummary && (
        <Notice tone="warning" title="最新の取得に一部問題があります">
          保存済みのテーマを表示しています。{lastRun.errorSummary}
        </Notice>
      )}

      {isStale && (
        <Notice tone="warning" title="最終取得から36時間以上経過しています">
          毎日21:00の自動更新と22:00・23:00の再確認で取得し、完了後に自動で反映します。
        </Notice>
      )}

      <StatStrip
        label="テーマの概要"
        items={[
          { label: '保存テーマ', value: themes.length.toLocaleString('ja-JP') },
          { label: '首位テーマ', value: <span className="text-[17px]">{topTheme?.name ?? '—'}</span> },
          { label: '関連銘柄（延べ）', value: relatedTotal.toLocaleString('ja-JP') },
        ]}
      />

      <section aria-labelledby="theme-ranking" className="min-w-0">
        <div className="section-head">
          <div className="section-head__copy">
            <h2 id="theme-ranking">人気テーマランキング</h2>
            <p className="section-head__desc">3日間アクセスランキング · 出典 株探</p>
          </div>
        </div>
        {themes.length > 0 ? (
          <ol className="panel m-0 list-none divide-y divide-[var(--color-border-soft)] p-0">
            {themes.map((theme) => (
              <ThemeRow key={theme.themeId} theme={theme} />
            ))}
          </ol>
        ) : (
          <EmptyState
            className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]"
            title="保存済みのテーマはまだありません"
            description="人気テーマの取得が完了すると、ここに表示されます。"
          />
        )}
      </section>
    </div>
  )
}
