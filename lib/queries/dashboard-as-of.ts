import { cache } from 'react'
import { execGet } from '@/lib/db/client'

export type DashboardAsOfAvailability = 'available' | 'before_coverage' | 'invalid' | 'no_data'
export type DashboardAsOfMode = 'latest' | 'historical' | 'unavailable'

export interface DashboardAsOfState {
  requestedDate: string | null
  resolvedDate: string | null
  earliestDate: string | null
  latestDate: string | null
  availability: DashboardAsOfAvailability
  mode: DashboardAsOfMode
  adjustedToPriorSession: boolean
}

type DashboardCoverageRow = {
  earliestDate: string | null
  latestDate: string | null
  resolvedDate: string | null
}

export function isValidDashboardDate(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

export function buildDashboardAsOfState(
  requestedDate: string | null,
  coverage: DashboardCoverageRow,
): DashboardAsOfState {
  const { earliestDate, latestDate, resolvedDate } = coverage

  if (requestedDate && !isValidDashboardDate(requestedDate)) {
    return {
      requestedDate,
      resolvedDate: null,
      earliestDate,
      latestDate,
      availability: 'invalid',
      mode: 'unavailable',
      adjustedToPriorSession: false,
    }
  }

  if (!latestDate || !earliestDate) {
    return {
      requestedDate,
      resolvedDate: null,
      earliestDate,
      latestDate,
      availability: 'no_data',
      mode: 'unavailable',
      adjustedToPriorSession: false,
    }
  }

  if (requestedDate && !resolvedDate) {
    return {
      requestedDate,
      resolvedDate: null,
      earliestDate,
      latestDate,
      availability: 'before_coverage',
      mode: 'unavailable',
      adjustedToPriorSession: false,
    }
  }

  const effectiveDate = requestedDate ? resolvedDate : latestDate
  const mode: DashboardAsOfMode = requestedDate && requestedDate !== latestDate ? 'historical' : 'latest'
  return {
    requestedDate,
    resolvedDate: effectiveDate,
    earliestDate,
    latestDate,
    availability: 'available',
    mode,
    adjustedToPriorSession: Boolean(requestedDate && effectiveDate && requestedDate !== effectiveDate),
  }
}

const readDashboardAsOf = cache(async (requestedDate: string | null): Promise<DashboardAsOfState> => {
  if (requestedDate && !isValidDashboardDate(requestedDate)) {
    const coverage = await execGet<DashboardCoverageRow>(
      `SELECT MIN(date) AS earliestDate, MAX(date) AS latestDate, NULL AS resolvedDate FROM daily_snapshots`,
    )
    return buildDashboardAsOfState(requestedDate, coverage ?? {
      earliestDate: null,
      latestDate: null,
      resolvedDate: null,
    })
  }

  const coverage = await execGet<DashboardCoverageRow>(
    `
      SELECT
        (SELECT MIN(date) FROM daily_snapshots) AS earliestDate,
        (SELECT MAX(date) FROM daily_snapshots) AS latestDate,
        CASE
          WHEN ? IS NULL THEN (SELECT MAX(date) FROM daily_snapshots)
          ELSE (SELECT MAX(date) FROM daily_snapshots WHERE date <= ?)
        END AS resolvedDate
    `,
    [requestedDate, requestedDate],
  )
  return buildDashboardAsOfState(requestedDate, coverage ?? {
    earliestDate: null,
    latestDate: null,
    resolvedDate: null,
  })
})

export async function getDashboardAsOfState(requestedDate?: string | null): Promise<DashboardAsOfState> {
  return readDashboardAsOf(requestedDate ?? null)
}
