import path from 'node:path'
import { anyStorageFatal, configForDatabase, hasStorageFatalLatch, inspectStorage, requiresExternalStorageGuard } from '@/lib/storage/external-storage-guard'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'

export const dynamic = 'force-dynamic'

export async function GET() {
  let storageStatus: 'available' | 'unavailable' = 'available'
  if (!process.env.TURSO_DATABASE_URL || process.env.USE_LOCAL_DB === '1') {
    const configured = process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH
    const dbPath = configured ? resolveConfiguredStoragePath(configured) : path.join(process.cwd(), 'data', 'stockboard.db')
    try {
      if (anyStorageFatal()) storageStatus = 'unavailable'
      else if (requiresExternalStorageGuard(dbPath)) {
        const config = configForDatabase(dbPath, 'web-health')
        if (hasStorageFatalLatch(config)) storageStatus = 'unavailable'
        else inspectStorage(config)
      }
    } catch {
      storageStatus = 'unavailable'
    }
  }
  return Response.json(
    {
      status: storageStatus === 'available' ? 'ok' : 'degraded',
      overall: storageStatus === 'available' ? 'healthy' : 'degraded',
      appStatus: 'running',
      storageStatus,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    {
      status: storageStatus === 'available' ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
