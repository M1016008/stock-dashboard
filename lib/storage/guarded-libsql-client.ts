import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'
import { configForDatabase, guardForDatabase, inspectWritableTargetPath, isStorageIoError, requiresExternalStorageGuard, type ExternalStorageGuard } from './external-storage-guard'
import { sqlStatementMayMutate } from '@/lib/db/sql-mutation'
import { assertJpOhlcvRepairMutationAllowed } from '@/lib/jp-ohlcv-repair-barrier'

type GuardedAccess = 'REQUIRED_WRITABLE' | 'OPTIONAL_READ' | 'REBUILDABLE_CACHE'

function sqlText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'sql' in value) {
    const sql = (value as { sql?: unknown }).sql
    return typeof sql === 'string' ? sql : null
  }
  return null
}

function operationMayMutate(property: PropertyKey, args: unknown[]): boolean {
  if (property === 'execute') {
    const sql = sqlText(args[0])
    return !sql || sqlStatementMayMutate(sql)
  }
  if (property === 'executeMultiple') return true
  if (property === 'batch') {
    return !Array.isArray(args[0]) || args[0].some((statement) => {
      const sql = sqlText(statement)
      return !sql || sqlStatementMayMutate(sql)
    })
  }
  if (property === 'transaction') return args[0] !== 'read'
  if (property === 'migrate') return true
  return false
}

function assertRepairBarrierAllows(property: PropertyKey, args: unknown[], jobType: string): void {
  if (!operationMayMutate(property, args)) return
  assertJpOhlcvRepairMutationAllowed(jobType)
}

function wrapRepairBarrier<T extends object>(value: T, jobType: string): T {
  return new Proxy(value, {
    get(target, property) {
      const member = Reflect.get(target, property)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        assertRepairBarrierAllows(property, args, jobType)
        const result = Reflect.apply(member, target, args)
        if (!result || typeof result.then !== 'function') return result
        return result.then((resolved: unknown) => property === 'transaction' && resolved && typeof resolved === 'object'
          ? wrapRepairBarrier(resolved, jobType) : resolved)
      }
    },
  })
}

function wrapObject<T extends object>(value: T, guard: ExternalStorageGuard, access: GuardedAccess = 'REQUIRED_WRITABLE'): T {
  return new Proxy(value, {
    get(target, property) {
      const member = Reflect.get(target, property)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        if (property !== 'close') {
          if (access === 'OPTIONAL_READ') guard.assertReadableVolumeIdentity()
          else guard.assertWritable()
        }
        try {
          const result = Reflect.apply(member, target, args)
          if (!result || typeof result.then !== 'function') return result
          return result.then((resolved: unknown) => property === 'transaction' && resolved && typeof resolved === 'object'
            ? wrapObject(resolved, guard, access) : resolved).catch((error: unknown) => (
              access === 'REQUIRED_WRITABLE' ? guard.classify(error)
                : access === 'REBUILDABLE_CACHE' ? guard.classifyRebuildableCache(error)
                  : guard.classifyOptionalRead(error)
            ))
        } catch (error) {
          if (access === 'REBUILDABLE_CACHE') guard.classifyRebuildableCache(error)
          else if (access === 'OPTIONAL_READ') guard.classifyOptionalRead(error)
          else if (isStorageIoError(error)) guard.classify(error)
          throw error
        }
      }
    },
  })
}

export function openOptionalGuardedReadOnlyClient(dbPath: string, jobType: string): Client | null {
  const guarded = requiresExternalStorageGuard(dbPath)
  const guard = guarded ? guardForDatabase(dbPath, jobType) : null
  guard?.assertReadableVolumeIdentity(true)
  try {
    if (!fs.statSync(dbPath).isFile()) return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (guard) guard.classifyOptionalRead(error)
    throw error
  }
  let client: Client
  try { client = createClient({ url: `file:${dbPath}` }) }
  catch (error) {
    if (guard) guard.classifyOptionalRead(error)
    throw error
  }
  if (!guard) return wrapRepairBarrier(client, jobType)
  guard.setFatalHandler(() => { try { client.close() } catch { /* best effort */ } })
  return wrapObject(wrapRepairBarrier(client, jobType), guard, 'OPTIONAL_READ')
}

export function openExistingGuardedClient(dbPath: string, jobType: string): Client {
  if (!requiresExternalStorageGuard(dbPath)) return wrapRepairBarrier(createClient({ url: `file:${dbPath}` }), jobType)
  const guard = guardForDatabase(dbPath, jobType)
  guard.assertWritable(true)
  let client: Client
  try { client = createClient({ url: `file:${dbPath}` }) }
  catch (error) { if (isStorageIoError(error)) guard.classify(error); throw error }
  guard.setFatalHandler(() => { try { client.close() } catch { /* best effort */ } })
  return wrapObject(wrapRepairBarrier(client, jobType), guard)
}

// Builders may create a new target, but only after its parent, mount and UUID
// have been checked. Every subsequent operation uses the same sticky guard.
export function openGuardedWritableTargetClient(dbPath: string, jobType: string): Client {
  if (!requiresExternalStorageGuard(dbPath)) return wrapRepairBarrier(createClient({ url: `file:${dbPath}` }), jobType)
  inspectWritableTargetPath(configForDatabase(dbPath, jobType))
  if (fs.existsSync(dbPath)) return openExistingGuardedClient(dbPath, jobType)
  const guard = guardForDatabase(dbPath, jobType)
  let client: Client
  try {
    client = createClient({ url: `file:${dbPath}` })
    guard.assertWritable(true)
  } catch (error) {
    if (isStorageIoError(error)) guard.classify(error)
    throw error
  }
  guard.setFatalHandler(() => { try { client.close() } catch { /* best effort */ } })
  return wrapObject(wrapRepairBarrier(client, jobType), guard)
}

// Rebuildable caches require a healthy writable volume, but cache-local open,
// schema, or corruption failures must not poison the primary DB latch.
export function openRebuildableGuardedClient(dbPath: string, jobType: string): Client {
  if (!requiresExternalStorageGuard(dbPath)) return wrapRepairBarrier(createClient({ url: `file:${dbPath}` }), jobType)
  inspectWritableTargetPath(configForDatabase(dbPath, jobType))
  const guard = guardForDatabase(dbPath, jobType)
  let client!: Client
  try {
    if (!fs.existsSync(dbPath)) {
      try { fs.closeSync(fs.openSync(dbPath, 'wx', 0o600)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    client = createClient({ url: `file:${dbPath}` })
    guard.assertWritable(true)
  } catch (error) {
    guard.classifyRebuildableCache(error)
  }
  guard.setFatalHandler(() => { try { client.close() } catch { /* best effort */ } })
  return wrapObject(wrapRepairBarrier(client, jobType), guard, 'REBUILDABLE_CACHE')
}
