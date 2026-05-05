import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Next.js と同じく .env.local を優先し、無ければ .env を読み込む。
loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

if (!url) {
  throw new Error('TURSO_DATABASE_URL is not set (check .env.local).')
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'turso',
  dbCredentials: { url, authToken },
})
