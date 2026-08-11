import type { Metadata } from 'next'
import Link from 'next/link'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { getKabutanTheme, type KabutanThemeStock } from '@/lib/queries/kabutan-themes'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type PageProps = {
  params: Promise<{ themeId: string }>
}

function decodeThemeId(value: string): string {
  return decodePathSegment(value)
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { themeId } = await params
  const name = decodeThemeId(themeId)
  return {
    title: `${name} — テーマ — StockBoard`,
    description: `${name}の概要、関連銘柄、6ステージ、短期チェックを確認します。`,
  }
}

function changeTone(value: string | null | undefined): string {
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

function StageStrip({ stock }: { stock: KabutanThemeStock }) {
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

function ShortTermCell({ stock }: { stock: KabutanThemeStock }) {
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

function RelatedStockTable({ stocks }: { stocks: KabutanThemeStock[] }) {
  if (stocks.length === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-6 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
        関連銘柄はまだ保存されていません。原文リンクで確認してください。
      </div>
    )
  }

  return (
    <div className="max-w-full overflow-x-auto rounded-[8px] border border-[var(--color-border-soft)] bg-white">
      <table className="w-full min-w-[1480px] border-collapse text-left">
        <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black tracking-wide text-[var(--color-text-tertiary)]">
          <tr>
            <th className="w-[90px] border-b border-[var(--color-border-soft)] px-3 py-2">コード</th>
            <th className="w-[220px] border-b border-[var(--color-border-soft)] px-3 py-2">銘柄名</th>
            <th className="w-[76px] border-b border-[var(--color-border-soft)] px-3 py-2">市場</th>
            <th className="w-[100px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">株価</th>
            <th className="w-[120px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">前日比</th>
            <th className="w-[300px] border-b border-[var(--color-border-soft)] px-3 py-2">6ステージ</th>
            <th className="w-[156px] border-b border-[var(--color-border-soft)] px-3 py-2">短期チェック</th>
            <th className="w-[90px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">PER</th>
            <th className="w-[90px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">PBR</th>
            <th className="w-[90px] border-b border-[var(--color-border-soft)] px-3 py-2 text-right">利回り</th>
            <th className="w-[86px] border-b border-[var(--color-border-soft)] px-3 py-2">詳細</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {stocks.map((stock) => (
            <tr key={stock.ticker} className="align-top hover:bg-[var(--color-surface-subtle)]">
              <td className="px-3 py-2">
                <Link
                  href={`/stock/${encodeURIComponent(stock.ticker)}`}
                  prefetch={false}
                  className="font-mono text-[12px] font-black text-[var(--color-brand-800)] hover:text-[var(--color-market-red)]"
                >
                  {stock.ticker}
                </Link>
              </td>
              <td className="px-3 py-2 text-[12px] font-black text-[var(--color-brand-900)]">{stock.name}</td>
              <td className="px-3 py-2 text-[11px] font-bold text-[var(--color-text-secondary)]">{stock.marketText ?? '---'}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] font-bold text-[var(--color-text-secondary)]">{stock.priceText ?? '---'}</td>
              <td className={`px-3 py-2 text-right font-mono text-[11px] font-black ${changeTone(stock.changeText)}`}>
                {stock.changeText ?? '---'}{stock.changePercentText ? ` / ${stock.changePercentText}` : ''}
              </td>
              <td className="px-3 py-2"><StageStrip stock={stock} /></td>
              <td className="px-3 py-2"><ShortTermCell stock={stock} /></td>
              <td className="px-3 py-2 text-right font-mono text-[11px] font-bold text-[var(--color-text-secondary)]">{stock.perText ?? '---'}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] font-bold text-[var(--color-text-secondary)]">{stock.pbrText ?? '---'}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] font-bold text-[var(--color-text-secondary)]">{stock.yieldText ?? '---'}</td>
              <td className="px-3 py-2">
                <Link
                  href={`/stock/${encodeURIComponent(stock.ticker)}`}
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

export default async function ThemeDetailPage({ params }: PageProps) {
  const { themeId: rawThemeId } = await params
  const themeId = decodeThemeId(rawThemeId)
  const theme = await getKabutanTheme(themeId)

  if (!theme) {
    return (
      <div className="grid min-w-0 max-w-full gap-5">
        <PageTitle title="テーマ" subtitle="保存済みテーマが見つかりませんでした。" badge="株探テーマ" />
        <Card>
          <div className="grid gap-3 text-[12px] font-bold text-[var(--color-text-secondary)]">
            <p>テーマデータがまだ保存されていないか、取得後にURLが変わった可能性があります。</p>
            <Link href="/themes" className="w-fit rounded-full border border-[var(--color-market-red)] px-3 py-1.5 text-[11px] font-black text-[var(--color-market-red)] hover:bg-red-50">
              テーマ一覧へ戻る
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  const relatedCount = theme.stockCount ?? theme.relatedStocks.length

  return (
    <div className="grid min-w-0 max-w-full gap-5">
      <PageTitle
        title={theme.name}
        subtitle={theme.rank ? `人気テーマランキング ${theme.rank}位 / ${theme.rankingAsOf ?? '日時未取得'}` : '人気テーマランキング'}
        badge="テーマ詳細"
        rightSlot={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/themes"
              className="rounded-full border border-[var(--color-border-soft)] bg-white px-2.5 py-1 text-[10px] font-black text-[var(--color-text-secondary)] hover:border-[var(--color-market-red)] hover:text-[var(--color-market-red)]"
            >
              一覧へ
            </Link>
            <a
              href={theme.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-current/25 bg-white px-2.5 py-1 text-[10px] font-black text-[var(--color-market-red)] hover:bg-[var(--color-surface-subtle)]"
            >
              株探を開く
            </a>
          </div>
        }
      />

      <Card size="lg" className="min-w-0 p-0">
        <CardHeader
          title="テーマ概要"
          hint="株探のテーマ説明と関連銘柄を保存済みデータから表示します。"
          action={
            <span className="rounded-full border border-[var(--color-border-soft)] bg-white px-2.5 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
              {relatedCount ? `${relatedCount}銘柄` : '銘柄数未取得'}
            </span>
          }
        />
        <div className="px-4 pb-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_280px]">
            <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3">
              <div className="text-[10px] font-black text-[var(--color-text-tertiary)]">概要</div>
              <p className="mt-2 text-[12px] font-semibold leading-6 text-[var(--color-text-secondary)]">
                {theme.description ?? '概要は未取得です。原文リンクで確認してください。'}
              </p>
            </div>
            <div className="rounded-[8px] border border-red-100 bg-red-50 px-3 py-3">
              <div className="text-[10px] font-black text-red-700">ランキング</div>
              <div className="mt-1 font-mono text-[26px] font-black text-red-800">{theme.rank ?? '-'}</div>
              <div className="mt-1 text-[11px] font-bold text-red-700">{theme.rankingAsOf ?? '日時未取得'}</div>
            </div>
          </div>
        </div>
      </Card>

      <Card size="lg" className="min-w-0 p-0">
        <CardHeader
          title="関連銘柄一覧"
          hint="株価、前日比、6ステージ、短期チェック、PER/PBR、利回り"
          action={
            <span className="rounded-full border border-[var(--color-border-soft)] bg-white px-2.5 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
              {theme.relatedStocks.length}件
            </span>
          }
        />
        <div className="min-w-0 px-4 pb-4">
          <RelatedStockTable stocks={theme.relatedStocks} />
        </div>
      </Card>
    </div>
  )
}
