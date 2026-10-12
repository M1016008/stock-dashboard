import { PageLoadingSkeleton } from '@/components/ui/PageLoadingSkeleton'

export default function Loading() {
  return <PageLoadingSkeleton title="米国株セクターを読み込んでいます" sections={3} />
}
