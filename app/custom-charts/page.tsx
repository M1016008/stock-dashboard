import { PageTitle } from '@/components/layout/PageTitle'
import { CustomChartsClient } from './CustomChartsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function CustomChartsPage() {
  return (
    <main className="mx-auto w-full max-w-[1480px] space-y-4 px-5 py-5 sm:px-8 lg:px-10 xl:px-12">
      <PageTitle
        title="合成チャート"
        subtitle="複数銘柄のOHLCVを数式で合成し、独自のライン/ロウソク足チャートとして表示します。"
        badge="Synthetic OHLC"
      />
      <CustomChartsClient />
    </main>
  )
}
