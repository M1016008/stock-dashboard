import { ensureReady } from '@/lib/db/client'

ensureReady()
  .then(() => console.log('local schema ready'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
