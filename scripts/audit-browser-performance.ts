import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import process from 'node:process'

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

type RequestRecord = {
  requestId: string
  url: string
  method: string
  resourceType: string | null
  status: number | null
  mimeType: string | null
  startedAt: number
  endedAt: number | null
  encodedBytes: number
  failed: string | null
}

type PageAudit = {
  url: string
  mode: 'cold' | 'warm'
  durationMs: number
  domContentLoadedMs: number | null
  loadMs: number | null
  requestCount: number
  duplicateRequestCount: number
  encodedBytes: number
  failures: Array<{ url: string; error: string }>
  slowest: Array<{ url: string; method: string; status: number | null; durationMs: number; bytes: number }>
  duplicates: Array<{ request: string; count: number }>
  consoleErrors: string[]
  layout: { viewportWidth: number; scrollWidth: number; overflowCount: number }
}

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const urls = process.argv.slice(2)
if (urls.length === 0) {
  throw new Error('Usage: tsx scripts/audit-browser-performance.ts <url> [url...]')
}

const port = 9300 + (process.pid % 300)
const profileDir = `/tmp/stockboard-performance-${process.pid}`

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json() as T
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`)
}

class CdpClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message ?? 'CDP command failed'))
        else entry.resolve(message.result)
        return
      }
      if (!message.method) return
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {})
    })
  }

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return result
  }

  on(method: string, listener: (params: Record<string, unknown>) => void) {
    const listeners = this.listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.listeners.set(method, listeners)
    return () => listeners.delete(listener)
  }
}

function canonicalRequest(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('_rsc')
    return `${parsed.origin}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

async function auditPage(client: CdpClient, url: string, mode: 'cold' | 'warm'): Promise<PageAudit> {
  if (mode === 'cold') await client.send('Network.clearBrowserCache')
  const records = new Map<string, RequestRecord>()
  let activityAt = Date.now()
  let loaded = false
  const consoleErrors: string[] = []

  const removeRequest = client.on('Network.requestWillBeSent', (params) => {
    const request = params.request as { url?: string; method?: string } | undefined
    const requestId = String(params.requestId ?? '')
    if (!requestId || !request?.url) return
    activityAt = Date.now()
    records.set(requestId, {
      requestId,
      url: request.url,
      method: request.method ?? 'GET',
      resourceType: typeof params.type === 'string' ? params.type : null,
      status: null,
      mimeType: null,
      startedAt: Number(params.timestamp ?? 0),
      endedAt: null,
      encodedBytes: 0,
      failed: null,
    })
  })
  const removeResponse = client.on('Network.responseReceived', (params) => {
    activityAt = Date.now()
    const record = records.get(String(params.requestId ?? ''))
    const response = params.response as { status?: number; mimeType?: string } | undefined
    if (!record || !response) return
    record.status = Number(response.status ?? 0)
    record.mimeType = response.mimeType ?? null
  })
  const removeFinished = client.on('Network.loadingFinished', (params) => {
    activityAt = Date.now()
    const record = records.get(String(params.requestId ?? ''))
    if (!record) return
    record.endedAt = Number(params.timestamp ?? record.startedAt)
    record.encodedBytes = Number(params.encodedDataLength ?? 0)
  })
  const removeFailed = client.on('Network.loadingFailed', (params) => {
    activityAt = Date.now()
    const record = records.get(String(params.requestId ?? ''))
    if (!record) return
    record.endedAt = Number(params.timestamp ?? record.startedAt)
    record.failed = String(params.errorText ?? 'network_error')
  })
  const removeLoad = client.on('Page.loadEventFired', () => {
    loaded = true
    activityAt = Date.now()
  })
  const removeException = client.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    consoleErrors.push(details?.exception?.description ?? details?.text ?? 'runtime_exception')
  })

  const startedAt = Date.now()
  await client.send('Page.navigate', { url })
  const deadline = startedAt + 20_000
  while (Date.now() < deadline) {
    await sleep(100)
    if (Date.now() - activityAt >= 1_500 && (loaded || Date.now() - startedAt >= 3_000)) break
  }
  const durationMs = Date.now() - startedAt
  const timing = await client.send<{ result?: { value?: { domContentLoaded?: number; load?: number } } }>('Runtime.evaluate', {
    expression: `(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd } : {}; })()`,
    returnByValue: true,
  }).catch(() => ({ result: { value: {} } }))
  const navigationTiming = timing.result?.value as { domContentLoaded?: number; load?: number } | undefined
  const layoutResult = await client.send<{ result?: { value?: { viewportWidth?: number; scrollWidth?: number; overflowCount?: number } } }>('Runtime.evaluate', {
    expression: `(() => {
      const viewportWidth = window.innerWidth;
      const offenders = Array.from(document.querySelectorAll('body *')).filter((element) => {
        const style = getComputedStyle(element);
        if (style.position === 'fixed' || style.position === 'sticky') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > viewportWidth + 1 || rect.left < -1);
      });
      return { viewportWidth, scrollWidth: document.documentElement.scrollWidth, overflowCount: offenders.length };
    })()`,
    returnByValue: true,
  }).catch(() => ({ result: { value: { viewportWidth: 0, scrollWidth: 0, overflowCount: -1 } } }))
  const layout = layoutResult.result?.value ?? { viewportWidth: 0, scrollWidth: 0, overflowCount: -1 }

  removeRequest()
  removeResponse()
  removeFinished()
  removeFailed()
  removeLoad()
  removeException()

  const values = Array.from(records.values()).filter((record) => !record.url.startsWith('data:'))
  const counts = new Map<string, number>()
  for (const record of values) {
    const key = `${record.method} ${canonicalRequest(record.url)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const duplicates = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([request, count]) => ({ request, count }))
    .sort((a, b) => b.count - a.count || a.request.localeCompare(b.request))

  return {
    url,
    mode,
    durationMs,
    domContentLoadedMs: Number(navigationTiming?.domContentLoaded ?? 0) || null,
    loadMs: Number(navigationTiming?.load ?? 0) || null,
    requestCount: values.length,
    duplicateRequestCount: duplicates.reduce((sum, item) => sum + item.count - 1, 0),
    encodedBytes: values.reduce((sum, record) => sum + record.encodedBytes, 0),
    failures: values.filter((record) => record.failed).map((record) => ({ url: record.url, error: record.failed ?? 'network_error' })),
    slowest: values
      .filter((record) => record.endedAt != null)
      .map((record) => ({
        url: canonicalRequest(record.url),
        method: record.method,
        status: record.status,
        durationMs: Math.round(((record.endedAt ?? record.startedAt) - record.startedAt) * 1000),
        bytes: record.encodedBytes,
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 8),
    duplicates,
    consoleErrors,
    layout: {
      viewportWidth: Number(layout.viewportWidth ?? 0),
      scrollWidth: Number(layout.scrollWidth ?? 0),
      overflowCount: Number(layout.overflowCount ?? -1),
    },
  }
}

async function main() {
  let chrome: ChildProcess | null = null
  try {
  await rm(profileDir, { recursive: true, force: true })
  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' })
  await waitForJson(`http://127.0.0.1:${port}/json/version`)
  const targets = await waitForJson<Array<{ type: string; webSocketDebuggerUrl?: string }>>(`http://127.0.0.1:${port}/json/list`)
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  if (!target?.webSocketDebuggerUrl) throw new Error('Chrome page target was not available')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools websocket failed')), { once: true })
  })
  const client = new CdpClient(socket)
  await Promise.all([client.send('Network.enable'), client.send('Page.enable'), client.send('Runtime.enable')])
  const viewportWidth = Number(process.env.VIEWPORT_WIDTH ?? 1440)
  const viewportHeight = Number(process.env.VIEWPORT_HEIGHT ?? (viewportWidth <= 390 ? 844 : viewportWidth <= 768 ? 1024 : viewportWidth <= 1024 ? 768 : 1000))
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    mobile: viewportWidth <= 390,
  })
  const audits: PageAudit[] = []
  for (const url of urls) {
    audits.push(await auditPage(client, url, 'cold'))
    audits.push(await auditPage(client, url, 'warm'))
  }
  console.log(JSON.stringify({ auditedAt: new Date().toISOString(), audits }, null, 2))
  socket.close()
  } finally {
    chrome?.kill('SIGTERM')
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
