import Link from 'next/link'
import { ArrowUpRight, ChevronDown, ExternalLink } from 'lucide-react'
import { StatusTag } from '@/components/layout/PageTitle'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import {
  getKabutanGoodBadDisclosureNews,
  getKabutanMaterialNews,
  type KabutanMaterialNewsArticle,
} from '@/lib/queries/kabutan-material-news'

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '---'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.replace('T', ' ').replace('+09:00', '')
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Tokyo',
  }).format(date)
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

function runTone(status: string | null | undefined): 'positive' | 'warning' | 'neutral' {
  if (status === 'success') return 'positive'
  if (status === 'partial' || status === 'failed') return 'warning'
  return 'neutral'
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    const id = url.searchParams.get('b')
    return id ? `${url.hostname}/news/marketnews/?b=${id}` : value.replace(/^https?:\/\//, '')
  } catch {
    return value.replace(/^https?:\/\//, '')
  }
}

function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  })
}

function formatVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}億`
  if (value >= 10000) return `${Math.round(value / 10000).toLocaleString('ja-JP')}万`
  return value.toLocaleString('ja-JP')
}

function changeTone(value: string | null): string {
  if (!value) return 'text-[var(--color-text-tertiary)]'
  if (value.startsWith('+')) return 'text-[var(--color-price-up)]'
  if (value.startsWith('-')) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function shortTermTone(label: string | null | undefined): string {
  if (label === '強気優勢') return 'border-transparent bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  if (label === '好転候補') return 'border-[var(--color-price-up-bg)] bg-white text-[var(--color-price-up)]'
  if (label === '下落警戒') return 'border-transparent bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  if (label === '弱含み注意') return 'border-[var(--color-price-down-bg)] bg-white text-[var(--color-price-down)]'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

function materialToneClass(tone: string | null | undefined): string {
  if (tone === 'good') return 'border-transparent bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  if (tone === 'bad') return 'border-transparent bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

function materialToneLabel(tone: string | null | undefined): string {
  if (tone === 'good') return '好材料'
  if (tone === 'bad') return '悪材料'
  return '材料'
}

const STAGE_LABELS = [
  ['日A', 'dailyA'],
  ['日B', 'dailyB'],
  ['週A', 'weeklyA'],
  ['週B', 'weeklyB'],
  ['月A', 'monthlyA'],
  ['月B', 'monthlyB'],
] as const

function StageChip({ label, value }: { label: string; value: number | null | undefined }) {
  const stage = value == null || !Number.isFinite(value) ? null : Math.round(value)
  return (
    <span
      className="inline-grid min-w-[36px] gap-0.5 rounded-[4px] border px-1 py-1 text-center leading-none"
      style={{
        backgroundColor: stage ? `var(--color-stage-${stage}-bg)` : 'var(--color-surface-subtle)',
        borderColor: stage ? `var(--color-stage-${stage}-border, var(--color-border-soft))` : 'var(--color-border-soft)',
        color: stage ? `var(--color-stage-${stage}-text)` : 'var(--color-text-tertiary)',
      }}
    >
      <span className="text-[9px] font-bold">{label}</span>
      <span className="font-mono text-[13px] font-bold">{stage ?? '-'}</span>
    </span>
  )
}

function articleStockRows(article: KabutanMaterialNewsArticle) {
  if (article.relatedStocks.length > 0) return article.relatedStocks
  return article.relatedTickers.map((ticker) => ({
    ticker,
    name: '名称未取得',
    closeText: null,
    changeText: null,
    comment: null,
    materialTone: null,
    marketText: null,
    screener: null,
  }))
}

function StageStrip({ stock }: { stock: ReturnType<typeof articleStockRows>[number] }) {
  const info = stock.screener
  if (!info) {
    return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">ステージ未取得</span>
  }
  return (
    <div className="grid gap-1">
      <div className="flex min-w-[260px] items-center gap-1">
        {STAGE_LABELS.map(([label, key]) => (
          <StageChip key={key} label={label} value={info.stages[key]} />
        ))}
      </div>
      <div className="font-mono text-[10px] font-bold text-[var(--color-text-tertiary)]">6軸 {info.stageCode}</div>
    </div>
  )
}

function ShortTermCell({ stock }: { stock: ReturnType<typeof articleStockRows>[number] }) {
  const info = stock.screener
  if (!info) return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">判定未取得</span>
  return (
    <div className="grid min-w-[132px] gap-1">
      <span className={`w-fit rounded-full border px-2 py-1 text-[11px] font-bold ${shortTermTone(info.shortTermCheckLabel)}`}>
        {info.shortTermCheckLabel}
      </span>
      <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{info.shortTermCheckStrength}</span>
    </div>
  )
}

function MarketCell({ stock }: { stock: ReturnType<typeof articleStockRows>[number] }) {
  const info = stock.screener
  const market = info?.marketSegment || stock.marketText || '市場---'
  const sector = info?.sector33Name || info?.sector17Name || '業種---'
  return (
    <div className="grid min-w-[150px] gap-1 text-[11px] font-bold">
      <span className="text-[var(--color-brand-900)]">{market}</span>
      <span className="leading-4 text-[var(--color-text-tertiary)]">{sector}</span>
    </div>
  )
}

function LiquidityCell({ stock }: { stock: ReturnType<typeof articleStockRows>[number] }) {
  const info = stock.screener
  if (!info) return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">---</span>
  return (
    <div className="grid min-w-[128px] gap-1 text-[11px] font-bold">
      <span className="font-mono text-[var(--color-brand-900)]">{formatVolume(info.volume)}</span>
      <span className="text-[10px] text-[var(--color-text-tertiary)]">{info.marginType || '属性---'} / {info.asOfDate}</span>
    </div>
  )
}

function ArticleStockTable({
  article,
  maxStocks,
}: {
  article: KabutanMaterialNewsArticle
  maxStocks: number
}) {
  const allRows = articleStockRows(article)
  const rows = allRows.slice(0, maxStocks)
  if (allRows.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-[var(--color-text-tertiary)]">
        銘柄コードを読み取れませんでした。原文リンクで確認してください。
      </p>
    )
  }

  return (
    <div className="grid min-w-0 max-w-full gap-2">
      {allRows.length > rows.length && (
        <p className="text-[11px] text-[var(--color-text-tertiary)]">
          関連 {allRows.length.toLocaleString()} 銘柄のうち、記事掲載順の先頭 {rows.length.toLocaleString()} 銘柄を表示しています。残りは原文で確認できます。
        </p>
      )}
      <ul className="divide-y divide-[var(--color-border-soft)] rounded-[6px] border border-[var(--color-border-soft)] bg-white xl:hidden">
        {rows.map((row) => (
          <li key={`${article.articleId}-${row.ticker}`} className="grid gap-2 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Link
                    href={`/stock/${encodeURIComponent(row.ticker)}`}
                    prefetch={false}
                    className="shrink-0 font-mono text-[13px] font-bold text-[var(--color-brand-800)] hover:underline"
                  >
                    {row.ticker}
                  </Link>
                  <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{row.name}</span>
                  <StockPreviewTrigger ticker={row.ticker} context="home" />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                  <span className={`rounded-[3px] border px-1.5 py-0.5 text-[10px] font-bold ${materialToneClass(row.materialTone)}`}>
                    {materialToneLabel(row.materialTone)}
                  </span>
                  {row.screener && (
                    <span className={`rounded-[3px] border px-1.5 py-0.5 text-[10px] font-bold ${shortTermTone(row.screener.shortTermCheckLabel)}`}>
                      {row.screener.shortTermCheckLabel}
                    </span>
                  )}
                  <span>{row.screener?.marketSegment || row.marketText || '市場---'}</span>
                </div>
              </div>
              <div className="shrink-0 text-right font-mono tabular-nums">
                <div className="text-[13px] font-bold text-[var(--color-text-primary)]">
                  {row.screener ? `¥${formatNumber(row.screener.price, 1)}` : (row.closeText ?? '---')}
                </div>
                <div className={`text-[11px] font-bold ${changeTone(row.changeText)}`}>記事時 {row.changeText ?? '---'}</div>
              </div>
            </div>
            {row.comment && (
              <p className="text-[12px] leading-5 text-[var(--color-text-secondary)]">{row.comment}</p>
            )}
            {row.screener && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <div className="flex gap-1 overflow-hidden">
                  {STAGE_LABELS.map(([label, key]) => (
                    <StageChip key={key} label={label} value={row.screener?.stages[key]} />
                  ))}
                </div>
                <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">出来高 {formatVolume(row.screener.volume)}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="table-scroll hidden rounded-[6px] border border-[var(--color-border-soft)] bg-white xl:block">
        <table className="w-full min-w-[1440px] border-collapse text-left">
        <thead className="bg-[var(--color-surface-subtle)] text-[11px] font-bold text-[var(--color-text-secondary)]">
          <tr>
            <th className="w-[90px] border-b border-[var(--color-border-soft)] px-3 py-2">コード</th>
            <th className="w-[180px] border-b border-[var(--color-border-soft)] px-3 py-2">銘柄名</th>
            <th className="w-[92px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">記事終値</th>
            <th className="w-[92px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">前日比</th>
            <th className="w-[360px] border-b border-[var(--color-border-soft)] px-3 py-2">記事内の材料・コメント</th>
            <th className="w-[110px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">現在値</th>
            <th className="w-[300px] border-b border-[var(--color-border-soft)] px-3 py-2">6ステージ</th>
            <th className="w-[150px] border-b border-[var(--color-border-soft)] px-3 py-2">短期チェック</th>
            <th className="w-[170px] border-b border-[var(--color-border-soft)] px-3 py-2">市場/業種</th>
            <th className="w-[150px] border-b border-[var(--color-border-soft)] px-3 py-2">出来高/属性</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {rows.map((row) => (
            <tr key={`${article.articleId}-${row.ticker}`} className="align-top hover:bg-[#fff8e6]">
              <td className="px-3 py-2">
                <Link
                  href={`/stock/${encodeURIComponent(row.ticker)}`}
                  prefetch={false}
                  className="font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline"
                >
                  {row.ticker}
                </Link>
              </td>
              <td className="px-3 py-2">
                <div className="grid gap-1">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 truncate text-[12px] font-bold text-[var(--color-text-primary)]">{row.name}</span>
                    <StockPreviewTrigger ticker={row.ticker} context="home" />
                  </span>
                  <span className={`w-fit rounded-[3px] border px-1.5 py-0.5 text-[10px] font-bold ${materialToneClass(row.materialTone)}`}>
                    {materialToneLabel(row.materialTone)}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]">{row.closeText ?? '---'}</td>
              <td className={`px-3 py-2 text-right font-mono text-[11px] font-bold ${changeTone(row.changeText)}`}>{row.changeText ?? '---'}</td>
              <td className="px-3 py-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                {row.comment ?? (
                  <span className="text-[var(--color-text-tertiary)]">コメントは原文で確認</span>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[12px] font-bold text-[var(--color-text-primary)]">
                {row.screener ? `¥${formatNumber(row.screener.price, 1)}` : '---'}
              </td>
              <td className="px-3 py-2"><StageStrip stock={row} /></td>
              <td className="px-3 py-2"><ShortTermCell stock={row} /></td>
              <td className="px-3 py-2"><MarketCell stock={row} /></td>
              <td className="px-3 py-2"><LiquidityCell stock={row} /></td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </div>
  )
}

function ArticleDisclosure({
  article,
  defaultOpen = false,
  maxStocks,
}: {
  article: KabutanMaterialNewsArticle
  defaultOpen?: boolean
  maxStocks: number
}) {
  const rows = articleStockRows(article)
  const preview = rows.slice(0, 3).map((row) => row.name).join(' / ')
  return (
    <li className="min-w-0">
      <details open={defaultOpen} className="group min-w-0 max-w-full">
        <summary className="grid min-w-0 cursor-pointer list-none grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 hover:bg-[var(--color-surface-subtle)] md:grid-cols-[20px_96px_minmax(0,1fr)_auto] md:items-center">
          <ChevronDown size={16} aria-hidden className="mt-0.5 text-[var(--color-text-tertiary)] transition-transform group-open:rotate-180 md:mt-0" />
          <time className="font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-tertiary)] md:order-none" dateTime={article.publishedAt}>
            {formatDateTime(article.publishedAt)}
          </time>
          <div className="col-start-2 min-w-0 md:col-start-auto">
            <div className="line-clamp-2 text-[13px] font-bold leading-snug text-[var(--color-text-primary)] md:truncate">
              {article.title}
            </div>
            {preview && (
              <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-tertiary)]">
                {preview}{rows.length > 3 ? ` ほか${rows.length - 3}件` : ''}
              </div>
            )}
          </div>
          <div className="col-start-2 flex items-center gap-2 md:col-start-auto">
            <span className="text-[12px] font-semibold tabular-nums text-[var(--color-text-secondary)]">{rows.length}銘柄</span>
            <StatusTag tone={article.parseStatus === 'ok' ? 'neutral' : 'warning'}>
              {article.parseStatus === 'ok' ? '取得済' : '一覧のみ'}
            </StatusTag>
          </div>
        </summary>
        <div className="grid min-w-0 gap-3 pb-4 md:pl-[32px]">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            {article.snippet && (
              <p className="min-w-0 max-w-[880px] flex-1 border-l-2 border-[var(--color-border-default)] pl-3 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                {article.snippet}
              </p>
            )}
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              data-size="sm"
              title={displayUrl(article.url)}
            >
              原文を開く
              <ExternalLink size={13} aria-hidden />
            </a>
          </div>
          <ArticleStockTable article={article} maxStocks={maxStocks} />
        </div>
      </details>
    </li>
  )
}

function NewsTable({
  articles,
  maxStocks,
}: {
  articles: KabutanMaterialNewsArticle[]
  maxStocks: number
}) {
  return (
    <ol className="min-w-0 divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border-soft)]">
      {articles.map((article, index) => (
        <ArticleDisclosure key={article.articleId} article={article} defaultOpen={index === 0} maxStocks={maxStocks} />
      ))}
    </ol>
  )
}

function NewsSection({
  title,
  description,
  articles,
  maxStocks,
}: {
  title: string
  description: string
  articles: KabutanMaterialNewsArticle[]
  maxStocks: number
}) {
  return (
    <section className="grid min-w-0 gap-1">
      <SectionHeader
        level={1}
        title={title}
        description={description}
        actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{articles.length}記事</span>}
      />
      {articles.length > 0 ? (
        <NewsTable articles={articles} maxStocks={maxStocks} />
      ) : (
        <EmptyState
          title="保存済みの記事はまだありません"
          description="次回のニュース取得後に、対象記事と関連銘柄がここに表示されます。"
        />
      )}
    </section>
  )
}

function compactToneText(tone: string | null | undefined): string {
  if (tone === 'good') return 'text-[var(--color-price-up)]'
  if (tone === 'bad') return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-brand-800)]'
}

function compactChangeTone(value: string | null): string {
  if (!value) return 'text-[var(--color-text-tertiary)]'
  if (value.startsWith('+')) return 'text-[var(--color-price-up)]'
  if (value.startsWith('-')) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function compactRunText(status: string | null | undefined): { label: string; className: string } {
  if (status === 'success') return { label: '取得成功', className: 'text-[var(--color-text-tertiary)]' }
  if (status === 'partial') return { label: '一部失敗', className: 'text-[#b45309]' }
  if (status === 'failed') return { label: '取得失敗', className: 'text-[#b45309]' }
  return { label: '未取得', className: 'text-[var(--color-text-tertiary)]' }
}

/** Dashboard 用: 見出し → 記事行 (時刻 | 見出し + 関連銘柄) の罫線リスト。カード・ピルは使わない */
function CompactNewsList({
  title,
  articles,
}: {
  title: string
  articles: KabutanMaterialNewsArticle[]
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="text-[12px] font-bold text-[var(--color-brand-900)]">{title}</h4>
        <span className="font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{articles.length}記事</span>
      </div>
      <ol className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {articles.map((article) => {
          const allStocks = articleStockRows(article)
          const stocks = allStocks.slice(0, 3)
          return (
            <li key={article.articleId} className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 py-2">
              <time className="pt-px font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]" dateTime={article.publishedAt}>
                {formatDateTime(article.publishedAt)}
              </time>
              <div className="min-w-0">
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="line-clamp-2 text-[12px] font-semibold leading-snug text-[var(--color-text-primary)] hover:text-[var(--color-brand-700)] hover:underline"
                >
                  {article.title}
                </a>
                {stocks.length > 0 && (
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                    {stocks.map((stock) => (
                      <span key={`${article.articleId}-${stock.ticker}`} className="inline-flex min-w-0 max-w-full items-center gap-1 text-[11px]">
                        <Link
                          href={`/stock/${encodeURIComponent(stock.ticker)}`}
                          prefetch={false}
                          className={`shrink-0 font-mono font-bold hover:underline ${compactToneText(stock.materialTone)}`}
                        >
                          {stock.ticker}
                        </Link>
                        <span className="min-w-0 truncate font-semibold text-[var(--color-text-secondary)]">{stock.name}</span>
                        {stock.changeText && (
                          <span className={`shrink-0 font-mono text-[10px] font-bold tabular-nums ${compactChangeTone(stock.changeText)}`}>{stock.changeText}</span>
                        )}
                        <StockPreviewTrigger ticker={stock.ticker} context="home" />
                      </span>
                    ))}
                    {allStocks.length > stocks.length && (
                      <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">ほか{allStocks.length - stocks.length}銘柄</span>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
        {articles.length === 0 && (
          <li className="py-4 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">保存済み記事はありません</li>
        )}
      </ol>
    </section>
  )
}

export async function KabutanMaterialNews({ compact = false }: { compact?: boolean } = {}) {
  const [movers, goodBad] = await Promise.all([
    getKabutanMaterialNews(compact ? 3 : 6),
    getKabutanGoodBadDisclosureNews(compact ? 2 : 3),
  ])
  const lastRun = movers.lastRun ?? goodBad.lastRun
  const status = lastRun?.status ?? null
  const hasError = status === 'failed' || status === 'partial'

  if (compact) {
    const run = compactRunText(status)
    return (
      <section aria-labelledby="dashboard-materials-heading" className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-[var(--color-brand-900)] pb-1.5">
          <h3 id="dashboard-materials-heading" className="text-[13px] font-bold text-[var(--color-brand-900)]">材料ニュース</h3>
          <Link href="/materials" className="inline-flex items-center gap-0.5 text-[11px] font-bold text-[var(--color-brand-700)] hover:underline">
            材料をすべて見る
            <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          <span>出典: 株探 / Kabutan（見出しと関連銘柄のみ表示）</span>
          <span className="tabular-nums">
            最終取得 <span className="font-mono font-bold text-[var(--color-text-primary)]">{formatRunTime(lastRun?.finishedAt ?? lastRun?.startedAt)}</span>
            <span className={`ml-1.5 font-bold ${run.className}`}>{run.label}</span>
          </span>
        </div>
        {hasError && lastRun?.errorSummary && (
          <p className="mb-2 border-l-2 border-[#d97706] pl-2 text-[11px] font-semibold leading-relaxed text-[#92400e]">
            最新取得に一部問題があります。保存済みニュースを表示しています: {lastRun.errorSummary}
          </p>
        )}
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-1">
          <CompactNewsList title="前日に動いた銘柄" articles={movers.articles} />
          <CompactNewsList title="明日の好悪材料" articles={goodBad.articles} />
        </div>
      </section>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--color-border-soft)] pb-3 text-[12px] text-[var(--color-text-tertiary)]">
        <span>出典: 株探。本文は転載せず、記事へのリンクと短い抜粋だけを表示します。</span>
        <span className="flex flex-wrap items-center gap-2 tabular-nums">
          <span>最終取得 {formatRunTime(lastRun?.finishedAt ?? lastRun?.startedAt)}</span>
          <StatusTag tone={runTone(status)}>{compactRunText(status).label}</StatusTag>
          {lastRun && <span>表示 {movers.articles.length + goodBad.articles.length}件</span>}
          <a
            href="https://kabutan.jp/news/marketnews/?category=2"
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
            data-size="sm"
          >
            株探を開く
            <ExternalLink size={13} aria-hidden />
          </a>
        </span>
      </div>

      {hasError && lastRun?.errorSummary && (
        <Notice tone="warning">
          最新の取得で一部問題がありました。保存済みのニュースを表示しています: {lastRun.errorSummary}
        </Notice>
      )}

      <NewsSection
        title="前日に動いた銘柄"
        description="株探「材料」の最新6記事から、材料コメントとステージ・短期チェックを並べます。"
        articles={movers.articles}
        maxStocks={12}
      />
      <NewsSection
        title="明日の好悪材料"
        description="株探「注目」の最新3記事を、好材料・悪材料ごとに銘柄単位で表示します。"
        articles={goodBad.articles}
        maxStocks={12}
      />
    </div>
  )
}
