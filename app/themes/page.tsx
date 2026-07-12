import Link from 'next/link'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { getKabutanThemes, stockboardThemePath, type KabutanTheme, type KabutanThemeRun } from '@/lib/queries/kabutan-themes'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

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

function runTone(status: string | null | undefined): string {
  if (status === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'partial') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'failed') return 'border-sky-200 bg-sky-50 text-sky-700'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]'
}

function RankBadge({ rank }: { rank: number | null }) {
  const tone = rank === 1
    ? 'border-red-200 bg-red-50 text-red-700'
    : rank === 2
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : rank === 3
        ? 'border-sky-200 bg-sky-50 text-sky-700'
        : 'border-slate-200 bg-slate-50 text-slate-700'
  return (
    <span className={`inline-flex h-9 min-w-9 items-center justify-center rounded-[6px] border px-2 font-mono text-[15px] font-black ${tone}`}>
      {rank ?? '-'}
    </span>
  )
}

function StockChip({ stock }: { stock: KabutanTheme['representativeStocks'][number] }) {
  return (
    <Link
      href={`/stock/${encodeURIComponent(stock.ticker)}`}
      prefetch={false}
      className="inline-flex min-w-0 items-center gap-1 rounded-full border border-[var(--color-border-soft)] bg-white px-2 py-1 text-[10px] font-black text-[var(--color-brand-800)] hover:border-[var(--color-market-red)] hover:text-[var(--color-market-red)]"
    >
      <span className="font-mono">{stock.ticker}</span>
      <span className="max-w-[110px] truncate">{stock.name}</span>
    </Link>
  )
}

function ThemeCard({ theme }: { theme: KabutanTheme }) {
  const path = stockboardThemePath(theme.themeId)
  const previewStocks = theme.representativeStocks.slice(0, 4)
  const relatedCount = theme.stockCount ?? theme.relatedStocks.length

  return (
    <article className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-3 shadow-[0_1px_0_rgba(15,23,42,0.03)] transition hover:border-[var(--color-market-red)]">
      <div className="grid gap-3 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-start">
        <RankBadge rank={theme.rank} />
        <div className="min-w-0">
          <Link href={path} className="text-[15px] font-black text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
            {theme.name}
          </Link>
          <p className="mt-1 line-clamp-2 text-[11px] font-semibold leading-5 text-[var(--color-text-secondary)]">
            {theme.description ?? '概要は未取得です。関連銘柄と原文リンクで確認してください。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2.5 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
            {relatedCount ? `${relatedCount}銘柄` : '銘柄数未取得'}
          </span>
          <Link
            href={path}
            className="rounded-full border border-[var(--color-market-red)] bg-white px-2.5 py-1 text-[10px] font-black text-[var(--color-market-red)] hover:bg-red-50"
          >
            詳細
          </Link>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {previewStocks.length > 0 ? previewStocks.map((stock) => (
          <StockChip key={`${theme.themeId}-${stock.ticker}`} stock={stock} />
        )) : (
          <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">代表銘柄未取得</span>
        )}
        {theme.representativeStocks.length > previewStocks.length && (
          <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] font-black text-[var(--color-text-tertiary)]">
            +{theme.representativeStocks.length - previewStocks.length}
          </span>
        )}
      </div>
    </article>
  )
}

function LastRunBadge({ lastRun, count }: { lastRun: KabutanThemeRun | null; count: number }) {
  const status = lastRun?.status ?? null
  return (
    <div className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${runTone(status)}`}>
      最終取得 {formatRunTime(lastRun?.finishedAt ?? lastRun?.startedAt)}
      {lastRun ? ` / 表示 ${count}件` : ''}
    </div>
  )
}

export default async function ThemesPage() {
  const { themes, lastRun } = await getKabutanThemes(30)
  const topTheme = themes[0]
  const relatedTotal = themes.reduce((sum, theme) => sum + (theme.stockCount ?? theme.relatedStocks.length), 0)
  const hasError = lastRun?.status === 'failed' || lastRun?.status === 'partial'

  return (
    <main className="grid gap-5">
      <PageTitle
        title="テーマ"
        subtitle="株探の人気テーマランキングを、概要と関連銘柄の表で確認します。"
        badge="株探テーマ"
        rightSlot={
          <a
            href="https://kabutan.jp/info/accessranking/3_2"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-current/25 bg-white px-2.5 py-1 text-[10px] font-black text-[var(--color-market-red)] hover:bg-[var(--color-surface-subtle)]"
          >
            株探を開く
          </a>
        }
      />

      <Card size="lg" className="p-0">
        <CardHeader
          title="人気テーマランキング"
          hint="3日間アクセスランキングと関連銘柄を保存済みデータから表示します。"
          action={<LastRunBadge lastRun={lastRun} count={themes.length} />}
        />
        <div className="px-4 pb-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-bold leading-5 text-[var(--color-text-tertiary)]">
              出典: 株探 / Kabutan。テーマ概要と関連銘柄を保存し、原文リンクを併記します。
            </div>
            <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2.5 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
              {topTheme?.rankingAsOf ?? 'ランキング日時未取得'}
            </span>
          </div>

          {hasError && lastRun?.errorSummary && (
            <p className="mb-3 rounded-[6px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-5 text-amber-800">
              最新取得に一部問題があります。保存済みテーマを表示しています: {lastRun.errorSummary}
            </p>
          )}

          <div className="mb-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3">
              <div className="text-[10px] font-black text-[var(--color-text-tertiary)]">保存テーマ</div>
              <div className="mt-1 font-mono text-[22px] font-black text-[var(--color-brand-900)]">{themes.length}</div>
            </div>
            <div className="rounded-[8px] border border-red-100 bg-red-50 px-3 py-3">
              <div className="text-[10px] font-black text-red-700">首位テーマ</div>
              <div className="mt-1 truncate text-[18px] font-black text-red-800">{topTheme?.name ?? '---'}</div>
            </div>
            <div className="rounded-[8px] border border-sky-100 bg-sky-50 px-3 py-3">
              <div className="text-[10px] font-black text-sky-700">関連銘柄延べ</div>
              <div className="mt-1 font-mono text-[22px] font-black text-sky-800">{relatedTotal.toLocaleString('ja-JP')}</div>
            </div>
          </div>

          {themes.length > 0 ? (
            <div className="grid gap-4">
              <div className="grid gap-3">
                {themes.map((theme) => (
                  <ThemeCard key={theme.themeId} theme={theme} />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-8 text-center">
              <div className="text-[13px] font-black text-[var(--color-brand-900)]">保存済みテーマはまだありません</div>
              <p className="mt-2 text-[11px] font-semibold leading-5 text-[var(--color-text-tertiary)]">
                `npm run batch:kabutan-themes` を実行すると、取得できた人気テーマがここに表示されます。
              </p>
            </div>
          )}
        </div>
      </Card>
    </main>
  )
}
