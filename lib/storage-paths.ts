import fs from 'node:fs'
import path from 'node:path'

export const LEGACY_STORAGE_ROOT = '/Volumes/OWC Express 1M2 80G'
export const CURRENT_STORAGE_ROOT = '/Volumes/こうし'

export function resolveConfiguredStoragePath(
  configuredPath: string,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const resolved = path.resolve(configuredPath)
  const legacyPrefix = `${LEGACY_STORAGE_ROOT}${path.sep}`
  if (!resolved.startsWith(legacyPrefix) || exists(resolved)) return resolved

  const migrated = path.join(CURRENT_STORAGE_ROOT, path.relative(LEGACY_STORAGE_ROOT, resolved))
  return exists(migrated) ? migrated : resolved
}
