import { PageLoadingSkeleton } from '@/components/ui/PageLoadingSkeleton'

export default function Loading() {
  return <PageLoadingSkeleton title="US条件トリガーを読み込んでいます" sections={2} />
}
