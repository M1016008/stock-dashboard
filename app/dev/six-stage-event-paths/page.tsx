import type { Metadata } from 'next'
import { SixStageRealEventPathLab } from '@/components/research/SixStageRealEventPathLab'

export const metadata: Metadata = {
  title: '6-Stage Event Path Lab | StockBoard',
  robots: { index: false, follow: false },
}

export default function SixStageEventPathLabPage() {
  return <SixStageRealEventPathLab />
}
