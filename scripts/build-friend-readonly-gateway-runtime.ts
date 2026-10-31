import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  FRIEND_GATEWAY_LABEL,
  FRIEND_GATEWAY_LISTEN,
  FRIEND_GATEWAY_ORIGIN,
  assertFriendReadonlyRuntimeManifest,
  friendReadonlyGatewayPlist,
  type FriendReadonlyRuntimeManifest,
} from '@/lib/friend-readonly-runtime'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function writeNew(file: string, content: Buffer | string, mode = 0o600): void {
  const descriptor = fs.openSync(file, 'wx', mode)
  try {
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

export async function buildFriendReadonlyGatewayRuntime(input: {
  outputDirectory: string
  productionRuntimeRoot: string
  productionPlistPath: string
  nodeExecutable: string
  logDirectory: string
}): Promise<{
  bundlePath: string
  bundleSha256: string
  runtimeTargetPath: string
  manifestPath: string
  manifestSha256: string
  plistPath: string
  plistSha256: string
}> {
  for (const value of Object.values(input)) {
    if (!path.isAbsolute(value)) throw new Error('friend_gateway_build_absolute_path_required')
  }
  fs.mkdirSync(input.outputDirectory, { recursive: false, mode: 0o700 })
  const result = await build({
    entryPoints: [path.resolve('scripts/run-friend-readonly-gateway.ts')],
    absWorkingDir: fs.realpathSync(process.cwd()),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'bundle',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    outfile: 'friend-readonly-gateway.mjs',
    tsconfig: path.resolve('tsconfig.json'),
  })
  if (result.outputFiles.length !== 1) throw new Error('friend_gateway_bundle_output_invalid')
  const bytes = Buffer.from(result.outputFiles[0]!.contents)
  const bundleSha256 = sha256(bytes)
  const bundlePath = path.join(input.outputDirectory, 'friend-readonly-gateway.mjs')
  const runtimeTargetPath = path.join(input.productionRuntimeRoot, bundleSha256, 'friend-readonly-gateway.mjs')
  writeNew(bundlePath, bytes, 0o500)
  const nodeExecutable = fs.realpathSync(input.nodeExecutable)
  const manifest: FriendReadonlyRuntimeManifest = {
    version: 1,
    label: FRIEND_GATEWAY_LABEL,
    nodeExecutable,
    nodeExecutableSha256: sha256(fs.readFileSync(nodeExecutable)),
    runtimePath: runtimeTargetPath,
    runtimeSha256: bundleSha256,
    listen: FRIEND_GATEWAY_LISTEN,
    origin: FRIEND_GATEWAY_ORIGIN,
    accessMode: 'FRIEND_READ_ONLY',
  }
  assertFriendReadonlyRuntimeManifest(manifest)
  const manifestPath = path.join(input.outputDirectory, 'friend-readonly-gateway-manifest.json')
  writeNew(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const plist = friendReadonlyGatewayPlist({
    nodeExecutable,
    runtimePath: runtimeTargetPath,
    logDirectory: input.logDirectory,
  })
  const plistPath = path.join(input.outputDirectory, path.basename(input.productionPlistPath))
  writeNew(plistPath, plist)
  return {
    bundlePath,
    bundleSha256,
    runtimeTargetPath,
    manifestPath,
    manifestSha256: stableSha256(manifest),
    plistPath,
    plistSha256: sha256(plist),
  }
}

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

async function main(): Promise<void> {
  const result = await buildFriendReadonlyGatewayRuntime({
    outputDirectory: value('--output-directory'),
    productionRuntimeRoot: value('--production-runtime-root'),
    productionPlistPath: value('--production-plist-path'),
    nodeExecutable: value('--node-executable'),
    logDirectory: value('--log-directory'),
  })
  console.log(JSON.stringify({ status: 'PASS', ...result }))
}

const invokedPath = process.argv[1] && fs.existsSync(process.argv[1])
  ? pathToFileURL(fs.realpathSync(process.argv[1])).href
  : null
if (invokedPath === import.meta.url) void main()

export const FRIEND_READONLY_GATEWAY_DEFAULT_PRODUCTION_RUNTIME_ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'StockBoard',
  'friend-readonly-gateway',
)
