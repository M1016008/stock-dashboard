import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'

type TailscaleStatus = {
  BackendState?: string
  Self?: {
    Online?: boolean
    DNSName?: string
  }
}

const command = process.argv[2] ?? 'status'
const port = Number(process.env.STOCKBOARD_WEB_PORT ?? 3000)
const target = `127.0.0.1:${port}`
const healthUrl = `http://${target}/api/health`
const candidates = [
  '/Applications/Tailscale.app/Contents/MacOS/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
]
const resolvedTailscale = candidates.find((candidate) => fs.existsSync(candidate))

if (!resolvedTailscale) {
  throw new Error('Tailscale CLIが見つかりません。Tailscaleアプリをインストールしてから再実行してください。')
}
const tailscale: string = resolvedTailscale
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`STOCKBOARD_WEB_PORTが不正です: ${process.env.STOCKBOARD_WEB_PORT}`)
}

function jsonCommand(args: string[]): Record<string, unknown> {
  const output = execFileSync(tailscale, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(output || '{}') as Record<string, unknown>
}

function connectionStatus(): TailscaleStatus {
  return jsonCommand(['status', '--json']) as TailscaleStatus
}

function serveStatus(): Record<string, unknown> {
  return jsonCommand(['serve', 'status', '--json'])
}

function tailnetUrl(status: TailscaleStatus): string | null {
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
  return dnsName ? `https://${dnsName}` : null
}

function serveTargetsLocalApp(config: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(config)
  return serialized.includes(target) || serialized.includes(`localhost:${port}`)
}

async function localHealth(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000), cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

function printStatus(status: TailscaleStatus, serve: Record<string, unknown>, healthy: boolean) {
  const connected = status.BackendState === 'Running' && status.Self?.Online === true
  const configured = serveTargetsLocalApp(serve)
  console.log(`Tailscale: ${connected ? '接続済み' : '未接続'}`)
  console.log(`StockBoard: ${healthy ? '正常' : '応答なし'} (${healthUrl})`)
  console.log(`Tailnet HTTPS: ${configured ? '有効' : '無効'}`)
  const url = connected && configured ? tailnetUrl(status) : null
  if (url) console.log(`閲覧URL: ${url}`)
}

function enableServe() {
  const result = spawnSync(tailscale, ['serve', '--bg', '--yes', '--https=443', '--set-path=/', target], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error('Tailscale Serveの初回承認待ちです。表示された管理画面で承認後、再実行してください。')
  }
  if (result.status !== 0) {
    throw new Error(`Tailscale Serveの設定に失敗しました (exit ${result.status ?? 'unknown'})。`)
  }
}

function disableServe() {
  const result = spawnSync(tailscale, ['serve', '--yes', '--https=443', '--set-path=/', 'off'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error('Tailscale Serveの停止確認がタイムアウトしました。')
  }
  if (result.status !== 0) {
    throw new Error(`Tailscale Serveの停止に失敗しました (exit ${result.status ?? 'unknown'})。`)
  }
}

async function main() {
  if (command === 'login') {
    // No flags: reconnect without overwriting existing DNS, route, SSH, or exit-node settings.
    const result = spawnSync(tailscale, ['up'], { stdio: 'inherit' })
    if (result.status !== 0) process.exitCode = result.status ?? 1
    return
  }

  const status = connectionStatus()
  if (command === 'status') {
    printStatus(status, serveStatus(), await localHealth())
    return
  }

  if (command === 'disable') {
    const currentServe = serveStatus()
    if (!serveTargetsLocalApp(currentServe)) {
      printStatus(status, currentServe, await localHealth())
      return
    }
    disableServe()
    printStatus(connectionStatus(), serveStatus(), await localHealth())
    return
  }

  if (command !== 'enable') {
    throw new Error('usage: npm run remote:status|remote:login|remote:enable|remote:disable')
  }

  if (status.BackendState !== 'Running' || status.Self?.Online !== true) {
    throw new Error('Tailscaleが未接続です。`npm run remote:login`で認証後、もう一度`npm run remote:enable`を実行してください。')
  }
  if (!await localHealth()) {
    throw new Error(`StockBoardが${healthUrl}で応答していません。Webサービスを起動してから再実行してください。`)
  }

  enableServe()
  const serve = serveStatus()
  if (!serveTargetsLocalApp(serve)) {
    throw new Error('Tailscale Serveの設定後検証に失敗しました。')
  }
  printStatus(connectionStatus(), serve, true)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
