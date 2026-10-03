import { execAll } from '@/lib/db/client'

export interface EarningsDateCount {
  date: string
  count: number
}

export async function getEarningsDateCounts(): Promise<EarningsDateCount[]> {
  return execAll<EarningsDateCount>(
    `
      SELECT announce_date AS date, COUNT(*) AS count
      FROM earnings_calendar
      WHERE announce_date IS NOT NULL AND announce_date <> ''
      GROUP BY announce_date
      ORDER BY announce_date ASC
    `,
  )
}
