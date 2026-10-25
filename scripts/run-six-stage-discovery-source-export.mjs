import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import storagePreflightModule from '../lib/research/six-stage-discovery-storage-preflight.ts'
import sourceRateLimitModule from '../lib/research/six-stage-source-rate-limit.ts'

const {
  certifySixStageDiscoveryStoragePreflight,
  prepareSixStageDiscoveryStoragePreflight,
} = storagePreflightModule
const { sourceReadThrottleDelayMs } = sourceRateLimitModule

const planPath = process.argv[2]
const expectedPlanHash = process.argv[3]
if (!planPath || !expectedPlanHash) throw new Error('usage: node script plan.json expected-plan-sha256')
let orchestratorAttestation
try {
  const encoded = fs.readFileSync(3, { encoding: 'utf8' })
  if (Buffer.byteLength(encoded) > 4_096) throw new Error('attestation too large')
  orchestratorAttestation = JSON.parse(encoded)
} catch {
  throw new Error('trusted research execution orchestrator attestation is required')
}
if (!/^[a-f0-9]{64}$/.test(orchestratorAttestation.token ?? '')
  || orchestratorAttestation.planHash !== expectedPlanHash
  || Number(orchestratorAttestation.orchestratorPid) !== process.ppid) {
  throw new Error('research execution orchestrator attestation mismatch')
}
const orchestratorPid = Number(orchestratorAttestation.orchestratorPid)

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const fileSha256 = (file) => {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!count) break
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}
const iso = () => new Date().toISOString()
const log = (message, data = undefined) => {
  const line = JSON.stringify({ at: iso(), message, ...(data === undefined ? {} : { data }) })
  process.stdout.write(`${line}\n`)
  if (logFile) fs.appendFileSync(logFile, `${line}\n`)
}
const fail = (message) => { throw new Error(message) }
const assertOrchestratorAlive = () => {
  if (process.ppid !== orchestratorPid) fail('research execution orchestrator parent changed')
  try {
    process.kill(orchestratorPid, 0)
  } catch {
    fail('research execution orchestrator is not alive')
  }
}
const queryScalar = (db, sql, key) => db.prepare(sql).get()?.[key]
const statIdentity = (file) => {
  const s = fs.statSync(file)
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }
}
const freeBytes = (target) => Number(execFileSync('df', ['-k', target], { encoding: 'utf8' }).trim().split('\n').at(-1).trim().split(/\s+/)[3]) * 1024
const directoryBytes = (target) => {
  if (!fs.existsSync(target)) return 0
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) fail('output symlink rejected')
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  return fs.readdirSync(target).reduce((total, entry) => total + directoryBytes(path.join(target, entry)), 0)
}
const health = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  if (!response.ok) fail(`health HTTP ${response.status}: ${url}`)
  const body = await response.json()
  if (body.status !== 'ok' || body.overall !== 'healthy') fail(`health body not healthy: ${url}`)
  if (url.includes(':3000') && body.storageStatus !== 'available') fail('Production storage unavailable')
  return body
}
const rowsHash = (rows, columns) => {
  const hash = crypto.createHash('sha256')
  let bytes = 0
  for (const row of rows) {
    const encoded = `${columns.map((name) => row[name] === null ? '\\N' : String(row[name])).join('\t')}\n`
    bytes += Buffer.byteLength(encoded)
    hash.update(encoded)
  }
  return { sha256: hash.digest('hex'), bytes }
}

const rawPlan = fs.readFileSync(planPath)
const planHash = sha256(rawPlan)
if (planHash !== expectedPlanHash) fail(`plan hash mismatch: ${planHash}`)
const plan = JSON.parse(rawPlan)
const storagePreflight = prepareSixStageDiscoveryStoragePreflight(plan, {
  mode: 'AUTHORIZED_PRODUCTION_READ',
})
const window = plan.authorization.executionWindow
const startedAtMs = Date.now()
if (!window || !Number.isFinite(Date.parse(window.startNotBefore))
  || !Number.isFinite(Date.parse(window.startNoLaterThan))
  || !Number.isFinite(Date.parse(window.endNoLaterThan))) fail('invalid approved execution window')
if (startedAtMs < Date.parse(window.startNotBefore) || startedAtMs > Date.parse(window.startNoLaterThan)) fail('outside approved start window')
const { guard: storageGuard } = certifySixStageDiscoveryStoragePreflight(storagePreflight)
const hardDeadlineMs = Math.min(startedAtMs + window.maximumTotalRunSeconds * 1000, Date.parse(window.endNoLaterThan))
const sourceReadDeadlineMs = startedAtMs + window.maximumSourceReadSeconds * 1000
const sourcePath = storagePreflight.sourcePath
const destination = plan.writeOnceDestination
const sourceRead = (operation) => {
  try { return operation() }
  catch (error) { storageGuard.classify(error) }
}
let logFile = null
let source = null
let currentIncomplete = destination.incompleteDirectory
let sourceReadFinishedAt = null
let baseline = null
let walBaseline = null
let lastHealthAt = 0
let sourceLogicalBytes = 0
const sourceThrottleStartedAtMs = Date.now()

const assertDeadline = (sourcePhase = false) => {
  const now = Date.now()
  if (now > hardDeadlineMs) fail('maximum total runtime exceeded')
  if (sourcePhase && now > sourceReadDeadlineMs) fail('maximum source-read runtime exceeded')
}
const assertSourceStable = () => sourceRead(() => {
  const now = statIdentity(sourcePath)
  const walPath = `${sourcePath}-wal`
  const wal = fs.existsSync(walPath) ? fs.statSync(walPath) : null
  if (now.dev !== baseline.dev || now.ino !== baseline.ino || now.size !== baseline.size || now.mtimeMs !== baseline.mtimeMs) fail('source DB identity or metadata changed')
  const walSize = wal?.size ?? 0
  if (walSize > plan.resourceLimits.maximumWalBytesAtStart) fail('WAL exceeds absolute limit')
  if (walSize - walBaseline.size > plan.resourceLimits.maximumWalGrowthBytes) fail('WAL growth limit exceeded')
})
const assertOutputBudget = () => {
  const bytes = directoryBytes(currentIncomplete)
  if (bytes > plan.resourceLimits.maximumOutputBytes) fail(`maximum output bytes exceeded: ${bytes}`)
  return bytes
}
const throttleSourceRead = async (newBytes) => {
  sourceLogicalBytes += newBytes
  const remainingMs = sourceReadThrottleDelayMs({
    logicalBytesRead: sourceLogicalBytes,
    elapsedMs: Date.now() - sourceThrottleStartedAtMs,
    maximumBytesPerSecond: plan.resourceLimits.maximumSourceReadBytesPerSecond,
  })
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs))
}
const periodicHealth = async (force = false) => {
  assertOrchestratorAlive()
  storageGuard.assertReadableVolumeIdentity(force)
  if (!force && Date.now() - lastHealthAt < plan.writerAndHealthIsolation.healthIntervalSeconds * 1000) return
  await health(plan.writerAndHealthIsolation.webHealth)
  await health(plan.writerAndHealthIsolation.analogHealth)
  lastHealthAt = Date.now()
}
const checkpointFile = (market) => path.join(currentIncomplete, `${market.toLowerCase()}-checkpoint.json`)
const persistCheckpoint = (market, checkpoint) => {
  const target = checkpointFile(market)
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'w' })
  fs.renameSync(temporary, target)
}

const createDestination = (market, file) => {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;')
  if (market === 'JP') {
    db.exec('CREATE TABLE ohlcv_daily(ticker TEXT NOT NULL,date TEXT NOT NULL,open REAL,high REAL,low REAL,close REAL,volume REAL,PRIMARY KEY(ticker,date)) WITHOUT ROWID;')
  } else {
    db.exec('CREATE TABLE market_ohlcv_daily(market TEXT NOT NULL,ticker TEXT NOT NULL,date TEXT NOT NULL,open REAL,high REAL,low REAL,close REAL,adj_open REAL,adj_high REAL,adj_low REAL,adj_close REAL,volume REAL,adj_volume REAL,div_cash REAL,split_factor REAL,source TEXT,imported_at TEXT,PRIMARY KEY(market,ticker,date)) WITHOUT ROWID;')
  }
  return db
}

const assertSourceSchema = (market) => sourceRead(() => {
  const spec = plan.markets[market]
  const tableInfo = source.prepare(`PRAGMA table_info(${spec.table})`).all()
  const names = tableInfo.map((row) => String(row.name))
  const missing = spec.sourceColumns.filter((name) => !names.includes(name))
  if (missing.length) fail(`${market} source schema missing columns: ${missing.join(',')}`)
  const sql = String(source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(spec.table)?.sql ?? '')
  if (!sql) fail(`${market} source table definition missing`)
  const candidates = new Set([
    sha256(sql),
    sha256(`${sql}\n`),
    sha256(JSON.stringify(tableInfo)),
    sha256(JSON.stringify({ table: spec.table, columns: tableInfo })),
    sha256(JSON.stringify({ table: spec.table, columns: names }))
  ])
  if (!candidates.has(spec.sourceSchemaSha256)) fail(`${market} source schema hash mismatch`)
  return { expectedSha256: spec.sourceSchemaSha256, sqliteMasterSqlSha256: sha256(sql), columns: names }
})

const copyMarket = async (market) => {
  const spec = plan.markets[market]
  const columns = spec.sourceColumns
  const outputPath = path.join(currentIncomplete, spec.outputFile)
  const db = createDestination(market, outputPath)
  const placeholders = columns.map(() => '?').join(',')
  const insert = db.prepare(`INSERT INTO ${spec.table}(${columns.join(',')}) VALUES(${placeholders})`)
  const select = sourceRead(() => source.prepare(spec.keysetSql))
  let cursorTicker = ''
  let cursorDate = ''
  let count = 0
  let chunk = 0
  let minDate = null
  let maxDate = null
  const tickerSet = new Set()
  const ledger = []
  const started = iso()
  try {
    for (;;) {
      assertDeadline(true)
      await periodicHealth()
      assertSourceStable()
      const dvBefore = Number(sourceRead(() => queryScalar(source, 'PRAGMA data_version', 'data_version')))
      const svBefore = Number(sourceRead(() => queryScalar(source, 'PRAGMA schema_version', 'schema_version')))
      if (dvBefore !== baseline.dataVersion || svBefore !== baseline.schemaVersion) fail('source SQLite generation changed before chunk')
      const rows = sourceRead(() => select.all(cursorTicker, cursorTicker, cursorDate))
      if (!rows.length) break
      const chunkDigest = rowsHash(rows, columns)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of rows) insert.run(...columns.map((name) => row[name]))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      chunk += 1
      count += rows.length
      for (const row of rows) {
        tickerSet.add(String(row.ticker))
        minDate = minDate === null || row.date < minDate ? row.date : minDate
        maxDate = maxDate === null || row.date > maxDate ? row.date : maxDate
      }
      const last = rows.at(-1)
      cursorTicker = String(last.ticker)
      cursorDate = String(last.date)
      const dvAfter = Number(sourceRead(() => queryScalar(source, 'PRAGMA data_version', 'data_version')))
      const svAfter = Number(sourceRead(() => queryScalar(source, 'PRAGMA schema_version', 'schema_version')))
      if (dvAfter !== baseline.dataVersion || svAfter !== baseline.schemaVersion) fail('source SQLite generation changed after chunk')
      await throttleSourceRead(chunkDigest.bytes)
      assertDeadline(true)
      ledger.push({ chunk, rows: rows.length, cursorTicker, cursorDate, sha256: chunkDigest.sha256, logicalBytes: chunkDigest.bytes })
      persistCheckpoint(market, { status: 'COPYING', market, started, updatedAt: iso(), rows: count, chunks: chunk, cursorTicker, cursorDate, minDate, maxDate, chunkLedgerRootSha256: sha256(JSON.stringify(ledger)) })
      assertOutputBudget()
      if (chunk % 20 === 0) log(`${market} progress`, { rows: count, chunks: chunk, cursorTicker, cursorDate })
      if (freeBytes(destination.root) < plan.resourceLimits.minimumFreeBytesAfterCompletion) fail('destination free-space floor breached')
      await new Promise((resolve) => setTimeout(resolve, plan.chunkContract.sleepBetweenChunksMs))
      if (rows.length < plan.chunkContract.rowsPerChunk) break
    }
    db.exec('PRAGMA optimize')
  } finally {
    db.close()
  }
  const summary = { market, started, ended: iso(), rows: count, tickers: tickerSet.size, minDate, maxDate, chunks: chunk, chunkLedgerRootSha256: sha256(JSON.stringify(ledger)), outputPath, bytes: fs.statSync(outputPath).size }
  persistCheckpoint(market, { status: 'COPIED', ...summary })
  log(`${market} source copy complete`, summary)
  return summary
}

const verifyOutput = (market, copied) => {
  assertDeadline(false)
  const spec = plan.markets[market]
  const db = new DatabaseSync(copied.outputPath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
    const quick = queryScalar(db, 'PRAGMA quick_check', 'quick_check')
    if (quick !== 'ok') fail(`${market} quick_check failed: ${quick}`)
    const integrity = queryScalar(db, 'PRAGMA integrity_check', 'integrity_check')
    if (integrity !== 'ok') fail(`${market} integrity_check failed: ${integrity}`)
    const table = spec.table
    const row = db.prepare(`SELECT COUNT(*) rows,MIN(date) minDate,MAX(date) maxDate,COUNT(DISTINCT ticker) tickers,SUM(CASE WHEN date>'2022-12-30' THEN 1 ELSE 0 END) postCutoff FROM ${table}`).get()
    for (const [key, expected] of Object.entries({ rows: spec.expectedRows, tickers: spec.expectedTickers, minDate: spec.expectedMinDate, maxDate: spec.expectedMaxDate, postCutoff: 0 })) {
      if (String(row[key]) !== String(expected)) fail(`${market} ${key} mismatch: ${row[key]} != ${expected}`)
    }
    return { quickCheck: quick, integrityCheck: integrity, ...row }
  } finally {
    db.close()
  }
}

try {
  if (fs.existsSync(destination.incompleteDirectory) || fs.existsSync(destination.finalDirectory)) fail('write-once destination already exists')
  if (fs.realpathSync(path.dirname(sourcePath)) !== path.dirname(sourcePath)) fail('source parent realpath mismatch')
  baseline = statIdentity(sourcePath)
  if (baseline.dev !== plan.sourceDatabase.expectedDevice || baseline.ino !== plan.sourceDatabase.expectedInode) fail('source device/inode mismatch')
  walBaseline = fs.existsSync(`${sourcePath}-wal`) ? fs.statSync(`${sourcePath}-wal`) : { size: 0, mtimeMs: 0 }
  if (walBaseline.size > plan.resourceLimits.maximumWalBytesAtStart) fail('initial WAL limit exceeded')
  if (freeBytes(destination.root) < plan.resourceLimits.minimumFreeBytesBeforeStart) fail('insufficient destination capacity')
  fs.mkdirSync(currentIncomplete, { recursive: false })
  logFile = path.join(currentIncomplete, 'execution.jsonl')
  fs.writeFileSync(logFile, '')
  assertOutputBudget()
  await periodicHealth(true)
  source = sourceRead(() => new DatabaseSync(sourcePath, { readOnly: true }))
  sourceRead(() => source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;'))
  baseline = { ...baseline, dataVersion: Number(sourceRead(() => queryScalar(source, 'PRAGMA data_version', 'data_version'))), schemaVersion: Number(sourceRead(() => queryScalar(source, 'PRAGMA schema_version', 'schema_version'))), journalMode: sourceRead(() => queryScalar(source, 'PRAGMA journal_mode', 'journal_mode')) }
  const sourceSchemas = Object.fromEntries(plan.chunkContract.marketOrder.map((market) => [market, assertSourceSchema(market)]))
  log('source opened read-only', { planHash, baseline, sourceSchemas, walBaseline: { size: walBaseline.size, mtimeMs: walBaseline.mtimeMs } })
  const copied = {}
  for (const market of plan.chunkContract.marketOrder) copied[market] = await copyMarket(market)
  assertSourceStable()
  sourceReadFinishedAt = iso()
  sourceRead(() => source.close())
  source = null
  fs.writeFileSync(path.join(currentIncomplete, 'SOURCE_READ_COMPLETE.json'), `${JSON.stringify({ at: sourceReadFinishedAt, source: baseline, wal: { size: walBaseline.size, mtimeMs: walBaseline.mtimeMs } }, null, 2)}\n`)
  assertOutputBudget()
  log('SOURCE_READ_COMPLETE', { sourceReadFinishedAt })
  const verified = {}
  for (const market of plan.chunkContract.marketOrder) {
    verified[market] = verifyOutput(market, copied[market])
    copied[market].sha256 = fileSha256(copied[market].outputPath)
    log(`${market} verification complete`, { verification: verified[market], sha256: copied[market].sha256 })
    assertOutputBudget()
  }
  await periodicHealth(true)
  const manifest = {
    schemaVersion: 1,
    status: plan.manifest.statusBeforeAcceptance,
    planId: plan.planId,
    planSha256: planHash,
    runnerSha256: fileSha256(new URL(import.meta.url)),
    runId: plan.runId,
    startedAt: new Date(startedAtMs).toISOString(),
    sourceReadFinishedAt,
    finishedAt: iso(),
    source: { path: sourcePath, identity: baseline, schemas: sourceSchemas, walAtStart: { size: walBaseline.size, mtimeMs: walBaseline.mtimeMs } },
    markets: Object.fromEntries(plan.chunkContract.marketOrder.map((market) => [market, { ...copied[market], verification: verified[market], priceBasis: plan.markets[market].priceBasis, logicalSourceIdentityHash: plan.markets[market].logicalSourceIdentityHash, logicalDigest: plan.markets[market].logicalDigest }])),
    cutoff: plan.discoveryBoundary.strictOutcomeCutoff,
    rightCensoring: plan.discoveryBoundary.rightCensoring,
    productionWrites: 0,
    validationHoldoutReads: 0,
    sandiskAccess: 0,
    ownerAdoptionRequired: plan.manifest.adoptionRequiresSeparateOwnerConfirmation
  }
  const manifestPath = path.join(currentIncomplete, plan.manifest.file)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  fs.writeFileSync(path.join(currentIncomplete, 'EXTRACTED.manifest.sha256'), `${fileSha256(manifestPath)}  ${plan.manifest.file}\n`, { flag: 'wx' })
  fs.renameSync(currentIncomplete, destination.finalDirectory)
  currentIncomplete = destination.finalDirectory
  logFile = path.join(currentIncomplete, 'execution.jsonl')
  log('EXTRACTION_COMPLETE_NOT_ADOPTED', { finalDirectory: destination.finalDirectory, manifestSha256: fileSha256(path.join(destination.finalDirectory, plan.manifest.file)) })
} catch (error) {
  try { source?.close() } catch {}
  if (fs.existsSync(currentIncomplete)) {
    try { fs.writeFileSync(path.join(currentIncomplete, 'FAILED.json'), `${JSON.stringify({ at: iso(), planHash, message: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, { flag: 'wx' }) } catch {}
  }
  try {
    log('FAIL_CLOSED', { message: error instanceof Error ? error.message : String(error) })
  } catch (logError) {
    process.stderr.write(`FAIL_CLOSED (execution log unavailable): ${logError instanceof Error ? logError.message : String(logError)}\n`)
  }
  process.exitCode = 1
}
