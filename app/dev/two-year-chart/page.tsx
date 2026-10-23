import { notFound } from 'next/navigation'
import { TwoYearChartFixtureClient } from './TwoYearChartFixtureClient'

export const dynamic = 'force-dynamic'

export default function TwoYearChartFixturePage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <TwoYearChartFixtureClient />
}
