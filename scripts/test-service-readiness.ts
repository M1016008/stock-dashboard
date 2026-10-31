import assert from 'node:assert/strict'
import { waitForStableServiceReadiness } from '@/lib/service-readiness'

async function main(): Promise<void> {
  let now = 0
  let observations = 0
  let probes = 0
  const delayed = await waitForStableServiceReadiness({
    label: 'delayed-ready',
    observe: async () => {
      observations += 1
      return observations < 3
        ? { loaded: true, disabled: false, instances: 1, pid: null }
        : { loaded: true, disabled: false, instances: 1, pid: 42 }
    },
    probe: async () => {
      probes += 1
      if (probes < 2) throw new Error('connection_refused')
    },
    timeoutMs: 1_000,
    intervalMs: 10,
    consecutivePasses: 3,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds },
  })
  assert.equal(delayed.pid, 42)
  assert.ok(delayed.checks >= 6)

  now = 0
  const stableWindow = await waitForStableServiceReadiness({
    label: 'stable-window',
    observe: async () => ({ loaded: true, disabled: false, instances: 1, pid: 77 }),
    probe: async () => undefined,
    timeoutMs: 100,
    intervalMs: 10,
    consecutivePasses: 2,
    minimumStableMs: 30,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds },
  })
  assert.equal(stableWindow.pid, 77)
  assert.ok(now >= 30)

  now = 0
  await assert.rejects(waitForStableServiceReadiness({
    label: 'boot-failure',
    observe: async () => ({ loaded: false, disabled: false, instances: 0, pid: null }),
    probe: async () => undefined,
    timeoutMs: 50,
    intervalMs: 10,
    consecutivePasses: 2,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds },
  }), /service_readiness_timeout:boot-failure/)

  now = 0
  let pid = 100
  await assert.rejects(waitForStableServiceReadiness({
    label: 'restart-loop',
    observe: async () => ({ loaded: true, disabled: false, instances: 1, pid: pid++ }),
    probe: async () => undefined,
    timeoutMs: 1_000,
    intervalMs: 10,
    consecutivePasses: 3,
    maximumPidChanges: 2,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds },
  }), /launchd_restart_loop/)

  console.log('Service readiness regression: PASS (delayed ready, boot failure, restart loop)')
}

void main()
