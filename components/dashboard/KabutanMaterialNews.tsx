import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
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

function runTone(status: string | null | undefined): string {
  if (status === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'partial') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'failed') return 'border-sky-200 bg-sky-50 text-sky-700'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]'
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
  if (value.startsWith('+')) return 'text-red-600'
  if (value.startsWith('-')) return 'text-blue-600'
  return 'text-[var(--color-text-secondary)]'
}

function shortTermTone(label: string | null | undefined): string {
  if (label === '強気優勢') return 'border-red-200 bg-red-50 text-red-700'
  if (label === '好転候補') return 'border-rose-200 bg-rose-50 text-rose-700'
  if (label === '下落警戒') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (label === '弱含み注意') return 'border-sky-200 bg-sky-50 text-sky-700'
  return 'border-slate-200 bg-slate-50 text-slate-600'
}

function materialToneClass(tone: string | null | undefined): string {
  if (tone === 'good') return 'border-red-200 bg-red-50 text-red-700'
  if (tone === 'bad') return 'border-blue-200 bg-blue-50 text-blue-700'
  return 'border-slate-200 bg-slate-50 text-slate-600'
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
      className="inline-grid min-w-[38px] gap-0.5 rounded-[6px] border px-1.5 py-1 text-center leading-none"
      style={{
        backgroundColor: stage ? `var(--color-stage-${stage}-bg)` : 'var(--color-surface-subtle)',
        borderColor: stage ? `var(--color-stage-${stage}-border, var(--color-border-soft))` : 'var(--color-border-soft)',
        color: stage ? `var(--color-stage-${stage}-text)` : 'var(--color-text-tertiary)',
      }}
    >
      <span className="text-[9px] font-black">{label}</span>
      <span className="font-mono text-[13px] font-black">{stage ?? '-'}</span>
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
      <div className="font-mono text-[10px] font-black text-[var(--color-text-tertiary)]">6軸 {info.stageCode}</div>
    </div>
  )
}

function ShortTermCell({ stock }: { stock: ReturnType<typeof articleStockRows>[number] }) {
  const info = stock.screener
  if (!info) return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">判定未取得</span>
  return (
    <div className="grid min-w-[132px] gap-1">
      <span className={`w-fit rounded-full border px-2 py-1 text-[11px] font-black ${shortTermTone(info.shortTermCheckLabel)}`}>
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

function ArticleStockTable({ article }: { article: KabutanMaterialNewsArticle }) {
  const rows = articleStockRows(article)
  if (rows.length === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-5 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
        銘柄コードを読み取れませんでした。原文リンクで確認してください。
      </div>
    )
  }

  return (
    <div className="max-w-full overflow-x-auto rounded-[8px] border border-[var(--color-border-soft)] bg-white">
      <table className="w-full min-w-[1540px] border-collapse text-left">
        <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black tracking-wide text-[var(--color-text-tertiary)]">
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
            <th className="w-[86px] border-b border-[var(--color-border-soft)] px-3 py-2">詳細</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {rows.map((row) => (
            <tr key={`${article.articleId}-${row.ticker}`} className="align-top hover:bg-[var(--color-surface-subtle)]">
              <td className="px-3 py-2">
                <Link
                  href={`/stock/${encodeURIComponent(row.ticker)}`}
                  prefetch={false}
                  className="font-mono text-[12px] font-black text-[var(--color-brand-800)] hover:text-[var(--color-market-red)]"
                >
                  {row.ticker}
                </Link>
              </td>
              <td className="px-3 py-2">
                <div className="grid gap-1">
                  <span className="text-[12px] font-black text-[var(--color-brand-900)]">{row.name}</span>
                  <span className={`w-fit rounded-full border px-2 py-0.5 text-[10px] font-black ${materialToneClass(row.materialTone)}`}>
                    {materialToneLabel(row.materialTone)}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-mono text-[11px] font-bold text-[var(--color-text-secondary)]">{row.closeText ?? '---'}</td>
              <td className={`px-3 py-2 text-right font-mono text-[11px] font-black ${changeTone(row.changeText)}`}>{row.changeText ?? '---'}</td>
              <td className="px-3 py-2 text-[11px] font-semibold leading-5 text-[var(--color-text-secondary)]">{row.comment ?? '記事内コメント未抽出'}</td>
              <td className="px-3 py-2 text-right font-mono text-[12px] font-black text-[var(--color-brand-900)]">
                {row.screener ? `¥${formatNumber(row.screener.price, 1)}` : '---'}
              </td>
              <td className="px-3 py-2"><StageStrip stock={row} /></td>
              <td className="px-3 py-2"><ShortTermCell stock={row} /></td>
              <td className="px-3 py-2"><MarketCell stock={row} /></td>
              <td className="px-3 py-2"><LiquidityCell stock={row} /></td>
              <td className="px-3 py-2">
                <Link
                  href={`/stock/${encodeURIComponent(row.ticker)}`}
                  prefetch={false}
                  className="rounded-full border border-[var(--color-border-soft)] bg-white px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)] hover:border-[var(--color-market-red)] hover:text-[var(--color-market-red)]"
                >
                  開く
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ArticleDisclosure({ article, defaultOpen = false }: { article: KabutanMaterialNewsArticle; defaultOpen?: boolean }) {
  const rows = articleStockRows(article)
  const preview = rows.slice(0, 3).map((row) => row.name).join(' / ')
  return (
    <details open={defaultOpen} className="group min-w-0 max-w-full rounded-[8px] border border-[var(--color-border-soft)] bg-white shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      <summary className="grid min-w-0 cursor-pointer list-none gap-3 px-3 py-3 hover:bg-[var(--color-surface-subtle)] lg:grid-cols-[112px_minmax(0,1fr)_120px_112px] lg:items-center">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-[11px] font-black text-rose-700 group-open:bg-rose-100 group-open:rotate-180">
            ▾
          </span>
          <time className="font-mono text-[11px] font-black text-[var(--color-text-secondary)]" dateTime={article.publishedAt}>
            {formatDateTime(article.publishedAt)}
          </time>
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-black text-[var(--color-brand-900)] group-hover:text-[var(--color-market-red)]">
            {article.title}
          </div>
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block truncate font-mono text-[10px] font-bold text-[var(--color-market-red)] hover:underline"
          >
            {displayUrl(article.url)}
          </a>
          {preview && (
            <div className="mt-1 truncate text-[11px] font-bold text-[var(--color-text-tertiary)]">
              読み取り銘柄: {preview}{rows.length > 3 ? ` ほか${rows.length - 3}件` : ''}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-black text-slate-700">
            {rows.length}銘柄
          </span>
          <span className={`rounded-full border px-2 py-1 text-[10px] font-black ${article.parseStatus === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
            {article.parseStatus === 'ok' ? '取得済' : '一覧のみ'}
          </span>
        </div>
        <div className="text-[11px] font-black text-[var(--color-text-tertiary)] group-open:text-[var(--color-brand-900)]">
          銘柄表を開く/閉じる
        </div>
      </summary>
      <div className="min-w-0 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
        {article.snippet && (
          <p className="mb-3 rounded-[6px] border border-[var(--color-border-soft)] bg-white px-3 py-2 text-[11px] font-semibold leading-5 text-[var(--color-text-secondary)]">
            {article.snippet}
          </p>
        )}
        <ArticleStockTable article={article} />
      </div>
    </details>
  )
}

function NewsTable({ articles }: { articles: KabutanMaterialNewsArticle[] }) {
  return (
    <div className="grid min-w-0 gap-3">
      {articles.map((article, index) => (
        <ArticleDisclosure key={article.articleId} article={article} defaultOpen={index === 0} />
      ))}
    </div>
  )
}

function NewsSection({
  title,
  description,
  articles,
}: {
  title: string
  description: string
  articles: KabutanMaterialNewsArticle[]
}) {
  return (
    <section className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-black text-[var(--color-brand-900)]">{title}</h3>
          <p className="mt-1 text-[11px] font-bold leading-5 text-[var(--color-text-tertiary)]">{description}</p>
        </div>
        <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2.5 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
          {articles.length}記事
        </span>
      </div>
      {articles.length > 0 ? (
        <NewsTable articles={articles} />
      ) : (
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-6 text-center">
          <div className="text-[12px] font-black text-[var(--color-brand-900)]">保存済み記事はまだありません</div>
          <p className="mt-2 text-[11px] font-semibold leading-5 text-[var(--color-text-tertiary)]">
            `npm run batch:kabutan-material-news` を実行すると、取得できた対象記事がここに表示されます。
          </p>
        </div>
      )}
    </section>
  )
}

export async function KabutanMaterialNews() {
  const [movers, goodBad] = await Promise.all([
    getKabutanMaterialNews(12),
    getKabutanGoodBadDisclosureNews(6),
  ])
  const lastRun = movers.lastRun ?? goodBad.lastRun
  const status = lastRun?.status ?? null
  const hasError = status === 'failed' || status === 'partial'

  return (
    <Card size="lg" className="p-0">
      <CardHeader
        title="株探ニュース"
        hint="前日に動いた銘柄と、明日の好悪材料を銘柄単位の表で確認します。"
        action={
          <a
            href="https://kabutan.jp/news/marketnews/?category=2"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-current/25 bg-white px-2.5 py-1 text-[10px] font-black hover:bg-[var(--color-surface-subtle)]"
          >
            株探を開く
          </a>
        }
      />
      <div className="px-4 pb-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-bold leading-5 text-[var(--color-text-tertiary)]">
            出典: 株探 / Kabutan。本文全文は転載せず、記事URLと短い抜粋だけを表示します。
          </div>
          <div className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${runTone(status)}`}>
            最終取得 {formatRunTime(lastRun?.finishedAt ?? lastRun?.startedAt)}
            {lastRun ? ` / 表示 ${movers.articles.length + goodBad.articles.length}件` : ''}
          </div>
        </div>

        {hasError && lastRun?.errorSummary && (
          <p className="mb-3 rounded-[6px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-5 text-amber-800">
            最新取得に一部問題があります。保存済みニュースを表示しています: {lastRun.errorSummary}
          </p>
        )}

        <div className="grid gap-5">
          <NewsSection
            title="前日に動いた銘柄"
            description="市場ニュース「材料」から、記事内の材料コメントとStockBoard側のスクリーナー情報を並べます。"
            articles={movers.articles}
          />
          <NewsSection
            title="明日の好悪材料"
            description="市場ニュース「注目」の開示情報チェック記事を、好材料/悪材料別に銘柄単位で表示します。"
            articles={goodBad.articles}
          />
        </div>
      </div>
    </Card>
  )
}
