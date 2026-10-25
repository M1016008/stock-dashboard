export class KeyedSingleflight {
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly waiters: Array<() => void> = []
  private active = 0

  constructor(private readonly maxConcurrency = Number.POSITIVE_INFINITY) {
    if (!(maxConcurrency > 0)) throw new Error('maxConcurrency must be positive')
  }

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key)
    if (existing) return existing as Promise<T>

    const pending = this.runBounded(work).finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
    })
    this.inFlight.set(key, pending)
    return pending
  }

  get pendingKeys(): number {
    return this.inFlight.size
  }

  private async runBounded<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await work()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      queueMicrotask(next)
      return
    }
    this.active = Math.max(0, this.active - 1)
  }
}
