import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const envPath = path.join(root, '.env.local')
const nodeModulesPath = path.join(root, 'node_modules')

function parseEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {}
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  const env: Record<string, string> = {}
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
    env[key] = value
  }
  return env
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(1)}GB`
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(1)}MB`
}

const env = parseEnv(envPath)
const dbPath = env.STOCKBOARD_DB_PATH || env.LOCAL_DB_PATH || path.join(root, 'data', 'stockboard.db')
const problems: string[] = []
const warnings: string[] = []

if (!fs.existsSync(nodeModulesPath)) {
  problems.push('node_modules がありません。先に npm install を実行してください。')
}

if (!fs.existsSync(envPath)) {
  problems.push('.env.local がありません。cp .env.example .env.local で作成してください。')
}

if (env.USE_LOCAL_DB !== '1') {
  warnings.push('USE_LOCAL_DB=1 が設定されていません。ローカルDB開発では設定を推奨します。')
}

for (const key of ['JQUANTS_API_KEY', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) {
  if (!env[key]) warnings.push(`${key} が未設定です。関連する取得・同期バッチは動きません。`)
}

if (!env.OPENAI_API_KEY) {
  warnings.push('OPENAI_API_KEY が未設定です。AIコメントは定型コメントにフォールバックします。')
}

if (!fs.existsSync(dbPath)) {
  problems.push('data/stockboard.db がありません。Mac mini からコピーしてください。')
} else {
  const stats = fs.statSync(dbPath)
  if (stats.size < 1024 * 1024) {
    problems.push('data/stockboard.db のサイズが小さすぎます。コピーが途中で止まっていないか確認してください。')
  } else {
    console.log(`DB: ${formatBytes(stats.size)} (${dbPath})`)
  }
}

if (problems.length > 0) {
  console.error('\nセットアップ未完了:')
  for (const problem of problems) console.error(`- ${problem}`)
}

if (warnings.length > 0) {
  console.warn('\n確認ポイント:')
  for (const warning of warnings) console.warn(`- ${warning}`)
}

if (problems.length === 0) {
  console.log('\nMacBook開発環境の基本チェックはOKです。npm run dev で起動できます。')
}

process.exit(problems.length > 0 ? 1 : 0)
