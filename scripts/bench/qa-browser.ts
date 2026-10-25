import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSyntheticPath } from '../lib/synthetic-isolation'
import { assertDevelopmentArtifactRoot } from './lib/fixture-utils'

/**
 * Local browser QA over CDP (headless Chrome, throw-away profile, no external network).
 *
 *   tsx scripts/bench/qa-browser.ts --base http://127.0.0.1:3101 --plan <plan.json>
 *        --out /tmp/sb-xcheck/qa/<run> [--viewports 1440,1024,768,390] [--only <regex>]
 *
 * Each page × viewport is PASS only when: the document answers the expected
 * status, there is no uncaught exception / console error / unexpected failed or
 * ≥ 400 request, no document-level horizontal overflow, every scripted
 * interaction found its target and every assertion held. Everything else is
 * FAIL with reasons. Nothing here is a substitute for human testing.
 */

type Interaction =
  | { type: 'click'; selector?: string; text?: string; within?: string; optional?: boolean }
  | { type: 'type'; selector: string; text: string; clear?: boolean }
  | { type: 'select'; selector: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number }
  | { type: 'waitSelector'; selector: string; timeoutMs?: number }
  | { type: 'assertText'; selector?: string; contains: string }
  | { type: 'assertNoText'; contains: string }
  | { type: 'assertCount'; selector: string; min?: number; max?: number }
  | { type: 'scrollBottom' }

interface PagePlan {
  readonly id: string
  readonly path: string
  readonly expectStatus?: number
  readonly settleMs?: number
  /** Request URL substrings that may legitimately fail or return ≥ 400. */
  readonly allowFailures?: readonly string[]
  /** Console/exception substrings that are known and explained. */
  readonly allowConsole?: readonly string[]
  readonly interactions?: readonly Interaction[]
  readonly viewports?: readonly number[]
}

interface Plan {
  /** Expected console text caused by the deliberately offline browser envelope. */
  readonly allowConsole?: readonly string[]
  readonly pages: readonly PagePlan[]
}

interface RequestRecord {
  url: string
  method: string
  type: string | null
  status: number | null
  startedAt: number
  endedAt: number | null
  bytes: number
  failed: string | null
}

interface StepResult {
  readonly step: string
  readonly ok: boolean
  readonly detail?: string
  readonly requests: Array<{ method: string; url: string; status: number | null; ms: number; bytes: number }>
}

interface PageViewportResult {
  readonly id: string
  readonly viewport: number
  readonly url: string
  readonly status: 'PASS' | 'FAIL'
  readonly reasons: string[]
  readonly documentStatus: number | null
  readonly loadMs: number
  readonly requestCount: number
  readonly duplicateRequests: Array<{ request: string; count: number }>
  readonly encodedKb: number
  readonly consoleMessages: string[]
  readonly exceptions: string[]
  readonly failedRequests: Array<{ url: string; error: string }>
  readonly httpErrors: Array<{ url: string; status: number }>
  readonly externalBlocked: string[]
  readonly externalSucceeded: string[]
  readonly overflow: { viewportWidth: number; scrollWidth: number; offenders: string[] }
  readonly steps: StepResult[]
  readonly screenshot?: string
}

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
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

type Listener = (params: Record<string, unknown>) => void

class CdpClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners = new Map<string, Set<Listener>>()

  constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }
      }
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

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return result
  }

  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(method, set)
    return () => { set.delete(listener) }
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
    )
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'evaluate failed')
    }
    return response.result?.value as T
  }
}

function heightFor(width: number): number {
  return width <= 430 ? 844 : width <= 820 ? 1024 : width <= 1100 ? 768 : 1000
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index].replace(/^--/, ''), argv[index + 1])
  const base = values.get('base')
  const planFile = values.get('plan')
  const runtimeRoot = values.get('runtime-root')
  if (!base || !planFile || !runtimeRoot) throw new Error('usage: qa-browser.ts --base <url> --plan <plan.json> --runtime-root <dir> [--out dir] [--viewports 1440,1024,768,390] [--only regex]')
  const baseUrl = new URL(base)
  if (!['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) throw new Error('QA runs only against a loopback server')
  const out = path.resolve(values.get('out') ?? path.join('/tmp/sb-xcheck/qa', new Date().toISOString().replace(/[:.]/g, '-')))
  if (!isSyntheticPath(out)) assertDevelopmentArtifactRoot(out)
  return {
    base: baseUrl.origin,
    basePort: Number(baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80)),
    runtimeRoot: fs.realpathSync(path.resolve(runtimeRoot)),
    plan: JSON.parse(fs.readFileSync(planFile, 'utf8')) as Plan,
    out,
    viewports: (values.get('viewports') ?? '1440,1024,768,390').split(',').map(Number),
    only: values.has('only') ? new RegExp(values.get('only')!) : null,
  }
}

function assertOwnedQaServer(port: number, runtimeRoot: string): { pid: number; cwd: string; ownerPid: number } {
  const lines = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    encoding: 'utf8', timeout: 5_000,
  }).split('\n')
  const pids = [...new Set(lines.filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))]
  if (pids.length !== 1) throw new Error(`QA requires exactly one owned listener on port ${port}; found ${pids.join(',') || 'none'}`)
  const pid = pids[0]
  const cwdLine = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8', timeout: 5_000,
  }).split('\n').find((line) => line.startsWith('n'))
  const cwd = cwdLine ? fs.realpathSync(cwdLine.slice(1)) : ''
  if (cwd !== fs.realpathSync(process.cwd())) {
    throw new Error(`QA listener ${pid} belongs to ${cwd || 'unknown cwd'}, not ${process.cwd()}`)
  }
  let processPid = pid
  let ownerPid = 0
  const ancestry: number[] = []
  for (let depth = 0; depth < 8 && processPid > 1; depth += 1) {
    ancestry.push(processPid)
    const command = execFileSync('/bin/ps', ['eww', '-p', String(processPid), '-o', 'command='], {
      encoding: 'utf8', timeout: 5_000,
    })
    if ((command.includes('STOCKBOARD_RUNTIME_SCOPE=development') || command.includes('STOCKBOARD_RUNTIME_SCOPE=preview'))
      && command.includes(`STOCKBOARD_ISOLATION_ROOT=${runtimeRoot}`)) {
      ownerPid = processPid
      break
    }
    const parent = Number(execFileSync('/bin/ps', ['-p', String(processPid), '-o', 'ppid='], {
      encoding: 'utf8', timeout: 5_000,
    }).trim())
    if (!Number.isInteger(parent) || parent <= 1 || parent === processPid) break
    processPid = parent
  }
  if (ownerPid === 0) {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(runtimeRoot, '.runtime-owner.json'), 'utf8')) as {
        version?: number
        kind?: string
        root?: string
        cwd?: string
        launcherPid?: number
      }
      if (marker.version === 1
        && (marker.kind === 'development' || marker.kind === 'preview')
        && marker.root === runtimeRoot
        && marker.cwd === cwd
        && Number.isInteger(marker.launcherPid)
        && ancestry.includes(marker.launcherPid!)) {
        ownerPid = marker.launcherPid!
      }
    } catch {
      // Missing, malformed, or stale ownership evidence must fail closed below.
    }
  }
  if (ownerPid === 0) {
    throw new Error(`QA listener ${pid} does not own the required isolated development runtime`)
  }
  return { pid, cwd, ownerPid }
}

function killProcessGroup(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitForChildExit(child: ChildProcess | null, timeoutMs: number): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose)
      resolve(false)
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('close', onClose)
  })
}

const OVERFLOW_PROBE = `(() => {
  const viewportWidth = window.innerWidth;
  const clipped = (element) => {
    let parent = element.parentElement;
    while (parent && parent !== document.body) {
      const style = getComputedStyle(parent);
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) return true;
      if (style.position === 'fixed' || style.position === 'sticky') return true;
      parent = parent.parentElement;
    }
    return false;
  };
  const describe = (element) => {
    const id = element.id ? '#' + element.id : '';
    const cls = typeof element.className === 'string' && element.className ? '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return element.tagName.toLowerCase() + id + cls;
  };
  const offenders = Array.from(document.querySelectorAll('body *')).filter((element) => {
    const style = getComputedStyle(element);
    if (style.position === 'fixed' || style.position === 'sticky' || style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (rect.right > viewportWidth + 1 || rect.left < -1) && !clipped(element);
  }).slice(0, 8).map(describe);
  return { viewportWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
})()`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const server = assertOwnedQaServer(args.basePort, args.runtimeRoot)
  fs.mkdirSync(args.out, { recursive: true })
  const profileDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stockboard-qa-chrome-'))
  const port = 9400 + (process.pid % 400)
  let chrome: ChildProcess | null = null
  const stopChrome = () => killProcessGroup(chrome, 'SIGTERM')
  process.once('SIGINT', stopChrome)
  process.once('SIGTERM', stopChrome)
  const results: PageViewportResult[] = []
  try {
    chrome = spawn(chromePath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-sync',
      // Anything that is not loopback must fail fast: QA never reaches external hosts.
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
    ], { stdio: 'ignore', detached: true })
    await waitForJson(`http://127.0.0.1:${port}/json/version`)
    const targets = await waitForJson<Array<{ type: string; webSocketDebuggerUrl?: string }>>(`http://127.0.0.1:${port}/json/list`)
    const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    if (!target?.webSocketDebuggerUrl) throw new Error('Chrome page target unavailable')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('DevTools websocket failed')), { once: true })
    })
    const client = new CdpClient(socket)
    await Promise.all([client.send('Network.enable'), client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')])

    // Live collectors reused across navigations.
    let requests = new Map<string, RequestRecord>()
    let consoleMessages: string[] = []
    let exceptions: string[] = []
    let inflight = 0
    let lastActivity = Date.now()
    client.on('Network.requestWillBeSent', (params) => {
      const request = params.request as { url?: string; method?: string } | undefined
      const requestId = String(params.requestId ?? '')
      if (!requestId || !request?.url || request.url.startsWith('data:')) return
      inflight += 1
      lastActivity = Date.now()
      requests.set(requestId, {
        url: request.url, method: request.method ?? 'GET', type: typeof params.type === 'string' ? params.type : null,
        status: null, startedAt: Number(params.timestamp ?? 0), endedAt: null, bytes: 0, failed: null,
      })
    })
    client.on('Network.responseReceived', (params) => {
      const record = requests.get(String(params.requestId ?? ''))
      const response = params.response as { status?: number } | undefined
      if (record && response) record.status = Number(response.status ?? 0)
      lastActivity = Date.now()
    })
    client.on('Network.loadingFinished', (params) => {
      const record = requests.get(String(params.requestId ?? ''))
      if (record && record.endedAt === null) {
        record.endedAt = Number(params.timestamp ?? record.startedAt)
        record.bytes = Number(params.encodedDataLength ?? 0)
        inflight = Math.max(0, inflight - 1)
      }
      lastActivity = Date.now()
    })
    client.on('Network.loadingFailed', (params) => {
      const record = requests.get(String(params.requestId ?? ''))
      if (record && record.endedAt === null) {
        record.endedAt = Number(params.timestamp ?? record.startedAt)
        record.failed = String(params.errorText ?? 'network_error')
        if (params.canceled === true) record.failed = `canceled:${record.failed}`
        inflight = Math.max(0, inflight - 1)
      }
      lastActivity = Date.now()
    })
    client.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
      exceptions.push((details?.exception?.description ?? details?.text ?? 'exception').slice(0, 400))
    })
    client.on('Runtime.consoleAPICalled', (params) => {
      const type = String(params.type ?? '')
      if (type !== 'error' && type !== 'warning') return
      const text = ((params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [])
        .map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 400)
      consoleMessages.push(`${type}: ${text}`)
    })
    client.on('Log.entryAdded', (params) => {
      const entry = params.entry as { level?: string; text?: string; url?: string } | undefined
      if (entry?.level === 'error') consoleMessages.push(`log.error: ${entry.text ?? ''} ${entry.url ?? ''}`.slice(0, 400))
    })

    const settle = async (quietMs = 700, timeoutMs = 25_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await sleep(100)
        if (inflight === 0 && Date.now() - lastActivity >= quietMs) return
      }
    }
    const snapshotRequests = () => [...requests.values()].map((record) => ({
      method: record.method, url: record.url, status: record.status,
      ms: Math.round(((record.endedAt ?? record.startedAt) - record.startedAt) * 1000), bytes: record.bytes,
    }))

    const runInteraction = async (step: Interaction): Promise<{ ok: boolean; detail?: string }> => {
      const q = JSON.stringify
      switch (step.type) {
        case 'wait': await sleep(step.ms); return { ok: true }
        case 'waitSelector': {
          const deadline = Date.now() + (step.timeoutMs ?? 15_000)
          while (Date.now() < deadline) {
            if (await client.evaluate<boolean>(`!!document.querySelector(${q(step.selector)})`)) return { ok: true }
            await sleep(150)
          }
          return { ok: false, detail: `selector not found: ${step.selector}` }
        }
        case 'click': {
          const found = await client.evaluate<boolean>(`(() => {
            const root = ${step.within ? `document.querySelector(${q(step.within)})` : 'document'};
            if (!root) return false;
            let el = null;
            ${step.selector ? `el = root.querySelector(${q(step.selector)});` : ''}
            ${step.text ? `if (!el) { const wanted = ${q(step.text)}; el = Array.from(root.querySelectorAll('button,a,[role=button],[role=tab],label,summary')).find((node) => (node.textContent || '').trim().includes(wanted)) || null; }` : ''}
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          })()`)
          return found ? { ok: true } : (step.optional ? { ok: true, detail: 'optional target absent' } : { ok: false, detail: `click target not found: ${step.selector ?? step.text}` })
        }
        case 'type': {
          const focused = await client.evaluate<boolean>(`(() => {
            const el = document.querySelector(${q(step.selector)});
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.focus();
            ${step.clear === false ? '' : `if ('select' in el) el.select();`}
            return true;
          })()`)
          if (!focused) return { ok: false, detail: `type target not found: ${step.selector}` }
          if (step.clear !== false) await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
          if (step.clear !== false) await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
          await client.send('Input.insertText', { text: step.text })
          return { ok: true }
        }
        case 'select': {
          const done = await client.evaluate<boolean>(`(() => {
            const el = document.querySelector(${q(step.selector)});
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            setter.call(el, ${q(step.value)});
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.value === ${q(step.value)};
          })()`)
          return done ? { ok: true } : { ok: false, detail: `select failed: ${step.selector}=${step.value}` }
        }
        case 'press': {
          await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key, code: step.key })
          await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key, code: step.key })
          return { ok: true }
        }
        case 'scrollBottom': {
          await client.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
          return { ok: true }
        }
        case 'assertText': {
          const text = await client.evaluate<string>(`(() => { const el = ${step.selector ? `document.querySelector(${q(step.selector)})` : 'document.body'}; return el ? el.innerText : ''; })()`)
          return text.includes(step.contains) ? { ok: true } : { ok: false, detail: `text not found: "${step.contains}"` }
        }
        case 'assertNoText': {
          const text = await client.evaluate<string>('document.body.innerText')
          return text.includes(step.contains) ? { ok: false, detail: `unexpected text present: "${step.contains}"` } : { ok: true }
        }
        case 'assertCount': {
          const count = await client.evaluate<number>(`document.querySelectorAll(${q(step.selector)}).length`)
          const ok = (step.min === undefined || count >= step.min) && (step.max === undefined || count <= step.max)
          return ok ? { ok: true, detail: `count=${count}` } : { ok: false, detail: `count=${count} outside [${step.min ?? '-'}, ${step.max ?? '-'}] for ${step.selector}` }
        }
      }
    }

    for (const viewport of args.viewports) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: viewport, height: heightFor(viewport), deviceScaleFactor: 1, mobile: viewport <= 430,
      })
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: viewport <= 430 })
      for (const page of args.plan.pages) {
        if (args.only && !args.only.test(page.id)) continue
        if (page.viewports && !page.viewports.includes(viewport)) continue
        requests = new Map()
        consoleMessages = []
        exceptions = []
        inflight = 0
        const url = `${args.base}${page.path}`
        const reasons: string[] = []
        const started = Date.now()
        await client.send('Network.clearBrowserCache')
        await client.send('Page.navigate', { url: 'about:blank' })
        await sleep(100)
        requests = new Map()
        consoleMessages = []
        exceptions = []
        inflight = 0
        lastActivity = Date.now()
        await client.send('Page.navigate', { url })
        await sleep(300)
        await settle(page.settleMs ?? 900, 60_000)
        const loadMs = Date.now() - started
        const documentRecord = [...requests.values()].find((record) => record.type === 'Document' && record.url.startsWith(args.base))
        const documentStatus = documentRecord?.status ?? null
        const steps: StepResult[] = []
        for (const [index, step] of (page.interactions ?? []).entries()) {
          const before = new Set(requests.keys())
          const outcome = await runInteraction(step)
          await settle(500, 20_000)
          const newRequests = snapshotRequests().filter((_, position) => ![...before].includes([...requests.keys()][position]))
          steps.push({ step: `${index + 1}:${step.type}${'selector' in step && step.selector ? `(${step.selector})` : ''}${'text' in step && step.text ? `(${step.text})` : ''}`, ...outcome, requests: newRequests })
          if (!outcome.ok) reasons.push(`step ${index + 1} ${step.type}: ${outcome.detail}`)
        }
        const overflow = await client.evaluate<PageViewportResult['overflow']>(OVERFLOW_PROBE)
        const all = [...requests.values()]
        const isAllowed = (urlText: string) => (page.allowFailures ?? []).some((fragment) => urlText.includes(fragment))
        const isLocal = (urlText: string) => urlText.startsWith(args.base)
        const externalBlocked = all.filter((record) => !isLocal(record.url) && record.failed).map((record) => record.url.slice(0, 160))
        const externalSucceeded = all
          .filter((record) => !isLocal(record.url) && record.status !== null && record.status >= 200 && record.status < 400)
          .map((record) => record.url.slice(0, 160))
        const failedRequests = all
          .filter((record) => record.failed && isLocal(record.url) && !record.failed.startsWith('canceled:') && !isAllowed(record.url))
          .map((record) => ({ url: record.url.slice(0, 200), error: record.failed! }))
        const httpErrors = all
          .filter((record) => record.status !== null && record.status >= 400 && isLocal(record.url) && !isAllowed(record.url) && record !== documentRecord)
          .map((record) => ({ url: record.url.slice(0, 200), status: record.status! }))
        const counts = new Map<string, number>()
        for (const record of all.filter((item) => isLocal(item.url) && item.type !== 'Document')) {
          const parsed = new URL(record.url)
          parsed.searchParams.delete('_rsc')
          const key = `${record.method} ${parsed.pathname}${parsed.search}`
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        const duplicateRequests = [...counts.entries()].filter(([, count]) => count > 1)
          .map(([request, count]) => ({ request, count })).sort((a, b) => b.count - a.count)
        const allowedConsole = (message: string) => [...(args.plan.allowConsole ?? []), ...(page.allowConsole ?? [])]
          .some((fragment) => message.includes(fragment))
        const consoleFiltered = consoleMessages.filter((message) => !allowedConsole(message))
        const exceptionsFiltered = exceptions.filter((message) => !allowedConsole(message))
        if ((page.expectStatus ?? 200) !== documentStatus) reasons.push(`document status ${documentStatus} (expected ${page.expectStatus ?? 200})`)
        if (exceptionsFiltered.length > 0) reasons.push(`${exceptionsFiltered.length} uncaught exception(s)`)
        if (consoleFiltered.length > 0) reasons.push(`${consoleFiltered.length} console error/warning message(s)`)
        if (failedRequests.length > 0) reasons.push(`${failedRequests.length} failed local request(s)`)
        if (httpErrors.length > 0) reasons.push(`${httpErrors.length} HTTP ≥ 400 response(s)`)
        if (externalSucceeded.length > 0) reasons.push(`${externalSucceeded.length} successful external request(s)`)
        if (overflow.scrollWidth > overflow.viewportWidth + 1) reasons.push(`document overflow ${overflow.scrollWidth}px > ${overflow.viewportWidth}px`)
        if (overflow.offenders.length > 0) reasons.push(`${overflow.offenders.length} element(s) outside the viewport`)
        const shot = await client.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
        const shotFile = path.join(args.out, `${page.id}-${viewport}.png`)
        fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'))
        results.push({
          id: page.id, viewport, url, status: reasons.length === 0 ? 'PASS' : 'FAIL', reasons,
          documentStatus, loadMs, requestCount: all.length, duplicateRequests,
          encodedKb: Math.round(all.reduce((sum, record) => sum + record.bytes, 0) / 102.4) / 10,
          consoleMessages: consoleFiltered, exceptions: exceptionsFiltered, failedRequests, httpErrors, externalBlocked, externalSucceeded,
          overflow, steps, screenshot: shotFile,
        })
        console.error(`[qa] ${page.id} @${viewport}: ${reasons.length === 0 ? 'PASS' : `FAIL (${reasons.join('; ')})`}`)
      }
    }
    socket.close()
  } finally {
    process.removeListener('SIGINT', stopChrome)
    process.removeListener('SIGTERM', stopChrome)
    killProcessGroup(chrome, 'SIGTERM')
    if (!await waitForChildExit(chrome, 2_000)) {
      killProcessGroup(chrome, 'SIGKILL')
      if (!await waitForChildExit(chrome, 2_000)) throw new Error('Headless Chrome process group did not exit')
    }
    fs.rmSync(profileDir, { recursive: true, force: true })
  }

  const pass = results.filter((item) => item.status === 'PASS').length
  fs.writeFileSync(path.join(args.out, 'qa-results.json'), JSON.stringify({
    base: args.base,
    runtimeRoot: args.runtimeRoot,
    server,
    finishedAt: new Date().toISOString(),
    pass,
    fail: results.length - pass,
    results,
  }, null, 2))
  const lines = ['# Browser QA (headless Chrome via CDP, automated — not human testing)', '', `PASS ${pass} / ${results.length}`, '',
    '| page | viewport | status | doc | load ms | requests | dup requests | KB | reasons |', '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |']
  for (const item of results) {
    lines.push(`| ${item.id} | ${item.viewport} | ${item.status} | ${item.documentStatus ?? '-'} | ${item.loadMs} | ${item.requestCount} | ${item.duplicateRequests.reduce((sum, entry) => sum + entry.count - 1, 0)} | ${item.encodedKb} | ${item.reasons.join('; ').replace(/\|/g, '/')} |`)
  }
  fs.writeFileSync(path.join(args.out, 'qa-summary.md'), lines.join('\n'))
  console.log(`QA ${pass}/${results.length} PASS → ${args.out}`)
  if (pass !== results.length) process.exitCode = 3
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
