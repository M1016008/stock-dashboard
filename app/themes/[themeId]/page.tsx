import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { EmptyState } from '@/components/ui/EmptyState'
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
  if (value.startsWith('+')) return 'text-[var(--color-price-up)]'
  if (value.startsWith('-')) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function shortTermTone(label: string | null | undefined): string {
  if (label === '強気優勢') return 'border-[#f0b8b8] bg-[var(--color-price-up-bg)] text-[var(--color-price-up-mid)]'
  if (label === '好転候補') return 'border-[#f5cfd3] bg-[#fff7f8] text-[var(--color-price-up-mid)]'
  if (label === '下落警戒') return 'border-[#b9d3f0] bg-[var(--color-price-down-bg)] text-[var(--color-price-down-mid)]'
  if (label === '弱含み注意') return 'border-[#cfe0f3] bg-[#f6faff] text-[var(--color-price-down-mid)]'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
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
      className="inline-grid min-w-[36px] gap-0.5 rounded-[4px] border px-1.5 py-1 text-center leading-none"
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
      <div className="flex items-center gap-1">
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
    <div className="grid gap-1">
      <span className={`w-fit rounded-[4px] border px-1.5 py-0.5 text-[11px] font-bold ${shortTermTone(info.shortTermCheckLabel)}`}>
        {info.shortTermCheckLabel}
      </span>
      <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{info.shortTermCheckStrength}</span>
    </div>
  )
}

function RelatedStockTable({ stocks }: { stocks: KabutanThemeStock[] }) {
  if (stocks.length === 0) {
    return (
      <EmptyState
        className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]"
        title="関連銘柄はまだ保存されていません"
        description="株探の原文リンクで確認できます。"
      />
    )
  }

  return (
    <>
      <div className="panel hidden lg:block">
        <div className="table-scroll">
          <table className="w-full min-w-[1080px] border-collapse text-left">
            <thead className="text-[11px] font-bold">
              <tr>
                <th className="w-[88px] border-b border-[var(--color-border-default)] px-3 py-2">コード</th>
                <th className="border-b border-[var(--color-border-default)] px-3 py-2">銘柄名</th>
                <th className="w-[72px] border-b border-[var(--color-border-default)] px-3 py-2">市場</th>
                <th className="w-[96px] border-b border-[var(--color-border-default)] px-3 py-2 text-right">株価</th>
                <th className="w-[132px] border-b border-[var(--color-border-default)] px-3 py-2 text-right">前日比</th>
                <th className="w-[270px] border-b border-[var(--color-border-default)] px-3 py-2">6ステージ</th>
                <th className="w-[128px] border-b border-[var(--color-border-default)] px-3 py-2">短期チェック</th>
                <th className="w-[72px] border-b border-[var(--color-border-default)] px-3 py-2 text-right">PER</th>
                <th className="w-[72px] border-b border-[var(--color-border-default)] px-3 py-2 text-right">PBR</th>
                <th className="w-[72px] border-b border-[var(--color-border-default)] px-3 py-2 text-right">利回り</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {stocks.map((stock) => (
                <tr key={stock.ticker} className="align-top hover:bg-[#fff8e6]">
                  <td className="px-3 py-2">
                    <Link
                      href={`/stock/${encodeURIComponent(stock.ticker)}`}
                      prefetch={false}
                      className="font-mono text-[12px] font-bold text-[var(--color-brand-700)] hover:underline"
                    >
                      {stock.ticker}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-[12px] font-semibold text-[var(--color-text-primary)]">
                    <Link href={`/stock/${encodeURIComponent(stock.ticker)}`} prefetch={false} className="hover:text-[var(--color-brand-700)] hover:underline">
                      {stock.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">{stock.marketText ?? '---'}</td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-[var(--color-text-primary)]">{stock.priceText ?? '---'}</td>
                  <td className={`px-3 py-2 text-right font-mono text-[12px] font-bold ${changeTone(stock.changeText)}`}>
                    {stock.changeText ?? '---'}{stock.changePercentText ? ` / ${stock.changePercentText}` : ''}
                  </td>
                  <td className="px-3 py-2"><StageStrip stock={stock} /></td>
                  <td className="px-3 py-2"><ShortTermCell stock={stock} /></td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-[var(--color-text-secondary)]">{stock.perText ?? '---'}</td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-[var(--color-text-secondary)]">{stock.pbrText ?? '---'}</td>
                  <td className="px-3 py-2 text-right font-mono text-[12px] text-[var(--color-text-secondary)]">{stock.yieldText ?? '---'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="panel m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 lg:hidden" aria-label="関連銘柄">
        {stocks.map((stock) => (
          <li key={stock.ticker} className="px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <Link href={`/stock/${encodeURIComponent(stock.ticker)}`} prefetch={false} className="min-w-0">
                <span className="font-mono text-[13px] font-bold text-[var(--color-brand-700)]">{stock.ticker}</span>
                <span className="ml-2 text-[11px] text-[var(--color-text-tertiary)]">{stock.marketText ?? ''}</span>
                <span className="block truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{stock.name}</span>
              </Link>
              <div className="shrink-0 text-right font-mono tabular-nums">
                <div className="text-[13px] text-[var(--color-text-primary)]">{stock.priceText ?? '---'}</div>
                <div className={`text-[12px] font-bold ${changeTone(stock.changeText)}`}>
                  {stock.changeText ?? '---'}{stock.changePercentText ? ` / ${stock.changePercentText}` : ''}
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
              <StageStrip stock={stock} />
              <ShortTermCell stock={stock} />
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px] tabular-nums">
              {([['PER', stock.perText], ['PBR', stock.pbrText], ['利回り', stock.yieldText]] as const).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[10px] text-[var(--color-text-tertiary)]">{label}</dt>
                  <dd className="m-0 font-mono text-[12px] text-[var(--color-text-primary)]">{value ?? '---'}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}

export default async function ThemeDetailPage({ params }: PageProps) {
  const { themeId: rawThemeId } = await params
  const themeId = decodeThemeId(rawThemeId)
  const theme = await getKabutanTheme(themeId)

  if (!theme) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-4">
        <PageTitle eyebrow="テーマ" title="テーマが見つかりません" subtitle="保存済みのテーマに一致しませんでした。" />
        <EmptyState
          title="テーマデータがありません"
          description="まだ保存されていないか、取得後にURLが変わった可能性があります。"
          action={
            <Link href="/themes" className="btn">
              <ArrowLeft size={13} aria-hidden />
              テーマ一覧へ戻る
            </Link>
          }
        />
      </div>
    )
  }

  const relatedCount = theme.stockCount ?? theme.relatedStocks.length

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="テーマ"
        title={theme.name}
        subtitle={theme.description ?? '概要は未取得です。原文リンクで確認してください。'}
        meta={<>
          <span>人気テーマランキング <strong className="font-semibold text-[var(--color-text-primary)]">{theme.rank ? `${theme.rank}位` : '—'}</strong></span>
          <span>{theme.rankingAsOf ?? '日時未取得'}</span>
          <span>関連 <strong className="font-semibold text-[var(--color-text-primary)]">{relatedCount ? `${relatedCount}銘柄` : '未取得'}</strong></span>
        </>}
        rightSlot={<>
          <Link href="/themes" className="btn">
            <ArrowLeft size={13} aria-hidden />
            一覧へ
          </Link>
          <a href={theme.url} target="_blank" rel="noopener noreferrer" className="btn">
            株探で開く
            <ExternalLink size={13} aria-hidden />
          </a>
        </>}
      />

      <section className="min-w-0" aria-labelledby="theme-related">
        <SectionHeader
          id="theme-related"
          title="関連銘柄"
          description="株価・前日比・6ステージ・短期チェック・バリュエーション"
          actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{theme.relatedStocks.length}件</span>}
        />
        <RelatedStockTable stocks={theme.relatedStocks} />
      </section>
    </div>
  )
}
