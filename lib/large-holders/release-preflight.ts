import fs from 'node:fs'
import path from 'node:path'

export const REQUIRED_LARGE_HOLDER_PATHS = [
  ['LARGE_HOLDER_OPERATIONS_DIR', 'directory'],
  ['LARGE_HOLDER_RANKING_CURRENT_PATH', 'file'],
  ['LARGE_HOLDER_RANKING_SNAPSHOT_PATH', 'file'],
  ['LARGE_HOLDER_REVIEW_LEDGER_PATH', 'file'],
] as const

export type LargeHolderReleasePreflight = {
  configured: true
  checkedKeys: string[]
  environment: Record<string, string>
}

export function assertLargeHolderReleaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): LargeHolderReleasePreflight {
  const verifiedEnvironment: Record<string, string> = {}
  for (const [key, expectedType] of REQUIRED_LARGE_HOLDER_PATHS) {
    const configured = environment[key]?.trim()
    if (!configured) throw new Error(`LARGE_HOLDER_RELEASE_CONFIG_MISSING:${key}`)
    if (!path.isAbsolute(configured)) throw new Error(`LARGE_HOLDER_RELEASE_PATH_NOT_ABSOLUTE:${key}`)

    let stat: fs.Stats
    try {
      stat = fs.statSync(configured)
    } catch {
      throw new Error(`LARGE_HOLDER_RELEASE_PATH_UNAVAILABLE:${key}`)
    }
    if (expectedType === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`LARGE_HOLDER_RELEASE_PATH_TYPE_MISMATCH:${key}`)
    }
    verifiedEnvironment[key] = configured
  }
  return {
    configured: true,
    checkedKeys: REQUIRED_LARGE_HOLDER_PATHS.map(([key]) => key),
    environment: verifiedEnvironment,
  }
}
