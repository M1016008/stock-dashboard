import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'
import { configForDatabase, guardForDatabase, inspectWritableTargetPath, isStorageIoError, requiresExternalStorageGuard, type ExternalStorageGuard } from './external-storage-guard'

type GuardedAccess = 'REQUIRED_WRITABLE' | 'OPTIONAL_READ'

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
              access === 'OPTIONAL_READ' ? guard.classifyOptionalRead(error) : guard.classify(error)
            ))
        } catch (error) {
          if (access === 'OPTIONAL_READ') guard.classifyOptionalRead(error)
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
  if (!guard) return client
  guard.setFatalHandler(() => { try { client.close() } catch { /* best effort */ } })
  return wrapObject(client, guard, 'OPTIONAL_READ')
}

export function openExistingGuardedClient(dbPath: string, jobType: string): Client {
  if (!requiresExternalStorageGuard(dbPath)) return createClient({ url: `file:${dbPath}` })
  const guard = guardForDatabase(dbPath, jobType)
  guard.assertWritable(true)
  let client: Client
  try { client = createClient({ url: `file:${dbPath}` }) }
  catch (error) { if (isStorageIoError(error)) guard.classify(error); throw error }
  guard.setFatalHandler(() => { try { client.close() } catch { /* best effort */ } })
  return wrapObject(client, guard)
}

// Builders may create a new target, but only after its parent, mount and UUID
// have been checked. Every subsequent operation uses the same sticky guard.
export function openGuardedWritableTargetClient(dbPath: string, jobType: string): Client {
  if (!requiresExternalStorageGuard(dbPath)) return createClient({ url: `file:${dbPath}` })
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
  return wrapObject(client, guard)
}
