import path from 'node:path'

export const FRIEND_GATEWAY_LABEL = 'com.stockboard.friend-readonly-gateway' as const
export const FRIEND_GATEWAY_LISTEN = 'http://127.0.0.1:3136' as const
export const FRIEND_GATEWAY_ORIGIN = 'http://127.0.0.1:3000' as const

export type FriendReadonlyRuntimeManifest = {
  version: 1
  label: typeof FRIEND_GATEWAY_LABEL
  nodeExecutable: string
  nodeExecutableSha256: string
  runtimePath: string
  runtimeSha256: string
  listen: typeof FRIEND_GATEWAY_LISTEN
  origin: typeof FRIEND_GATEWAY_ORIGIN
  accessMode: 'FRIEND_READ_ONLY'
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function friendReadonlyGatewayPlist(input: {
  nodeExecutable: string
  runtimePath: string
  logDirectory: string
}): string {
  for (const file of [input.nodeExecutable, input.runtimePath, input.logDirectory]) {
    if (!path.isAbsolute(file)) throw new Error('friend_gateway_runtime_absolute_path_required')
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${FRIEND_GATEWAY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(input.nodeExecutable)}</string>
    <string>${xmlEscape(input.runtimePath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>STOCKBOARD_FRIEND_GATEWAY_HOST</key><string>127.0.0.1</string>
    <key>STOCKBOARD_FRIEND_GATEWAY_PORT</key><string>3136</string>
    <key>STOCKBOARD_FRIEND_ORIGIN</key><string>${FRIEND_GATEWAY_ORIGIN}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(input.logDirectory, 'friend-readonly-gateway.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(input.logDirectory, 'friend-readonly-gateway.err'))}</string>
</dict>
</plist>
`
}

export function assertFriendReadonlyRuntimeManifest(manifest: FriendReadonlyRuntimeManifest): void {
  if (manifest.version !== 1
    || manifest.label !== FRIEND_GATEWAY_LABEL
    || manifest.listen !== FRIEND_GATEWAY_LISTEN
    || manifest.origin !== FRIEND_GATEWAY_ORIGIN
    || manifest.accessMode !== 'FRIEND_READ_ONLY'
    || !path.isAbsolute(manifest.nodeExecutable)
    || !path.isAbsolute(manifest.runtimePath)
    || !/^[a-f0-9]{64}$/.test(manifest.nodeExecutableSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.runtimeSha256)) {
    throw new Error('friend_gateway_runtime_manifest_invalid')
  }
}
