export const OPERATOR_ACTION_REQUIRED_EXIT_CODE = 74
export const DEFERRED_EXECUTION_EXIT_CODE = 75

export class DeferredExecutionError extends Error {
  readonly exitCode = DEFERRED_EXECUTION_EXIT_CODE

  constructor(message: string) {
    super(message)
    this.name = 'DeferredExecutionError'
  }
}

export class OperatorActionRequiredError extends Error {
  readonly exitCode = OPERATOR_ACTION_REQUIRED_EXIT_CODE

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OperatorActionRequiredError'
  }
}

export function operationalExitCode(error: unknown): number {
  if (error instanceof DeferredExecutionError) return error.exitCode
  if (error instanceof OperatorActionRequiredError) return error.exitCode
  return 1
}
