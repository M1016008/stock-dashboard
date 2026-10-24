import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkerContext } from './lib/scenario'
import { assertDevelopmentArtifactRoot, assertDevelopmentFixtureSource } from './lib/fixture-utils'
import { setupAnalogIndex, setupAnalogIndexUs, setupUsAnalytics } from './scenarios/priority-search'

async function main(): Promise<void> {
  const requestedFixture = process.argv[2] ? path.resolve(process.argv[2]) : ''
  if (!requestedFixture || !fs.existsSync(requestedFixture)) {
    throw new Error('usage: prepare-browser-fixture.ts <priority-search master.db> [development-root]')
  }
  const fixture = assertDevelopmentFixtureSource(requestedFixture)

  const root = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve('.stockboard-development')
  assertDevelopmentArtifactRoot(root)
  const data = path.join(root, 'data')
  fs.mkdirSync(data, { recursive: true })
  const runtime = {
    root: data,
    dbPath: path.join(data, 'stockboard.db'),
    servingCachePath: path.join(data, 'serving-cache.db'),
    usAnalyticsDbPath: path.join(data, 'stockboard-us.db'),
    incidentDir: path.join(root, 'storage-incidents'),
    env: {},
    cleanup() { /* persistent development fixture; removed explicitly by its owner */ },
  }
  for (const target of [
    runtime.dbPath,
    runtime.usAnalyticsDbPath,
    runtime.servingCachePath,
    path.join(data, 'analog-jp.db'),
    path.join(data, 'analog-us.db'),
  ]) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true })
  }
  fs.copyFileSync(fixture, runtime.dbPath)

  const codeRoot = process.cwd()
  const context = {
    tree: 'after',
    codeRoot,
    runtime,
    importFromRoot: <T,>(relativePath: string) => (
      import(pathToFileURL(path.join(codeRoot, relativePath)).href) as Promise<T>
    ),
    callRoute: async () => {
      throw new Error('browser fixture preparation does not invoke routes')
    },
  } satisfies WorkerContext

  await setupUsAnalytics(context)
  await setupAnalogIndex(context)
  await setupAnalogIndexUs(context)
  console.log(JSON.stringify({
    root,
    dbBytes: fs.statSync(runtime.dbPath).size,
    usDbBytes: fs.statSync(runtime.usAnalyticsDbPath).size,
    analogJpBytes: fs.statSync(path.join(data, 'analog-jp.db')).size,
    analogUsBytes: fs.statSync(path.join(data, 'analog-us.db')).size,
  }))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
