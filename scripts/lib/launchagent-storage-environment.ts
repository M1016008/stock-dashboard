const identityKeys = [
  'EXTERNAL_STORAGE_REQUIRED',
  'STOCKBOARD_DB_PATH',
  'STOCK_DATA_MOUNT_PATH',
  'STOCK_DATA_VOLUME_UUID',
  'STOCK_DATA_MIN_FREE_BYTES',
  'STOCK_DATA_MIN_FREE_PERCENT',
] as const

export const launchAgentStorageIdentityKeys: readonly string[] = identityKeys

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Production LaunchAgent install requires ${name}`)
  return value
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function launchAgentStorageEnvironment(): Record<string, string> {
  if (process.env.EXTERNAL_STORAGE_REQUIRED === 'false') {
    throw new Error('Production LaunchAgent install requires external storage protection')
  }
  return {
    EXTERNAL_STORAGE_REQUIRED: 'true',
    USE_LOCAL_DB: '1',
    SKIP_SCHEMA_ENSURE: '1',
    STOCKBOARD_DB_PATH: requiredEnvironment('STOCKBOARD_DB_PATH'),
    STOCK_DATA_MOUNT_PATH: requiredEnvironment('STOCK_DATA_MOUNT_PATH'),
    STOCK_DATA_VOLUME_UUID: requiredEnvironment('STOCK_DATA_VOLUME_UUID'),
    STOCK_DATA_MIN_FREE_BYTES: process.env.STOCK_DATA_MIN_FREE_BYTES?.trim() || '53687091200',
    STOCK_DATA_MIN_FREE_PERCENT: process.env.STOCK_DATA_MIN_FREE_PERCENT?.trim() || '5',
    US_ANALYTICS_DB_PATH: requiredEnvironment('US_ANALYTICS_DB_PATH'),
  }
}

export function launchAgentStorageEnvironmentXml(indent = '  '): string {
  const entries = Object.entries(launchAgentStorageEnvironment())
    .map(([key, value]) => `${indent}  <key>${key}</key><string>${xmlEscape(value)}</string>`)
    .join('\n')
  return `${indent}<key>EnvironmentVariables</key>\n${indent}<dict>\n${entries}\n${indent}</dict>`
}
