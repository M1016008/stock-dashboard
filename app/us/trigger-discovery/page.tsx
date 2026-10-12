import type { Metadata } from 'next'
import Link from 'next/link'
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { UsAnalysisNav } from '@/components/us/UsAnalysisNav'
import { fmtCount } from '@/components/us/UsMarketMomentumParts'
import { getUsTriggerDiscoveryOptions } from '@/lib/server/us-trigger-discovery'
import type { UsTriggerDiscoveryOptionsResponse } from '@/lib/us-trigger-discovery-contract'
import { UsTriggerDiscoveryClient } from './UsTriggerDiscoveryClient'

export const metadata: Metadata = {
  title: 'US条件トリガー — StockBoard',
  description: '上向きの月足・2週足移動平均へ上から近づく米国株を探し、ミニチャートと6ステージで比較します。',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function Header({ options }: { options: UsTriggerDiscoveryOptionsResponse | null }) {
  return (
    <PageTitle
      eyebrow="米国株"
      title="US条件トリガー"
      subtitle="上向きの移動平均 2 本でできる価格帯へ、上から近づいている米国株を探します。ミニチャートで形を確かめ、6ステージと流動性で絞り込みます。"
      meta={options?.latestAsOf ? (
        <>
          <span>最新データ <strong className="font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">{options.latestAsOf}</strong> 終値（米国時間）</span>
          <span>現在上場の普通株 <strong className="font-semibold tabular-nums text-[var(--color-text-primary)]">{fmtCount(options.activeCount)}</strong> 銘柄（株価・流動性・履歴の条件で絞り込み）</span>
        </>
      ) : undefined}
    >
      <UsAnalysisNav current="/us/trigger-discovery" />
    </PageTitle>
  )
}

export default async function UsTriggerDiscoveryPage() {
  let options: UsTriggerDiscoveryOptionsResponse | null = null
  try {
    options = await getUsTriggerDiscoveryOptions()
  } catch (error) {
    console.error('[us/trigger-discovery] failed to load options', error)
  }

  if (!options) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header options={null} />
        <Notice
          tone="error"
          role="alert"
          title="US条件トリガーを準備できませんでした"
          action={<Link href="/us/trigger-discovery" prefetch={false} className="btn" data-size="sm">再読み込み</Link>}
        >
          米国株データの最新日と取引所の一覧を取得できませんでした。時間をおいて再読み込みしてください。
        </Notice>
      </div>
    )
  }

  if (!options.latestAsOf) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-5">
        <Header options={options} />
        <EmptyState
          title="米国株の価格データがまだありません"
          description="US の日足データが取り込まれると、条件トリガーを検索できます。"
        />
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Header options={options} />
      <UsTriggerDiscoveryClient options={options} />
    </div>
  )
}
