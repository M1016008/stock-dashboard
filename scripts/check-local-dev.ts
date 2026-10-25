import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const nodeModulesPath = path.join(root, 'node_modules')
const developmentRoot = path.join(root, '.stockboard-development')
const dbPath = path.join(developmentRoot, 'data', 'stockboard.db')

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(1)}GB`
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(1)}MB`
}

const problems: string[] = []
const warnings: string[] = []

if (!fs.existsSync(nodeModulesPath)) {
  problems.push('node_modules がありません。先に npm install を実行してください。')
}

if (!fs.existsSync(dbPath)) {
  warnings.push(`${dbPath} はまだありません。npm run dev が開発専用DBを初期化します。`)
} else {
  const stats = fs.statSync(dbPath)
  console.log(`Development DB: ${formatBytes(stats.size)} (${dbPath})`)
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
  console.log('\n開発分離チェックはOKです。npm run dev で http://localhost:3001 に起動できます。')
}

process.exit(problems.length > 0 ? 1 : 0)
