import type { Metadata } from 'next'
import { getTriggerDiscoveryOptions } from '@/lib/server/trigger-discovery-options'
import { TriggerDiscoveryClient } from './TriggerDiscoveryClient'

export const metadata: Metadata = {
  title: '条件トリガー | StockBoard',
  description: '月足・2週足移動平均への接近を日本株全体から探索し、6軸Stageと比較します。',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function TriggerDiscoveryPage() {
  const options = await getTriggerDiscoveryOptions()
  return <TriggerDiscoveryClient options={options} />
}
