import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNoUnauthorizedDatabaseHandles,
  createLaunchdWriterHoldDriver,
  type CommandResult,
  type CommandRunner,
  type LaunchdRuntimeIdentity,
} from '@/lib/storage/launchd-writer-hold-driver'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-launchd-hold-'))

async function main(): Promise<void> {
try {
  const definitions = new Map<string, LaunchdRuntimeIdentity>()
  function identity(label: string, program: string): LaunchdRuntimeIdentity {
    const plistPath = path.join(root, `${label}.plist`)
    fs.writeFileSync(plistPath, `${label}\n${program}\n`)
    const value = {
      label,
      program,
      plistPath,
      definitionSha256: crypto.createHash('sha256').update(fs.readFileSync(plistPath)).digest('hex'),
    }
    definitions.set(label, value)
    return value
  }

  const writer = identity('writer.fixture', '/approved/writer')
  const disabledWriter = identity('writer.disabled.fixture', '/approved/disabled-writer')
  const reader = identity('reader.fixture', '/approved/reader')
  const loaded = new Set([writer.label, reader.label])
  let lsof: CommandResult = {
    status: 0,
    signal: null,
    stdout: 'p101\ncreader\nn/fixture/stockboard.db\np4242\ncworker\nn/fixture/stockboard.db-wal\n',
    stderr: '',
  }
  let lsofArguments: readonly string[] = []
  const run: CommandRunner = (file, args) => {
    if (file === '/usr/bin/plutil') {
      const plistPath = args.at(-1)!
      const definition = [...definitions.values()].find((value) => value.plistPath === plistPath)!
      return { status: 0, signal: null, stdout: `${definition.program}\n`, stderr: '' }
    }
    if (file === '/bin/launchctl' && args[0] === 'print-disabled') {
      return {
        status: 0,
        signal: null,
        stdout: `disabled services = {\n\t"${disabledWriter.label}" => disabled\n\t"${writer.label}" => enabled\n}\n`,
        stderr: '',
      }
    }
    if (file === '/bin/launchctl' && args[0] === 'print') {
      const label = args[1].split('/').at(-1)!
      if (!loaded.has(label)) {
        return { status: 113, signal: null, stdout: '', stderr: 'Could not find service' }
      }
      const pid = label === reader.label ? 101 : 202
      return { status: 0, signal: null, stdout: `state = running\npid = ${pid}\n`, stderr: '' }
    }
    if (file === '/bin/launchctl' && args[0] === 'bootout') {
      loaded.delete(args[1].split('/').at(-1)!)
      return { status: 0, signal: null, stdout: '', stderr: '' }
    }
    if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
      const definition = [...definitions.values()].find((value) => value.plistPath === args[2])!
      loaded.add(definition.label)
      return { status: 0, signal: null, stdout: '', stderr: '' }
    }
    if (file === '/usr/sbin/lsof') {
      lsofArguments = args
      return lsof
    }
    return { status: 2, signal: null, stdout: '', stderr: 'unexpected fixture command' }
  }

  const driver = createLaunchdWriterHoldDriver([writer, disabledWriter], { run, uid: 501, now: () => 1 })
  assert.equal((await driver.observe(writer.label)).loaded, true)
  assert.deepEqual(await driver.observe(disabledWriter.label), {
    label: disabledWriter.label,
    definitionSha256: disabledWriter.definitionSha256,
    program: disabledWriter.program,
    loaded: false,
    disabled: true,
    instances: 0,
  })
  await driver.bootout(writer.label)
  assert.equal((await driver.observe(writer.label)).loaded, false)
  await driver.bootstrap(writer.label)
  assert.equal((await driver.observe(writer.label)).loaded, true)

  const accepted = assertNoUnauthorizedDatabaseHandles({
    databasePath: '/fixture/stockboard.db',
    approvedReaders: [reader],
    workerPid: 4242,
    timeoutMs: 1_000,
    run,
    uid: 501,
    exists: () => true,
  })
  assert.deepEqual(accepted.map((handle) => handle.pid), [101, 4242])

  lsof = { status: 1, signal: null, stdout: '', stderr: '' }
  assert.deepEqual(assertNoUnauthorizedDatabaseHandles({
    databasePath: '/fixture/stockboard.db',
    approvedReaders: [reader],
    timeoutMs: 1_000,
    run,
    uid: 501,
    exists: (file) => file === '/fixture/stockboard.db',
  }), [])
  assert.deepEqual(lsofArguments, ['-nP', '-Fpcn', '/fixture/stockboard.db'])

  lsof = { status: 0, signal: null, stdout: 'p9000\ncrogue\nn/fixture/stockboard.db\n', stderr: '' }
  assert.throws(() => assertNoUnauthorizedDatabaseHandles({
    databasePath: '/fixture/stockboard.db', approvedReaders: [reader], timeoutMs: 1_000, run, uid: 501, exists: () => true,
  }), /UNAUTHORIZED_DATABASE_HANDLE:9000:rogue/)

  lsof = { status: 2, signal: null, stdout: '', stderr: 'synthetic lsof failure' }
  assert.throws(() => assertNoUnauthorizedDatabaseHandles({
    databasePath: '/fixture/stockboard.db', approvedReaders: [reader], timeoutMs: 1_000, run, uid: 501, exists: () => true,
  }), /LSOF_PROBE_AMBIGUOUS/)

  lsof = { status: 0, signal: null, stdout: '', stderr: 'WARNING: output information may be incomplete' }
  assert.throws(() => assertNoUnauthorizedDatabaseHandles({
    databasePath: '/fixture/stockboard.db', approvedReaders: [reader], timeoutMs: 1_000, run, uid: 501, exists: () => true,
  }), /LSOF_PROBE_AMBIGUOUS/)

  fs.appendFileSync(writer.plistPath, 'changed\n')
  await assert.rejects(() => driver.observe(writer.label), /WRITER_DEFINITION_MISMATCH/)

  console.log(JSON.stringify({
    verdict: 'PASS',
    exactLaunchdIdentity: true,
    gracefulBootoutBootstrap: true,
    macOsDisabledStatePreserved: true,
    approvedReaderAndWorkerHandlesAccepted: true,
    unknownHandleRejected: true,
    ambiguousLsofRejected: true,
    lsofWarningRejected: true,
  }, null, 2))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
