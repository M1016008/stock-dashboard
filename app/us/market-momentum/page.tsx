import type { Metadata } from 'next'
import Link from 'next/link'
import { Layers, ListFilter } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { ViewTabs } from '@/components/ui/ViewTabs'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import {
  UsAsOfBanner,
  UsDateForm,
  UsSecSicDisclosure,
  fmtCount,
  firstParam,
  parseUsDateParam,
  usScreenerHref,
} from '@/components/us/UsMarketMomentumParts'
import {
  UsMarketMomentumBreadth,
  UsMarketMomentumContextUnavailable,
  UsMarketMomentumExchangeContext,
  UsMarketMomentumSectorContext,
  UsMarketMomentumStats,
} from '@/components/us/UsMarketMomentumPulse'
import {
  US_LANE_META,
  US_LANE_ORDER,
  UsMarketMomentumLanePanel,
  usLaneHref,
} from '@/components/us/UsMarketMomentumLanes'
import { UsMarketMomentumTable } from '@/components/us/UsMarketMomentumTable'
import {
  loadUsMarketIntelligence,
  rankUsMomentumRows,
  type UsMarketIntelligence,
  type UsMomentumLane,
} from '@/lib/server/us-market-intelligence'

export const metadata: Metadata = {
  title: 'USマーケットモメンタム — StockBoard',
  description: '米国株の PMS/PFS/PES の広がりと、動き出し・継続・失速・下落警戒の銘柄を確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const TABLE_LIMIT = 100

function parseLane(value: string | null): UsMomentumLane {
  return value === 'continuation' || value === 'stall' || value === 'drop' ? value : 'initial'
}

function Header({
  data,
  linkDate,
  historical,
}: {
  data: UsMarketIntelligence | null
  linkDate: string | null
  historical: boolean
}) {
  return (
    <PageTitle
      eyebrow="米国株"
      title="USマーケットモメンタム"
      subtitle="市場全体の PMS/PFS/PES の広がりから、Exchange・SEC sector の偏り、4つのレーンの個別銘柄へ絞り込みます。"
      badge={data?.date ? (historical ? '過去日表示' : '最新データ') : undefined}
      badgeTone={historical ? 'warning' : 'positive'}
      meta={data?.date ? (
        <>
          <span>基準日 <strong className="font-semibold text-[var(--color-text-primary)]">{data.date}</strong> 終値（米国時間）</span>
          <span>対象 <strong className="font-semibold text-[var(--color-text-primary)]">{fmtCount(data.summary.count)}</strong>銘柄（PMS算出済み）</span>
        </>
      ) : undefined}
      rightSlot={(
        <>
          <Link href={usScreenerHref({ sort: 'pms', dir: 'desc' }, linkDate)} prefetch={false} className="btn" data-variant="primary">
            <ListFilter size={14} aria-hidden />
            スクリーナーで全件比較
          </Link>
          <Link href="/us/sectors" prefetch={false} className="btn">
            <Layers size={14} aria-hidden />
            {historical ? '最新日のセクター' : 'セクター分析'}
          </Link>
        </>
      )}
    >
      <UsAnalysisNav current="/us/market-momentum" />
    </PageTitle>
  )
}

export default async function UsMarketMomentumPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[]; lane?: string | string[] }>
}) {
  const sp = await searchParams
  const dateParam = parseUsDateParam(sp.date)
  const lane = parseLane(firstParam(sp.lane))

  if (dateParam.kind === 'invalid') {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header data={null} linkDate={null} historical={false} />
        <Notice
          tone="error"
          title="指定した日付を読み取れません"
          action={<Link href="/us/market-momentum" prefetch={false} className="btn" data-size="sm">最新日を表示</Link>}
        >
          日付は YYYY-MM-DD 形式（例: 2026-10-09）で 1 つだけ指定してください。別の日付のデータを代わりに表示することはしません。
        </Notice>
      </div>
    )
  }

  const requestedDate = dateParam.kind === 'valid' ? dateParam.date : null
  let data: UsMarketIntelligence | null = null
  let loadFailed = false
  try {
    data = await loadUsMarketIntelligence(requestedDate)
  } catch (error) {
    console.error('[us/market-momentum] failed to load US market intelligence', error)
    loadFailed = true
  }

  if (loadFailed || !data) {
    const retryHref = `/us/market-momentum${requestedDate ? `?date=${requestedDate}` : ''}`
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header data={null} linkDate={null} historical={false} />
        <Notice
          tone="error"
          role="alert"
          title="米国株モメンタムを読み込めませんでした"
          action={<Link href={retryHref} prefetch={false} className="btn" data-size="sm">再読み込み</Link>}
        >
          US analytics データベースへの接続に失敗しました。時間をおいて再読み込みしてください。
        </Notice>
      </div>
    )
  }

  if (!data.date) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header data={data} linkDate={null} historical={false} />
        <EmptyState
          title={requestedDate ? `${requestedDate} 以前の PMS データがありません` : '米国株の PMS データがまだありません'}
          description={requestedDate
            ? 'より新しい日付を指定するか、最新日を表示してください。'
            : 'US の physical momentum 指標が生成されると表示されます。'}
          action={requestedDate ? <Link href="/us/market-momentum" prefetch={false} className="btn" data-size="sm">最新日を表示</Link> : undefined}
        />
      </div>
    )
  }

  const intel = data
  const historical = !intel.isLatest
  const linkDate = historical ? data.date : null
  const showClassification = intel.classificationAvailability === 'CURRENT'
  const ranked = Object.fromEntries(
    US_LANE_ORDER.map((key) => [key, rankUsMomentumRows(intel.rows, key)]),
  ) as Record<UsMomentumLane, ReturnType<typeof rankUsMomentumRows>>
  const laneMeta = US_LANE_META[lane]
  const tableRows = ranked[lane].slice(0, TABLE_LIMIT)
  const adjustedLatest = !historical && requestedDate != null && requestedDate !== data.date

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Header data={data} linkDate={linkDate} historical={historical} />

      <UsDateForm
        action="/us/market-momentum"
        date={requestedDate ?? data.date}
        latestDate={data.latestDate}
        isLatest={!historical}
        hidden={{ lane: lane === 'initial' ? null : lane }}
      />

      {historical && (
        <UsAsOfBanner
          requestedDate={requestedDate}
          resolvedDate={data.date}
          latestDate={data.latestDate}
          shown={['騰落・1D/1W/1M', 'PMS/PFS/PES', '6ステージ', '4レーン']}
          hidden={['Exchange', 'SEC SIC sector / industry']}
          note={<>株価・PMS/PFS/PES・6ステージは {data.date}（米国時間）終値時点の値です。銘柄名は現在の登録名です。過去日は現在の銘柄マスタ（取引所・資産種別）で対象を絞らないため、対象数が最新日と異なる場合があります。</>}
        />
      )}
      {adjustedLatest && (
        <Notice tone="info">
          指定日 <span className="font-mono tabular-nums">{requestedDate}</span> のデータはないため、直近の取引日 <span className="font-mono tabular-nums">{data.date}</span>（最新日）で表示しています。
        </Notice>
      )}

      <section aria-labelledby="us-mm-pulse" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-mm-pulse"
          level={1}
          title="Market pulse"
          description="PMS = 勢い、PFS = 動き出しの力、PES = 値動きの熱量。売買判断ではなく、次に確認する銘柄を絞るための集計です。"
        />
        <UsMarketMomentumStats data={data} />
        <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 lg:col-span-2 2xl:col-span-1">
            <UsMarketMomentumBreadth data={data} />
          </div>
          {showClassification ? (
            <>
              <UsMarketMomentumExchangeContext groups={data.exchanges} />
              <UsMarketMomentumSectorContext groups={data.sectors} />
            </>
          ) : (
            <UsMarketMomentumContextUnavailable date={data.date} />
          )}
        </div>
        {showClassification && <UsSecSicDisclosure />}
      </section>

      <section aria-labelledby="us-mm-lanes" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="us-mm-lanes"
          level={1}
          title="4つのレーン"
          description="各レーン上位12銘柄。レーンの条件と並び順は見出しの下に表示しています。"
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-4">
          {US_LANE_ORDER.map((key) => (
            <UsMarketMomentumLanePanel
              key={key}
              lane={key}
              rows={intel.lanes[key]}
              total={ranked[key].length}
              linkDate={linkDate}
              showClassification={showClassification}
            />
          ))}
        </div>
      </section>

      <section id="us-lane-table" aria-labelledby="us-mm-table" className="flex min-w-0 scroll-mt-36 flex-col gap-3">
        <SectionHeader
          id="us-mm-table"
          level={1}
          title={`${laneMeta.label}の比較表`}
          description={`${laneMeta.description} · ${laneMeta.rule}`}
          actions={(
            <>
              <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
                上位 {fmtCount(tableRows.length)} / 該当 {fmtCount(ranked[lane].length)}銘柄
              </span>
              <Link href={usScreenerHref(laneMeta.screener, linkDate)} prefetch={false} className="btn" data-size="sm" title={`スクリーナー: ${laneMeta.screenerLabel}`}>
                <ListFilter size={13} aria-hidden />
                全件をスクリーナーで
              </Link>
            </>
          )}
        />
        <ViewTabs
          label="比較するレーン"
          current={lane}
          items={US_LANE_ORDER.map((key) => ({
            key,
            label: US_LANE_META[key].label,
            href: usLaneHref(key, linkDate),
            count: ranked[key].length,
          }))}
        />
        <UsMarketMomentumTable
          rows={tableRows}
          linkDate={linkDate}
          showClassification={showClassification}
          emptyLabel="条件を満たす銘柄はありません"
        />
        <p className="text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
          価格は USD 終値、1D/1W/1M は終値ベースの騰落率、出来高は株数です。スクリーナーは品質フィルター後の母集団で、しきい値は「以上」のためレーン条件と件数が一致しない場合があります。
        </p>
      </section>
    </div>
  )
}
