import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SecretStore {
  get(account: string): Promise<string | null>
  set(account: string, secret: string): Promise<void>
}

export class MacOsKeychainError extends Error {
  constructor(public readonly category: 'unsupported_platform' | 'keychain_read_failed' | 'keychain_write_failed') {
    super(category)
    this.name = 'MacOsKeychainError'
  }
}

type KeychainHelperResult = { code: number; stdout: Buffer }

let compiledHelper: Promise<string> | null = null

function runProcess(command: string, args: string[], stdinValue?: string): Promise<KeychainHelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr.resume()
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout) }))
    if (stdinValue === undefined) child.stdin.end()
    else child.stdin.end(Buffer.from(stdinValue, 'utf8'))
  })
}

async function keychainHelperPath(): Promise<string> {
  if (!compiledHelper) {
    compiledHelper = (async () => {
      const sourcePath = path.join(process.cwd(), 'scripts', 'macos-keychain-helper.m')
      const helperDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-keychain-'))
      fs.chmodSync(helperDirectory, 0o700)
      const binaryPath = path.join(helperDirectory, 'keychain-helper')
      const compiled = await runProcess('/usr/bin/xcrun', [
        'clang', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security',
        sourcePath, '-o', binaryPath,
      ])
      if (compiled.code !== 0) {
        fs.rmSync(helperDirectory, { recursive: true, force: true })
        throw new MacOsKeychainError('unsupported_platform')
      }
      fs.chmodSync(binaryPath, 0o700)
      process.once('exit', () => {
        try {
          fs.rmSync(helperDirectory, { recursive: true, force: true })
        } catch {
          // Process shutdown must not be interrupted by best-effort cleanup.
        }
      })
      return binaryPath
    })()
  }
  return compiledHelper
}

async function runKeychainHelper(args: string[], stdinValue?: string): Promise<KeychainHelperResult> {
  return runProcess(await keychainHelperPath(), args, stdinValue)
}

export class MacOsKeychainSecretStore implements SecretStore {
  constructor(
    private readonly service: string,
    private readonly label = 'Stock Dashboard Trigger Gmail refresh token',
  ) {}

  private assertPlatform(): void {
    if (process.platform !== 'darwin') throw new MacOsKeychainError('unsupported_platform')
  }

  async get(account: string): Promise<string | null> {
    this.assertPlatform()
    const result = await runKeychainHelper(['get', this.service, account])
    if (result.code === 44) return null
    if (result.code !== 0) throw new MacOsKeychainError('keychain_read_failed')
    return result.stdout.toString('utf8') || null
  }

  async set(account: string, secret: string): Promise<void> {
    this.assertPlatform()
    if (!secret) throw new MacOsKeychainError('keychain_write_failed')
    // Security.framework receives the secret over stdin. It never appears in
    // argv, environment variables, or a temporary plaintext file.
    const result = await runKeychainHelper(['set', this.service, account, this.label], secret)
    if (result.code !== 0) throw new MacOsKeychainError('keychain_write_failed')
  }
}
