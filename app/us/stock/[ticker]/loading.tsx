import { PageLoadingSkeleton } from '@/components/ui/PageLoadingSkeleton'

export default function Loading() {
  return <PageLoadingSkeleton title="米国株の個別銘柄を読み込んでいます" sections={4} />
}
