import path from 'node:path'
import { localDbPath } from '@/lib/db/client'
import { resolveUsAnalyticsDbPath } from '@/lib/db/us-analytics'
import type { MaTrajectoryMarket } from '@/lib/ma-trajectory/core'

export function resolveMaTrajectorySourceDbPath(market: MaTrajectoryMarket): string {
  if (market === 'US') {
    return path.resolve(process.env.US_ANALYTICS_DB_PATH?.trim() || resolveUsAnalyticsDbPath())
  }
  return path.resolve(process.env.STOCKBOARD_DB_PATH?.trim() || process.env.LOCAL_DB_PATH?.trim() || localDbPath)
}

export function resolveMaTrajectoryShadowDbPath(market: MaTrajectoryMarket): string {
  const configured = process.env[`MA_TRAJECTORY_SHADOW_DB_PATH_${market}`]?.trim()
    || process.env.MA_TRAJECTORY_SHADOW_DB_PATH?.trim()
  if (configured) return path.resolve(configured)
  const sourceDb = resolveMaTrajectorySourceDbPath(market)
  return path.join(
    path.dirname(sourceDb),
    'ma-trajectory-shadow',
    `ma-trajectory-shadow-${market.toLowerCase()}.db`,
  )
}

export function resolveMaTrajectoryArtifactDirectory(market: MaTrajectoryMarket): string {
  const configured = process.env.MA_TRAJECTORY_ARTIFACT_DIR?.trim()
  if (configured) return path.resolve(configured, market.toLowerCase())
  const sourceDb = resolveMaTrajectorySourceDbPath(market)
  return path.join(path.dirname(sourceDb), 'ma-trajectory-shadow', 'artifacts', market.toLowerCase())
}
