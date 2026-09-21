import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'
import { configForDatabase, guardForDatabase, inspectWritableTargetPath, isStorageIoError, requiresExternalStorageGuard, type ExternalStorageGuard } from './external-storage-guard'

function wrapObject<T extends object>(value: T, guard: ExternalStorageGuard): T {
  return new Proxy(value, {
    get(target, property) {
      const member = Reflect.get(target, property)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        if (property !== 'close') guard.assertWritable()
        try {
          const result = Reflect.apply(member, target, args)
          if (!result || typeof result.then !== 'function') return result
          return result.then((resolved: unknown) => property === 'transaction' && resolved && typeof resolved === 'object'
            ? wrapObject(resolved, guard) : resolved).catch((error: unknown) => guard.classify(error))
        } catch (error) {
          if (isStorageIoError(error)) guard.classify(error)
          throw error
        }
      }
    },
  })
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
