export type DeteriorationGateStatus = 'ok' | 'warn' | 'fail' | 'missing'

export type DeteriorationGateCheck = {
  status: DeteriorationGateStatus
  publicationBlocking: boolean
}

export function shouldFailDeteriorationGate(
  checks: DeteriorationGateCheck[],
  strict: boolean,
): boolean {
  return strict && checks.some(
    (check) => check.publicationBlocking && (check.status === 'fail' || check.status === 'missing'),
  )
}
