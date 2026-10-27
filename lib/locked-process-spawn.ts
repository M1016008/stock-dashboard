import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { PidProcessLock } from '@/lib/pid-process-lock'

const MARKER_WRAPPER = 'umask 077; printf "%s\\n" "$$" > "$1"; shift; exec "$@"'

export function spawnLockedProcessGroup(
  lock: PidProcessLock,
  command: string,
  args: string[],
  options: Omit<SpawnOptions, 'detached' | 'shell'>,
): ChildProcess {
  const markerPath = lock.prepareProcessGroupMarker()
  return spawn(
    '/bin/sh',
    ['-c', MARKER_WRAPPER, 'stockboard-process-group', markerPath, command, ...args],
    { ...options, detached: true, shell: false },
  )
}
