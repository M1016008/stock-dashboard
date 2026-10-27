export function processGroupExists(processGroupId: number): boolean {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    return code !== 'ESRCH'
  }
}

export function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code !== 'ESRCH') throw error
  }
}

export async function waitForProcessGroupExit(
  processGroupId: number,
  pollMs = 100,
): Promise<void> {
  while (processGroupExists(processGroupId)) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
