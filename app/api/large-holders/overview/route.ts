import { errorResponse, getRankingSnapshot, responseMeta } from '@/lib/server/large-holders/ranking-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const snapshot = await getRankingSnapshot()
    const investors = snapshot.investors
    const facets = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'ja'))
    const positions = investors.flatMap((investor) => investor.positions)
    return Response.json({
      investorCount: investors.length,
      investorClassCounts: Object.fromEntries(['INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED']
        .map((name) => [name, investors.filter((investor) => investor.investorClass === name).length])),
      completenessCounts: Object.fromEntries(['COMPLETE', 'PARTIAL', 'NONE']
        .map((name) => [name, investors.filter((investor) => investor.portfolioCompleteness === name).length])),
      activityCounts: Object.fromEntries(['NEW_5PCT', 'INCREASE', 'DECREASE', 'EXIT_5PCT']
        .map((name) => [name, snapshot.activities.filter((event) => event.eventType === name).length])),
      markets: facets(positions.map((position) => position.market)),
      industries17: facets(positions.map((position) => position.industry17)),
      industries33: facets(positions.map((position) => position.industry33)),
      ...responseMeta(snapshot),
    })
  } catch (error) { return errorResponse(error) }
}
