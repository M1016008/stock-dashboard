import { PageLoadingSkeleton } from '@/components/ui/PageLoadingSkeleton'

export default function Loading() {
  return <PageLoadingSkeleton title="ダッシュボードを読み込んでいます" sections={4} />
}
