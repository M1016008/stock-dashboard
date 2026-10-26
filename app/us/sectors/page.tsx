import type { Metadata } from 'next'
import Link from 'next/link'
import { Gauge, ListFilter } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { ViewTabs } from '@/components/ui/ViewTabs'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import {
  UNKNOWN_SECTOR_CODE,
  UsSecSicDisclosure,
  fmtCount,
  fmtPct,
  fmtRatio,
  fmtScore,
  firstParam,
  parseUsDateParam,
  secSectorShort,
  signedClass,
  usScreenerHref,
} from '@/components/us/UsMarketMomentumParts'
import { UsSectorMap } from '@/components/us/UsSectorMap'
import { UsSectorRankingTable, type UsGroupRowView } from '@/components/us/UsSectorRankingTable'
import { UsSectorPitUnavailable } from '@/components/us/UsSectorPitUnavailable'
import {
  US_SECTOR_METRICS,
  US_SECTOR_METRIC_ORDER,
  US_SECTOR_SMALL_SAMPLE,
  buildUsIndustryParents,
  displaySicName,
  parseUsSectorMetric,
  sortUsGroups,
  usIndustryScreenerHref,
  usSectorScreenerHref,
  usSectorsHref,
  type UsIndustryParent,
  type UsSectorMetric,
} from '@/components/us/UsSectorShared'
import { sicMajorGroupFromCode } from '@/lib/us-classification'
import {
  loadUsMarketIntelligence,
  type UsMarketGroup,
  type UsMarketIntelligence,
} from '@/lib/server/us-market-intelligence'

const INDUSTRY_PAGE_SIZE = 50

function parsePositivePage(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 1
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function IndustryPagination({
  page,
  totalPages,
  total,
  metric,
  sector,
  sample,
}: {
  page: number
  totalPages: number
  total: number
  metric: UsSectorMetric
  sector: string | null
  sample: 'ranked' | 'small'
}) {
  if (totalPages <= 1) return null
  const start = (page - 1) * INDUSTRY_PAGE_SIZE + 1
  const end = Math.min(total, page * INDUSTRY_PAGE_SIZE)
  const href = (target: number) => usSectorsHref({
    metric,
    sector,
    sample: sample === 'small' ? 'small' : null,
    industryPage: target,
  }, '#us-industries')
  return (
    <nav aria-label="SIC industry ページ" className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-2">
      <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
        {fmtCount(total)}件中 {fmtCount(start)}–{fmtCount(end)}件 · {page}/{totalPages}ページ
      </span>
      <span className="flex items-center gap-1.5">
        {page > 1 ? <Link href={href(page - 1)} prefetch={false} className="btn" data-size="sm">前へ</Link> : <span className="btn pointer-events-none opacity-40" data-size="sm" aria-disabled="true">前へ</span>}
        {page < totalPages ? <Link href={href(page + 1)} prefetch={false} className="btn" data-size="sm">次へ</Link> : <span className="btn pointer-events-none opacity-40" data-size="sm" aria-disabled="true">次へ</span>}
      </span>
    </nav>
  )
}

export const metadata: Metadata = {
  title: 'USセクター — StockBoard',
  description: 'SEC SIC industryとStockBoard SIC divisionによる米国株の強弱を比較',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function Header({ data }: { data: UsMarketIntelligence | null }) {
  return (
    <PageTitle
      eyebrow="米国株"
      title="USセクター分析"
      subtitle="SEC SIC industryをStockBoard独自の区分に集約し、1D/1W/1M・PMS/PFS/PES・広がりで比較します。SEC公式Sectorでも GICS ではありません。"
      badge={data?.date ? (data.isLatest ? 'SIC区分・最新日のみ' : '過去日は集計外') : undefined}
      badgeTone={data?.date && !data.isLatest ? 'warning' : 'brand'}
      meta={data?.date ? (
        <>
          <span>基準日 <strong className="font-semibold text-[var(--color-text-primary)]">{data.date}</strong> 終値（米国時間）</span>
          {data.isLatest && (
            <span>分類済み <strong className="font-semibold text-[var(--color-text-primary)]">{fmtCount(data.coverage.classifiedRows)}</strong> / {fmtCount(data.coverage.momentumRows)}銘柄</span>
          )}
        </>
      ) : undefined}
      rightSlot={(
        <>
          <Link href={usScreenerHref({ sort: 'pms', dir: 'desc' })} prefetch={false} className="btn" data-variant="primary">
            <ListFilter size={14} aria-hidden />
            スクリーナー
          </Link>
          <Link href="/us/market-momentum" prefetch={false} className="btn">
            <Gauge size={14} aria-hidden />
            市場モメンタム
          </Link>
        </>
      )}
    >
      <UsAnalysisNav current="/us/sectors" />
    </PageTitle>
  )
}

function sectorRow(group: UsMarketGroup, metric: UsSectorMetric): UsGroupRowView {
  const unknown = group.key === UNKNOWN_SECTOR_CODE
  return {
    group,
    title: secSectorShort(group.key, group.label),
    subtitle: unknown ? 'SEC 登録に SIC コードがない銘柄（SIC industry なし）' : group.label,
    drillHref: unknown ? null : usSectorsHref({ metric, sector: group.key }, '#us-industries'),
    drillLabel: `${group.label} の SIC industry を見る`,
    screenerHref: usSectorScreenerHref(group.label),
    muted: unknown,
  }
}

function industryRow(group: UsMarketGroup, parent: UsIndustryParent | undefined): UsGroupRowView {
  const major = sicMajorGroupFromCode(group.key)
  return {
    group,
    title: displaySicName(group.label),
    rawTitle: group.label,
    subtitle: `SIC ${group.key}${major ? ` · 業種グループ ${major.code} ${major.name}` : ''}`,
    parent: parent ? secSectorShort(parent.sectorCode, parent.sectorLabel) : null,
    screenerHref: usIndustryScreenerHref(group, parent),
  }
}

export default async function UsSectorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    date?: string | string[]
    metric?: string | string[]
    sector?: string | string[]
    sample?: string | string[]
    industryPage?: string | string[]
  }>
}) {
  const sp = await searchParams
  const dateParam = parseUsDateParam(sp.date)
  const metric = parseUsSectorMetric(firstParam(sp.metric))

  if (dateParam.kind === 'invalid') {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header data={null} />
        <Notice
          tone="error"
          title="指定した日付を読み取れません"
          action={<Link href="/us/sectors" prefetch={false} className="btn" data-size="sm">最新日を表示</Link>}
        >
          日付は YYYY-MM-DD 形式で 1 つだけ指定してください。なお SEC SIC 分類は最新日のみ集計します。
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
    console.error('[us/sectors] failed to load US market intelligence', error)
    loadFailed = true
  }

  if (loadFailed || !data) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header data={null} />
        <Notice
          tone="error"
          role="alert"
          title="米国株セクターを読み込めませんでした"
          action={<Link href={`/us/sectors${requestedDate ? `?date=${requestedDate}` : ''}`} prefetch={false} className="btn" data-size="sm">再読み込み</Link>}
        >
          US analytics データベースへの接続に失敗しました。時間をおいて再読み込みしてください。
        </Notice>
      </div>
    )
  }

  if (!data.date) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header data={data} />
        <EmptyState
          title={requestedDate ? `${requestedDate} 以前の米国株データがありません` : '米国株のセクター集計に使うデータがまだありません'}
          description="PMS 算出済みの米国市場データが生成されると表示されます。"
          action={requestedDate ? <Link href="/us/sectors" prefetch={false} className="btn" data-size="sm">最新日を表示</Link> : undefined}
        />
      </div>
    )
  }

  // 過去日: 現在の SEC SIC を当時の分類として使わない (fail-closed)
  if (data.classificationAvailability !== 'CURRENT') {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header data={data} />
        <UsSectorPitUnavailable requestedDate={requestedDate} resolvedDate={data.date} latestDate={data.latestDate} />
      </div>
    )
  }

  const intel = data
  // SIC 不明は業種として読まないため、market map・絞り込みから外し、ランキング表の末尾に分けて出す
  const unknownGroup = intel.sectors.find((group) => group.key === UNKNOWN_SECTOR_CODE)
  const sectors = sortUsGroups(intel.sectors.filter((group) => group.key !== UNKNOWN_SECTOR_CODE), metric)
  const rawSector = firstParam(sp.sector)
  const selectedGroup = rawSector ? sectors.find((group) => group.key === rawSector) ?? null : null
  const selected = selectedGroup?.key ?? null
  const parents = buildUsIndustryParents(intel.rows)
  const industries = sortUsGroups(intel.industries, metric)
    .filter((group) => !selected || parents.get(group.key)?.sectorCode === selected)
  const rankedIndustries = industries.filter((group) => group.count >= US_SECTOR_SMALL_SAMPLE)
  const smallIndustries = industries.filter((group) => group.count < US_SECTOR_SMALL_SAMPLE)
  const sampleMode = firstParam(sp.sample) === 'small' ? 'small' : 'ranked'
  const visibleIndustries = sampleMode === 'small' ? smallIndustries : rankedIndustries
  const requestedIndustryPage = parsePositivePage(firstParam(sp.industryPage))
  const industryTotalPages = Math.max(1, Math.ceil(visibleIndustries.length / INDUSTRY_PAGE_SIZE))
  const industryPage = Math.min(requestedIndustryPage, industryTotalPages)
  const pagedIndustries = visibleIndustries.slice(
    (industryPage - 1) * INDUSTRY_PAGE_SIZE,
    industryPage * INDUSTRY_PAGE_SIZE,
  )
  const unclassified = intel.coverage.momentumRows - intel.coverage.classifiedRows
  const namedSectorCount = sectors.length
  const metricMeta = US_SECTOR_METRICS[metric]
  const adjustedLatest = requestedDate != null && requestedDate !== intel.date

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Header data={intel} />

      {adjustedLatest && (
        <Notice tone="info">
          指定日 <span className="font-mono tabular-nums">{requestedDate}</span> のデータはないため、直近の取引日 <span className="font-mono tabular-nums">{intel.date}</span>（最新日）で集計しています。
        </Notice>
      )}

      <section aria-label="分類のカバレッジ" className="flex min-w-0 flex-col gap-2">
        <StatStrip
          label="SEC SIC 分類のカバレッジ"
          className="stat-strip-wrap-compact"
          items={[
            { label: 'SEC SIC 分類済み', value: fmtRatio(intel.coverage.classificationPct), sub: `${fmtCount(intel.coverage.classifiedRows)} / ${fmtCount(intel.coverage.momentumRows)}銘柄` },
            { label: '未分類（SEC と未照合）', value: fmtCount(unclassified), sub: 'セクター集計の対象外', tone: unclassified > 0 ? 'muted' : undefined },
            { label: 'SIC 不明（登録に SIC なし）', value: fmtCount(unknownGroup?.count ?? 0), sub: 'map から外し、ランキング末尾に別枠', tone: 'muted' },
            { label: 'Broad sector / SIC industry', value: `${fmtCount(namedSectorCount)} / ${fmtCount(intel.industries.length)}`, sub: `SIC industry のうち ${US_SECTOR_SMALL_SAMPLE}銘柄以上 ${fmtCount(intel.industries.filter((g) => g.count >= US_SECTOR_SMALL_SAMPLE).length)}` },
            { label: '市場平均 PMS（比較の基準）', value: <span className={signedClass(intel.summary.avgPms)}>{fmtScore(intel.summary.avgPms)}</span>, sub: <>PFS <span className={signedClass(intel.summary.avgPfs)}>{fmtScore(intel.summary.avgPfs)}</span> · PES <span className={signedClass(intel.summary.avgPes)}>{fmtScore(intel.summary.avgPes)}</span></> },
          ]}
        />
        <UsSecSicDisclosure />
      </section>

      <ViewTabs
        label="比較指標"
        current={metric}
        items={US_SECTOR_METRIC_ORDER.map((key) => ({
          key,
          label: US_SECTOR_METRICS[key].label,
          href: usSectorsHref({ metric: key, sector: selected }, '#us-sector-map'),
        }))}
      />

      <section id="us-sector-map" aria-labelledby="us-sector-map-title" className="flex min-w-0 scroll-mt-36 flex-col gap-3">
        <SectionHeader
          id="us-sector-map-title"
          level={1}
          title="StockBoard SIC division market map"
          description={`${metricMeta.label}の高い順。色は${metric === 'breadth' ? '50%基準の' : metric === 'stage1' ? '比率の' : '符号と'}強さ、右上は銘柄数。選ぶと下の業種を絞り込みます。`}
        />
        {sectors.length === 0 ? (
          <EmptyState title="SEC SIC 分類のある銘柄がありません" description="SEC 分類の取り込み後に表示されます。" />
        ) : (
          <UsSectorMap groups={sectors} metric={metric} selected={selected} />
        )}
      </section>

      <section id="us-sector-ranking" aria-labelledby="us-sector-ranking-title" className="flex min-w-0 scroll-mt-36 flex-col gap-3">
        <SectionHeader
          id="us-sector-ranking-title"
          title="Sector ranking"
          description="列見出しで並べ替え。平均は単純平均、PMS+比率は PMS > 0 の割合、日A S1 は日足A が Stage 1 の割合です。"
        />
        <UsSectorRankingTable
          rows={[...sectors, ...(unknownGroup ? [unknownGroup] : [])].map((group) => sectorRow(group, metric))}
          metric={metric}
          hrefFor={(key) => usSectorsHref({ metric: key, sector: selected }, '#us-sector-ranking')}
          firstLabel="StockBoard SIC division"
          emptyLabel="SEC SIC 分類のある銘柄がありません"
          ariaLabel="StockBoard SIC division ランキング"
        />
      </section>

      <section id="us-industries" aria-labelledby="us-industries-title" className="flex min-w-0 scroll-mt-36 flex-col gap-3">
        <SectionHeader
          id="us-industries-title"
          level={1}
          title={selectedGroup ? `${secSectorShort(selectedGroup.key, selectedGroup.label)} の SIC industry` : 'SIC industry ranking'}
          description={`4桁 SIC（スクリーナーの「詳細産業」）ごとの集計。${US_SECTOR_SMALL_SAMPLE}銘柄未満は少数サンプルとして分離し、50件ずつ表示します。`}
          actions={selectedGroup ? (
            <Link href={usSectorScreenerHref(selectedGroup.label)} prefetch={false} className="btn" data-size="sm">
              <ListFilter size={13} aria-hidden />
              このセクターをスクリーナーで
            </Link>
          ) : undefined}
        />
        <ViewTabs
          label="SIC industry を絞り込むセクター"
          current={selected ?? 'all'}
          items={[
            { key: 'all', label: '全セクター', href: usSectorsHref({ metric }, '#us-industries') },
            ...sectors.map((group) => ({
              key: group.key,
              label: secSectorShort(group.key, group.label),
              href: usSectorsHref({ metric, sector: group.key }, '#us-industries'),
            })),
          ]}
        />
        <ViewTabs
          label="サンプル区分"
          current={sampleMode}
          items={[
            { key: 'ranked', label: `${US_SECTOR_SMALL_SAMPLE}銘柄以上 (${fmtCount(rankedIndustries.length)})`, href: usSectorsHref({ metric, sector: selected }, '#us-industries') },
            { key: 'small', label: `少数サンプル (${fmtCount(smallIndustries.length)})`, href: usSectorsHref({ metric, sector: selected, sample: 'small' }, '#us-industries') },
          ]}
        />
        {selectedGroup && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums text-[var(--color-text-secondary)]">
            <span>{selectedGroup.label}</span>
            <span>{fmtCount(selectedGroup.count)}銘柄</span>
            <span>1D <span className={signedClass(selectedGroup.avgChangePct)}>{fmtPct(selectedGroup.avgChangePct)}</span></span>
            <span>PMS <span className={signedClass(selectedGroup.avgPms)}>{fmtScore(selectedGroup.avgPms)}</span></span>
            <span>PMS+ {fmtRatio(selectedGroup.positivePmsPct)}</span>
            <span>SIC industry {fmtCount(industries.length)}</span>
          </p>
        )}
        <UsSectorRankingTable
          rows={pagedIndustries.map((group) => industryRow(group, parents.get(group.key)))}
          metric={metric}
          hrefFor={(key) => usSectorsHref({ metric: key, sector: selected, sample: sampleMode === 'small' ? 'small' : null }, '#us-industries')}
          firstLabel={sampleMode === 'small' ? 'SIC industry（少数サンプル）' : 'SIC industry'}
          showParent={!selected}
          parentLabel="SEC sector"
          emptyLabel={sampleMode === 'small' ? '少数サンプルの SIC industry はありません' : `${US_SECTOR_SMALL_SAMPLE}銘柄以上の SIC industry がありません`}
          ariaLabel={sampleMode === 'small' ? '少数サンプルの SIC industry ランキング' : 'SIC industry ランキング'}
        />
        <IndustryPagination
          page={industryPage}
          totalPages={industryTotalPages}
          total={visibleIndustries.length}
          metric={metric}
          sector={selected}
          sample={sampleMode}
        />
        <p className="text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
          「銘柄」はスクリーナーをセクター → 業種グループ（SIC 上2桁）→ 詳細産業の条件で開きます。スクリーナーは品質フィルター後の母集団のため、件数が一致しない場合があります。
        </p>
      </section>
    </div>
  )
}
