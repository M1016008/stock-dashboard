import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS,
  JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS,
  JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS,
} from '@/lib/jp-ohlcv-maintenance-orchestrator'
import {
  inspectDurableAtomicBundleActivation,
  readDurableActivationJournal,
} from '@/lib/storage/durable-atomic-bundle-activation'
import { WEEKLY_BACKUP_WRITER_LABELS } from '@/lib/storage/weekly-backup-policy'
import type {
  ApprovedWriterIdentity,
  WriterRuntimeIdentity,
} from '@/lib/storage/weekly-writer-hold'
const SHA256 = /^[a-f0-9]{64}$/
const CONSUMER_STARTUP_LIMIT_MS = 15 * 60 * 1_000

export const ATOMIC_BUNDLE_CONSUMER_TOPOLOGY = [
  { role: 'WEB', label: 'com.stockboard.web', access: 'DIRECT_SQLITE' },
  { role: 'ANALOG', label: 'com.stockboard.analog-search', access: 'DIRECT_SQLITE' },
  { role: 'GATEWAY', label: 'com.stockboard.friend-readonly-gateway', access: 'WEB_PROXY' },
  { role: 'TRIGGER', label: 'com.stockboard.trigger-historical-scan', access: 'DIRECT_SQLITE' },
] as const

export type AtomicBundleConsumerRole = (typeof ATOMIC_BUNDLE_CONSUMER_TOPOLOGY)[number]['role']
export type AtomicBundleConsumerAccess = (typeof ATOMIC_BUNDLE_CONSUMER_TOPOLOGY)[number]['access']

export type ApprovedAtomicBundleConsumer = {
  role: AtomicBundleConsumerRole
  label: string
  access: AtomicBundleConsumerAccess
  definitionSha256: string
  executableSha256: string
  runtimeManifestSha256: string
  argumentsSha256: string
  program: string
}

export type AtomicBundleConsumerObservation = ApprovedAtomicBundleConsumer & {
  loaded: boolean
  disabled: boolean
  instances: number
  pid: number | null
  startedAt: string
  reportedDatabasePath: string
  reportedDatabaseDevice: string
  reportedDatabaseInode: string
  directDatabaseHandle: boolean
  upstreamLabel: string | null
  upstreamPid: number | null
  sourceGeneration: string
  servingGeneration: string
  cacheGeneration: string
}

export type AtomicBundleWriterObservation = WriterRuntimeIdentity & {
  startedAt: string | null
}

export type AtomicBundleConsumerAdmissionPermit = {
  version: 1
  kind: 'JP_OHLCV_BUNDLE_CONSUMER_ADMISSION_PERMIT'
  transactionId: string
  admission: 'NEW_GENERATION' | 'RESTORED_OLD_GENERATION'
  journalPhase: 'COMMITTED' | 'PRE_CONSUMER_REVERSED'
  journalSha256: string
  journalFileSha256: string
  journalPath: string
  issuedAt: string
  expiresAt: string
  activePath: string
  manifestSha256: string
  integrityReceiptSha256: string
  databasePath: string
  databaseDevice: string
  databaseInode: string
  sourceGeneration: string
  servingGeneration: string
  cacheGeneration: string
  approvedConsumerSetSha256: string
  approvedWriterSetSha256: string
  permitSha256: string
}

export type AtomicBundleConsumerAdmissionReceipt = {
  version: 1
  transactionId: string
  admission: AtomicBundleConsumerAdmissionPermit['admission']
  journalPhase: AtomicBundleConsumerAdmissionPermit['journalPhase']
  checkedAt: string
  permitSha256: string
  manifestSha256: string
  databasePath: string
  databaseDevice: string
  databaseInode: string
  sourceGeneration: string
  servingGeneration: string
  cacheGeneration: string
  consumerObservationSha256ByRole: Record<AtomicBundleConsumerRole, string>
  writerObservationSetSha256: string
  consumerPids: Record<AtomicBundleConsumerRole, number>
  loadedWriterLabels: string[]
  unloadedWriterLabels: string[]
  receiptSha256: string
}

function exactSet(actual: readonly string[], expected: readonly string[], code: string): void {
  const sortedActual = [...actual].sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== new Set(actual).size
    || JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) throw new Error(code)
}

function validIso(value: string): boolean {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function permitBody(permit: AtomicBundleConsumerAdmissionPermit): Omit<AtomicBundleConsumerAdmissionPermit, 'permitSha256'> {
  const { permitSha256: _permit, ...body } = permit
  return body
}

function approvedConsumerSetSha256(consumers: readonly ApprovedAtomicBundleConsumer[]): string {
  return stableSha256([...consumers].sort((a, b) => a.label.localeCompare(b.label)))
}

function approvedWriterSetSha256(writers: readonly ApprovedWriterIdentity[]): string {
  return stableSha256([...writers].sort((a, b) => a.label.localeCompare(b.label)))
}

function assertApprovedIdentities(input: {
  consumers: readonly ApprovedAtomicBundleConsumer[]
  consumerSetSha256: string
  writers: readonly ApprovedWriterIdentity[]
  writerSetSha256: string
}): void {
  exactSet(input.consumers.map((consumer) => consumer.label),
    ATOMIC_BUNDLE_CONSUMER_TOPOLOGY.map((consumer) => consumer.label),
    'SQLITE_BUNDLE_CONSUMER_INVENTORY_MISMATCH')
  exactSet(input.writers.map((writer) => writer.label), WEEKLY_BACKUP_WRITER_LABELS,
    'SQLITE_BUNDLE_WRITER_INVENTORY_MISMATCH')
  if (WEEKLY_BACKUP_WRITER_LABELS.length !== 16
    || JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS.length !== 13
    || JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS.length !== 3
    || approvedConsumerSetSha256(input.consumers) !== input.consumerSetSha256
    || approvedWriterSetSha256(input.writers) !== input.writerSetSha256) {
    throw new Error('SQLITE_BUNDLE_ADMISSION_APPROVAL_MISMATCH')
  }
  for (const expected of ATOMIC_BUNDLE_CONSUMER_TOPOLOGY) {
    const consumer = input.consumers.find((value) => value.label === expected.label)
    if (!consumer || consumer.role !== expected.role || consumer.access !== expected.access
      || !path.isAbsolute(consumer.program)
      || [consumer.definitionSha256, consumer.executableSha256, consumer.runtimeManifestSha256,
        consumer.argumentsSha256].some((value) => !SHA256.test(value))) {
      throw new Error(`SQLITE_BUNDLE_CONSUMER_IDENTITY_INVALID:${expected.label}`)
    }
  }
  for (const writer of input.writers) {
    if (!SHA256.test(writer.definitionSha256) || !path.isAbsolute(writer.program)) {
      throw new Error(`SQLITE_BUNDLE_WRITER_IDENTITY_INVALID:${writer.label}`)
    }
  }
  const triggerConsumer = input.consumers.find((consumer) => consumer.role === 'TRIGGER')!
  const triggerWriter = input.writers.find((writer) => writer.label === triggerConsumer.label)
  if (!triggerWriter || triggerWriter.definitionSha256 !== triggerConsumer.definitionSha256
    || triggerWriter.program !== triggerConsumer.program) {
    throw new Error('SQLITE_BUNDLE_TRIGGER_IDENTITY_MISMATCH')
  }
}

export function prepareAtomicBundleConsumerAdmission(input: {
  journalPath: string
  approvedConsumers: readonly ApprovedAtomicBundleConsumer[]
  approvedConsumerSetSha256: string
  approvedWriters: readonly ApprovedWriterIdentity[]
  approvedWriterSetSha256: string
  assertReaderWriterBarrierValid: () => void
}): AtomicBundleConsumerAdmissionPermit {
  const issuedAt = new Date().toISOString()
  assertApprovedIdentities({
    consumers: input.approvedConsumers,
    consumerSetSha256: input.approvedConsumerSetSha256,
    writers: input.approvedWriters,
    writerSetSha256: input.approvedWriterSetSha256,
  })
  input.assertReaderWriterBarrierValid()
  const activation = inspectDurableAtomicBundleActivation({
    journalPath: input.journalPath,
    verifyByteIdentity: false,
  })
  input.assertReaderWriterBarrierValid()
  const admitted = activation.journal.phase === 'COMMITTED' && activation.position === 'NEW_ACTIVE'
    ? { admission: 'NEW_GENERATION' as const, phase: 'COMMITTED' as const }
    : activation.journal.phase === 'PRE_CONSUMER_REVERSED' && activation.position === 'OLD_ACTIVE'
      ? { admission: 'RESTORED_OLD_GENERATION' as const, phase: 'PRE_CONSUMER_REVERSED' as const }
      : null
  if (activation.durabilityIssues.length > 0 || admitted === null
    || Date.parse(issuedAt) < Date.parse(activation.journal.updatedAt)) {
    throw new Error('SQLITE_BUNDLE_CONSUMER_ADMISSION_PHASE_INVALID')
  }
  const manifest = activation.activeManifest
  const receipt = activation.activeReceipt
  const expectedManifestSha = admitted.admission === 'NEW_GENERATION'
    ? activation.journal.newManifestSha256
    : activation.journal.oldManifestSha256
  if (manifest.manifestSha256 !== expectedManifestSha
    || receipt.receiptSha256 !== manifest.integrityReceiptSha256
    || receipt.databaseSha256 !== manifest.database.sha256) {
    throw new Error('SQLITE_BUNDLE_CONSUMER_ACTIVE_BUNDLE_MISMATCH')
  }
  const body = {
    version: 1 as const,
    kind: 'JP_OHLCV_BUNDLE_CONSUMER_ADMISSION_PERMIT' as const,
    transactionId: activation.journal.transactionId,
    admission: admitted.admission,
    journalPhase: admitted.phase,
    journalSha256: activation.journal.journalSha256,
    journalFileSha256: activation.fileSha256,
    journalPath: input.journalPath,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + CONSUMER_STARTUP_LIMIT_MS).toISOString(),
    activePath: activation.journal.activePath,
    manifestSha256: manifest.manifestSha256,
    integrityReceiptSha256: receipt.receiptSha256,
    databasePath: path.join(activation.journal.activePath, manifest.database.file),
    databaseDevice: manifest.database.device,
    databaseInode: manifest.database.inode,
    sourceGeneration: receipt.sourceGeneration,
    servingGeneration: receipt.servingGeneration,
    cacheGeneration: receipt.cacheGeneration,
    approvedConsumerSetSha256: input.approvedConsumerSetSha256,
    approvedWriterSetSha256: input.approvedWriterSetSha256,
  }
  return { ...body, permitSha256: stableSha256(body) }
}

function assertWriterState(input: {
  permit: AtomicBundleConsumerAdmissionPermit
  approved: readonly ApprovedWriterIdentity[]
  observed: readonly AtomicBundleWriterObservation[]
  checkedAtMs: number
}): { loaded: string[]; unloaded: string[]; observationSha256: string } {
  exactSet(input.observed.map((writer) => writer.label), WEEKLY_BACKUP_WRITER_LABELS,
    'SQLITE_BUNDLE_WRITER_OBSERVATION_MISMATCH')
  const loaded = new Set<string>(JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS)
  const disabled = new Set<string>(JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS)
  const pids = new Set<number>()
  for (const approved of input.approved) {
    const observed = input.observed.find((writer) => writer.label === approved.label)
    const shouldLoad = loaded.has(approved.label)
    const startedAtMs = Date.parse(observed?.startedAt ?? '')
    const validPid = Number.isSafeInteger(observed?.pid) && (observed?.pid ?? 0) > 0
    const validProcessGroup = Number.isSafeInteger(observed?.processGroupId)
      && (observed?.processGroupId ?? 0) > 0
    const activeProcess = validPid && validProcessGroup && validIso(observed?.startedAt ?? '')
      && startedAtMs >= Date.parse(input.permit.issuedAt) && startedAtMs <= input.checkedAtMs
    const idleLoadedJob = observed?.pid === null && observed.processGroupId === null
      && observed.startedAt === null
    if (!observed || observed.definitionSha256 !== approved.definitionSha256
      || observed.program !== approved.program || observed.loaded !== shouldLoad
      || observed.instances !== (shouldLoad ? 1 : 0)
      || observed.disabled !== disabled.has(approved.label)
      || (shouldLoad && (!activeProcess && !idleLoadedJob))
      || (activeProcess && pids.has(observed.pid as number))
      || (!shouldLoad && (observed.pid !== null || observed.processGroupId !== null
        || observed.startedAt !== null))) {
      throw new Error(`SQLITE_BUNDLE_WRITER_STATE_MISMATCH:${approved.label}`)
    }
    if (activeProcess) pids.add(observed.pid as number)
  }
  return {
    loaded: [...JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS].sort(),
    unloaded: [...JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS].sort(),
    observationSha256: stableSha256([...input.observed].sort((a, b) => a.label.localeCompare(b.label))),
  }
}

export function assertAtomicBundleConsumerAdmission(input: {
  journalPath: string
  permit: AtomicBundleConsumerAdmissionPermit
  approvedConsumers: readonly ApprovedAtomicBundleConsumer[]
  approvedWriters: readonly ApprovedWriterIdentity[]
  observedConsumers: readonly AtomicBundleConsumerObservation[]
  observedWriters: readonly AtomicBundleWriterObservation[]
}): AtomicBundleConsumerAdmissionReceipt {
  const checkedAt = new Date().toISOString()
  if (input.permit.version !== 1
    || input.permit.kind !== 'JP_OHLCV_BUNDLE_CONSUMER_ADMISSION_PERMIT'
    || !path.isAbsolute(input.permit.journalPath)
    || input.journalPath !== input.permit.journalPath
    || ![input.permit.permitSha256, input.permit.journalSha256,
      input.permit.journalFileSha256, input.permit.manifestSha256,
      input.permit.integrityReceiptSha256, input.permit.approvedConsumerSetSha256,
      input.permit.approvedWriterSetSha256].every((value) => SHA256.test(value))
    || !validIso(input.permit.issuedAt) || !validIso(input.permit.expiresAt)
    || Date.parse(input.permit.expiresAt) - Date.parse(input.permit.issuedAt) !== CONSUMER_STARTUP_LIMIT_MS
    || stableSha256(permitBody(input.permit)) !== input.permit.permitSha256) {
    throw new Error('SQLITE_BUNDLE_CONSUMER_PERMIT_INVALID')
  }
  const checkedAtMs = Date.parse(checkedAt)
  if (checkedAtMs < Date.parse(input.permit.issuedAt)
    || checkedAtMs > Date.parse(input.permit.expiresAt)) {
    throw new Error('SQLITE_BUNDLE_CONSUMER_PERMIT_EXPIRED')
  }
  assertApprovedIdentities({
    consumers: input.approvedConsumers,
    consumerSetSha256: input.permit.approvedConsumerSetSha256,
    writers: input.approvedWriters,
    writerSetSha256: input.permit.approvedWriterSetSha256,
  })
  const durable = readDurableActivationJournal(input.journalPath)
  if (durable.durabilityIssues.length > 0
    || durable.fileSha256 !== input.permit.journalFileSha256
    || durable.journal.journalSha256 !== input.permit.journalSha256
    || durable.journal.transactionId !== input.permit.transactionId
    || durable.journal.phase !== input.permit.journalPhase
    || durable.journal.activePath !== input.permit.activePath) {
    throw new Error('SQLITE_BUNDLE_CONSUMER_JOURNAL_CHANGED')
  }
  exactSet(input.observedConsumers.map((consumer) => consumer.label),
    input.approvedConsumers.map((consumer) => consumer.label),
    'SQLITE_BUNDLE_CONSUMER_OBSERVATION_MISMATCH')
  const consumerPids = {} as Record<AtomicBundleConsumerRole, number>
  const observationHashes = {} as Record<AtomicBundleConsumerRole, string>
  const web = input.observedConsumers.find((consumer) => consumer.role === 'WEB')
  for (const approved of input.approvedConsumers) {
    const observed = input.observedConsumers.find((consumer) => consumer.label === approved.label)
    const startedAtMs = Date.parse(observed?.startedAt ?? '')
    const gatewayUpstreamValid = approved.access !== 'WEB_PROXY'
      ? observed?.upstreamLabel === null && observed?.upstreamPid === null
      : observed?.upstreamLabel === web?.label && observed?.upstreamPid === web?.pid
    if (!observed || observed.role !== approved.role || observed.access !== approved.access
      || observed.definitionSha256 !== approved.definitionSha256
      || observed.executableSha256 !== approved.executableSha256
      || observed.runtimeManifestSha256 !== approved.runtimeManifestSha256
      || observed.argumentsSha256 !== approved.argumentsSha256 || observed.program !== approved.program
      || !observed.loaded || observed.disabled || observed.instances !== 1
      || !Number.isSafeInteger(observed.pid) || (observed.pid ?? 0) <= 0
      || !validIso(observed.startedAt) || startedAtMs < Date.parse(input.permit.issuedAt)
      || startedAtMs > checkedAtMs || observed.reportedDatabasePath !== input.permit.databasePath
      || observed.reportedDatabaseDevice !== input.permit.databaseDevice
      || observed.reportedDatabaseInode !== input.permit.databaseInode
      || observed.directDatabaseHandle !== (approved.access === 'DIRECT_SQLITE') || !gatewayUpstreamValid
      || observed.sourceGeneration !== input.permit.sourceGeneration
      || observed.servingGeneration !== input.permit.servingGeneration
      || observed.cacheGeneration !== input.permit.cacheGeneration) {
      throw new Error(`SQLITE_BUNDLE_CONSUMER_RUNTIME_MISMATCH:${approved.label}`)
    }
    consumerPids[approved.role] = observed.pid as number
    observationHashes[approved.role] = stableSha256(observed)
  }
  if (new Set(Object.values(consumerPids)).size !== ATOMIC_BUNDLE_CONSUMER_TOPOLOGY.length) {
    throw new Error('SQLITE_BUNDLE_CONSUMER_PID_REUSE_AMBIGUOUS')
  }
  const writers = assertWriterState({
    permit: input.permit,
    approved: input.approvedWriters,
    observed: input.observedWriters,
    checkedAtMs,
  })
  const triggerConsumer = input.observedConsumers.find((consumer) => consumer.role === 'TRIGGER')!
  const triggerWriter = input.observedWriters.find((writer) => writer.label === triggerConsumer.label)
  if (!triggerWriter || triggerWriter.pid !== triggerConsumer.pid
    || triggerWriter.definitionSha256 !== triggerConsumer.definitionSha256
    || triggerWriter.program !== triggerConsumer.program) {
    throw new Error('SQLITE_BUNDLE_TRIGGER_RUNTIME_MISMATCH')
  }
  const nonTriggerConsumerPids = Object.entries(consumerPids)
    .filter(([role]) => role !== 'TRIGGER').map(([, pid]) => pid)
  const writerPids = input.observedWriters.flatMap((writer) => writer.pid === null ? [] : [writer.pid])
  if (nonTriggerConsumerPids.some((pid) => writerPids.includes(pid))) {
    throw new Error('SQLITE_BUNDLE_CONSUMER_WRITER_PID_REUSE_AMBIGUOUS')
  }
  const body = {
    version: 1 as const,
    transactionId: input.permit.transactionId,
    admission: input.permit.admission,
    journalPhase: input.permit.journalPhase,
    checkedAt,
    permitSha256: input.permit.permitSha256,
    manifestSha256: input.permit.manifestSha256,
    databasePath: input.permit.databasePath,
    databaseDevice: input.permit.databaseDevice,
    databaseInode: input.permit.databaseInode,
    sourceGeneration: input.permit.sourceGeneration,
    servingGeneration: input.permit.servingGeneration,
    cacheGeneration: input.permit.cacheGeneration,
    consumerObservationSha256ByRole: observationHashes,
    writerObservationSetSha256: writers.observationSha256,
    consumerPids,
    loadedWriterLabels: writers.loaded,
    unloadedWriterLabels: writers.unloaded,
  }
  return { ...body, receiptSha256: stableSha256(body) }
}
