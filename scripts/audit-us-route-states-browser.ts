import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

type BrowserCase = {
  id: string
  path: string
  blockedPath: string
  /** blockedPath を含んでも遮断しない補助リクエスト (例: 日付一覧)。再試行の回数にも数えない */
  passthroughPath?: string
  expected: string
  excluded?: string
  retryLabel?: string
  /** 失敗表示 (alert) が 390px でもスクロールせずに見えること */
  alertAboveFold?: boolean
  /** 失敗表示が、この要素 (開いた条件パネル等) より上にあること */
  alertBeforeSelector?: string
  /** 失敗中に画面上部 (viewport 内) に出てはいけない「確定値に見える 0」 */
  falseZero?: RegExp[]
  /** 失敗中に画面上部 (main 内) に単独の「0」を出さないこと。件数以外の 0 (条件 0件 等) がある画面では使わない */
  noBareZero?: boolean
  /** 失敗中に画面上部に出ていなければならない非数値の状態表示 */
  stateLabel?: string
  /** 失敗中に出てはいけない成功表示 */
  forbiddenWhileFailed?: string[]
  widths: number[]
}

type EmptyCase = {
  id: string
  path: string
  expected: string
  /** 表示されている間は「まだ確定していない」とみなす文言 */
  busyTexts: string[]
  widths: number[]
}

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const baseUrl = (process.env.US_ROUTE_STATE_BASE_URL ?? '').replace(/\/$/, '')
const errorBaseUrl = (process.env.US_ROUTE_STATE_ERROR_BASE_URL ?? '').replace(/\/$/, '')
const screenshotDir = process.env.SCREENSHOT_DIR?.trim() || null
const injectedSecret = 'TOP_SECRET_API_MESSAGE_/private/stockboard.db'

if (!baseUrl || !errorBaseUrl) {
  throw new Error('US_ROUTE_STATE_BASE_URL and US_ROUTE_STATE_ERROR_BASE_URL are required')
}

const cases: BrowserCase[] = [
  {
    id: 'us-screener',
    path: '/us/screener',
    blockedPath: '/api/us/screener',
    expected: 'USスクリーナーの結果を取得できませんでした。時間をおいて再試行してください。',
    excluded: '指定した条件に該当する銘柄はありません。',
    retryLabel: '再試行',
    // 初期表示で条件パネルは開いている。その先までスクロールしなくても失敗が見えること
    alertBeforeSelector: 'input[aria-label="銘柄コード・企業名"]',
    falseZero: [/(^|[^\d,])0件/],
    stateLabel: '取得失敗',
    forbiddenWhileFailed: ['最新データ'],
    widths: [1440, 390],
  },
  {
    id: 'us-stage-screener',
    path: '/us/stage-screener',
    blockedPath: '/api/us/hex',
    passthroughPath: '/available-dates',
    expected: 'トレンドステージマップを取得できませんでした。時間をおいて再読み込みしてください。',
    excluded: '該当する銘柄がありません',
    retryLabel: '再試行',
    alertAboveFold: true,
    falseZero: [/(^|[^\d,])0 投資対象/, /全投資対象（0）/],
    noBareZero: true,
    stateLabel: '件数を取得できませんでした',
    widths: [1440, 390],
  },
  {
    id: 'jp-stage-screener',
    path: '/stage-screener',
    blockedPath: '/api/hex',
    passthroughPath: '/available-dates',
    expected: 'トレンドステージマップを取得できませんでした。時間をおいて再読み込みしてください。',
    excluded: '該当する銘柄がありません',
    retryLabel: '再試行',
    alertAboveFold: true,
    falseZero: [/(^|[^\d,])0 投資対象/, /全投資対象（0）/],
    noBareZero: true,
    stateLabel: '件数を取得できませんでした',
    widths: [1440],
  },
  {
    id: 'us-mtf-calendar',
    path: '/us/mtf-close-calendar',
    blockedPath: '/api/mtf-close-calendar',
    expected: 'カレンダーを取得できませんでした。再読み込みしてください。',
    retryLabel: '再読み込み',
    alertAboveFold: true,
    falseZero: [/条件に該当\s*0/, /0営業日/],
    noBareZero: true,
    stateLabel: '条件に該当 取得失敗',
    widths: [1440, 390],
  },
  {
    id: 'jp-mtf-calendar',
    path: '/mtf-close-calendar',
    blockedPath: '/api/mtf-close-calendar',
    expected: 'カレンダーを取得できませんでした。再読み込みしてください。',
    retryLabel: '再読み込み',
    alertAboveFold: true,
    falseZero: [/条件に該当\s*0/, /0営業日/],
    noBareZero: true,
    stateLabel: '条件に該当 取得失敗',
    widths: [1440],
  },
]

const emptyCases: EmptyCase[] = [
  {
    id: 'us-screener-empty-date',
    path: '/us/screener?date=2000-01-01',
    expected: 'USデータが未取得です。データ更新状況を確認してください。',
    busyTexts: ['検索中…', 'USデータを確認しています...'],
    widths: [1440, 390],
  },
]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
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
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed'))
        else pending.resolve(message.result)
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

  on(method: string, listener: (params: Record<string, unknown>) => void) {
    const listeners = this.listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.listeners.set(method, listeners)
  }
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const result = await client.send<{ result?: { value?: T } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  return result.result?.value as T
}

async function waitFor<T>(client: CdpClient, expression: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value: T
  while (Date.now() < deadline) {
    value = await evaluate<T>(client, expression)
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for browser condition: ${expression.slice(0, 120)}`)
}

async function screenshot(client: CdpClient, id: string, width: number) {
  if (!screenshotDir) return null
  await mkdir(screenshotDir, { recursive: true })
  const capture = await client.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  })
  const output = `${screenshotDir}/${id}-${width}.png`
  await writeFile(output, Buffer.from(capture.data, 'base64'))
  return output
}

// main 内で viewport に実際に描画されている文字だけを集める (隠れた streaming markup・閉じた select の選択肢は含めない)。
// 閉じた select は選択中の表示だけを含める
const VIEWPORT_TEXT = `(() => {
  const inViewport = (rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  const visible = (el) => el && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  const texts = [];
  const leaves = [];
  const root = document.querySelector('main') || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = (node.textContent || '').trim();
    if (!text || !parent || parent.closest('select, script, style, template') || !visible(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (!Array.from(range.getClientRects()).some(inViewport)) continue;
    texts.push(text);
    leaves.push(text);
  }
  for (const select of root.querySelectorAll('select')) {
    if (!visible(select) || !inViewport(select.getBoundingClientRect())) continue;
    texts.push((select.selectedOptions[0]?.textContent || '').trim());
  }
  return { text: texts.join(' '), leaves };
})()`

async function newClient(debugPort: number, width: number): Promise<CdpClient> {
  const tab = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then((response) => response.json()) as { webSocketDebuggerUrl: string }
  const socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('Chrome CDP socket failed')), { once: true })
  })
  const client = new CdpClient(socket)
  await Promise.all([
    client.send('Page.enable'),
    client.send('Runtime.enable'),
    client.send('Network.enable'),
    client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: width <= 390 ? 844 : 1000,
      deviceScaleFactor: 1,
      mobile: width <= 390,
    }),
  ])
  return client
}

async function auditInjectedCase(debugPort: number, item: BrowserCase, width: number) {
  const client = await newClient(debugPort, width)
  let blocked = 0
  const blockedUrls: string[] = []
  const consoleText: string[] = []
  client.on('Runtime.consoleAPICalled', (params) => {
    const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? []
    consoleText.push(args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '))
  })
  client.on('Fetch.requestPaused', (params) => {
    const requestId = String(params.requestId ?? '')
    const request = params.request as { url?: string } | undefined
    if (!requestId) return
    const url = request?.url ?? ''
    if (url.includes(item.blockedPath) && !(item.passthroughPath && url.includes(item.passthroughPath))) {
      blocked += 1
      blockedUrls.push(url)
      void client.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 503,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(JSON.stringify({ message: injectedSecret })).toString('base64'),
      })
    } else {
      void client.send('Fetch.continueRequest', { requestId })
    }
  })
  await client.send('Fetch.enable', { patterns: [{ urlPattern: `*${item.blockedPath}*`, requestStage: 'Request' }] })
  await client.send('Page.navigate', { url: `${baseUrl}${item.path}` })
  await waitFor<boolean>(client, `document.body.innerText.includes(${JSON.stringify(item.expected)})`)
  const state = await evaluate<{
    alertText: string
    bodyText: string
    alerts: number
    width: number
    scrollWidth: number
    buttons: string[]
  }>(client, `(() => ({
    alertText: Array.from(document.querySelectorAll('[role="alert"]')).map((node) => node.textContent || '').join(' '),
    bodyText: document.body.innerText,
    alerts: document.querySelectorAll('[role="alert"]').length,
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    buttons: Array.from(document.querySelectorAll('button')).map((button) => (button.textContent || '').trim()),
  }))()`)
  assert.ok(state.alerts >= 1, `${item.id}/${width}: alert is missing`)
  assert.match(state.alertText, new RegExp(item.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.ok(!state.bodyText.includes(injectedSecret), `${item.id}/${width}: raw API message leaked`)
  if (item.excluded) assert.ok(!state.bodyText.includes(item.excluded), `${item.id}/${width}: empty state is visible with error`)
  assert.ok(state.scrollWidth <= state.width + 1, `${item.id}/${width}: document overflow ${state.scrollWidth} > ${state.width}`)
  assert.ok(blocked >= 1, `${item.id}/${width}: target request was not intercepted`)
  if (item.alertAboveFold || item.alertBeforeSelector) {
    const placement = await evaluate<{ top: number; bottom: number; viewport: number; beforeTop: number | null } | null>(client, `(() => {
      const alert = Array.from(document.querySelectorAll('[role="alert"]')).find((node) => (node.textContent || '').includes(${JSON.stringify(item.expected)}));
      if (!alert) return null;
      const rect = alert.getBoundingClientRect();
      const before = ${JSON.stringify(item.alertBeforeSelector ?? '')} ? document.querySelector(${JSON.stringify(item.alertBeforeSelector ?? '')}) : null;
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight, beforeTop: before ? before.getBoundingClientRect().top : null };
    })()`)
    assert.ok(placement, `${item.id}/${width}: alert element not found`)
    if (item.alertAboveFold) {
      assert.ok(
        placement.top >= 0 && placement.bottom <= placement.viewport,
        `${item.id}/${width}: alert is below the fold (${Math.round(placement.top)}-${Math.round(placement.bottom)} / ${placement.viewport})`,
      )
    }
    if (item.alertBeforeSelector) {
      assert.ok(placement.beforeTop != null, `${item.id}/${width}: ${item.alertBeforeSelector} not found`)
      assert.ok(placement.bottom <= placement.beforeTop, `${item.id}/${width}: alert is placed after ${item.alertBeforeSelector}`)
    }
  }
  if (item.falseZero || item.noBareZero || item.stateLabel || item.forbiddenWhileFailed) {
    const viewport = await evaluate<{ text: string; leaves: string[] }>(client, VIEWPORT_TEXT)
    for (const pattern of item.falseZero ?? []) {
      assert.doesNotMatch(viewport.text, pattern, `${item.id}/${width}: failure shows a count of 0 above the fold`)
    }
    if (item.noBareZero) {
      assert.deepEqual(viewport.leaves.filter((text) => text === '0'), [], `${item.id}/${width}: failure shows a bare 0 above the fold`)
    }
    if (item.stateLabel) {
      assert.ok(viewport.text.replace(/\s+/g, ' ').includes(item.stateLabel), `${item.id}/${width}: "${item.stateLabel}" is not visible above the fold`)
    }
    for (const text of item.forbiddenWhileFailed ?? []) {
      assert.ok(!viewport.text.includes(text), `${item.id}/${width}: "${text}" contradicts the failure`)
    }
  }
  if (item.retryLabel) {
    // 開発時の二重 effect などで遅れて届く初回リクエストを数え終えてから比べる
    await sleep(500)
    const before = blocked
    const previousUrl = blockedUrls[blockedUrls.length - 1]
    const clicked = await evaluate<boolean>(client, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) => (node.textContent || '').includes(${JSON.stringify(item.retryLabel)}));
      if (!button) return false;
      button.click();
      return true;
    })()`)
    assert.equal(clicked, true, `${item.id}/${width}: retry button is missing`)
    const deadline = Date.now() + 10_000
    while (blocked <= before && Date.now() < deadline) await sleep(100)
    assert.ok(blocked > before, `${item.id}/${width}: retry did not issue another request`)
    await waitFor<boolean>(client, `document.body.innerText.includes(${JSON.stringify(item.expected)})`)
    await sleep(500)
    assert.equal(blocked, before + 1, `${item.id}/${width}: one retry click must issue exactly one request`)
    assert.equal(blockedUrls[blockedUrls.length - 1], previousUrl, `${item.id}/${width}: retry must reissue the same request`)
  }
  const leaked = consoleText.filter((entry) => entry.includes(injectedSecret))
  assert.deepEqual(leaked, [], `${item.id}/${width}: raw API message leaked to browser console`)
  return { id: item.id, width, blocked, screenshot: await screenshot(client, item.id, width) }
}

async function auditBoundary(debugPort: number, width: number) {
  const client = await newClient(debugPort, width)
  const consoleText: string[] = []
  client.on('Runtime.consoleAPICalled', (params) => {
    const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? []
    consoleText.push(args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '))
  })
  await client.send('Page.navigate', { url: `${errorBaseUrl}/us/analysis/ml-lens` })
  await waitFor<boolean>(client, `document.body.innerText.includes('画面を表示できませんでした')`)
  const state = await evaluate<{
    bodyText: string
    alertText: string
    actions: number
    links: number
    width: number
    scrollWidth: number
  }>(client, `(() => {
    const state = document.querySelector('[data-us-route-state="error"]');
    return {
      bodyText: document.body.innerText,
      alertText: state?.querySelector('[role="alert"]')?.textContent || '',
      actions: state?.querySelectorAll('button').length || 0,
      links: state?.querySelectorAll('a').length || 0,
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  })()`)
  assert.match(state.alertText, /一時的な問題の可能性があります/)
  assert.equal(state.actions, 1, `boundary/${width}: expected one action`)
  assert.equal(state.links, 0, `boundary/${width}: must not navigate away`)
  assert.ok(!state.bodyText.includes('/tmp/us-route-state-no-db'), `boundary/${width}: DB path leaked`)
  assert.ok(state.scrollWidth <= state.width + 1, `boundary/${width}: document overflow`)

  // Capture the visual state before keyboard traversal. Tabbing through the global header opens
  // the search suggestions popover, which would obscure the boundary even though the boundary
  // itself is laid out correctly. Keyboard reachability and focus styling are asserted below.
  const screenshotPath = await screenshot(client, 'us-boundary', width)

  let focus: { text: string; outlineStyle: string; outlineWidth: string } | null = null
  for (let index = 0; index < 80; index += 1) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' })
    focus = await evaluate(client, `(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return null;
      const style = getComputedStyle(el);
      return { text: (el.textContent || '').trim(), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    })()`)
    if (focus?.text.includes('再試行')) break
  }
  assert.ok(focus?.text.includes('再試行'), `boundary/${width}: retry is not keyboard reachable`)
  assert.notEqual(focus?.outlineStyle, 'none', `boundary/${width}: focus outline is invisible`)
  assert.notEqual(focus?.outlineWidth, '0px', `boundary/${width}: focus outline has zero width`)
  assert.deepEqual(consoleText.filter((entry) => entry.includes('/tmp/us-route-state-no-db')), [], 'DB path leaked to browser console')
  return { id: 'us-boundary', width, focus, screenshot: screenshotPath }
}

async function auditEmptyCase(debugPort: number, item: EmptyCase, width: number) {
  const client = await newClient(debugPort, width)
  await client.send('Page.navigate', { url: `${baseUrl}${item.path}` })
  // 文字列が markup に存在するだけでは不十分。実際に描画され、読み込み中の表示が消え、
  // 2 回続けて同じ状態であること (最終表示) を待つ
  const finalEmpty = `(() => {
    const expected = ${JSON.stringify(item.expected)};
    const busy = ${JSON.stringify(item.busyTexts)};
    const body = document.body.innerText;
    if (busy.some((text) => body.includes(text))) return false;
    if (document.querySelector('[aria-busy="true"]')) return false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent || '').includes(expected)) continue;
      const el = node.parentElement;
      if (!el || (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  })()`
  await waitFor<boolean>(client, finalEmpty, 30_000)
  await sleep(400)
  assert.ok(await evaluate<boolean>(client, finalEmpty), `${item.id}/${width}: empty state did not settle (loading reappeared)`)
  const state = await evaluate<{
    bodyText: string
    alerts: number
    width: number
    scrollWidth: number
  }>(client, `(() => ({
    bodyText: document.body.innerText,
    alerts: document.querySelectorAll('[role="alert"]').length,
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))()`)
  assert.match(state.bodyText, new RegExp(item.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(state.alerts, 0, `${item.id}/${width}: empty/unavailable state must not be an alert`)
  assert.ok(state.scrollWidth <= state.width + 1, `${item.id}/${width}: document overflow`)
  return { id: item.id, width, screenshot: await screenshot(client, item.id, width) }
}

async function main() {
  const debugPort = 9500 + (process.pid % 300)
  const profile = `/tmp/stockboard-us-route-states-${process.pid}`
  let chrome: ChildProcess | null = null
  try {
    chrome = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--remote-allow-origins=*',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--hide-scrollbars',
      '--no-first-run',
      'about:blank',
    ], { stdio: 'ignore' })
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`)
    const results: unknown[] = []
    for (const item of cases) {
      for (const width of item.widths) results.push(await auditInjectedCase(debugPort, item, width))
    }
    for (const item of emptyCases) {
      for (const width of item.widths) results.push(await auditEmptyCase(debugPort, item, width))
    }
    for (const width of [1440, 390]) results.push(await auditBoundary(debugPort, width))
    process.stdout.write(`${JSON.stringify({ result: 'PASS', cases: results }, null, 2)}\n`)
  } finally {
    if (chrome && chrome.exitCode == null && chrome.signalCode == null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        chrome?.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        chrome?.kill('SIGTERM')
      })
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        break
      } catch (error) {
        if (attempt === 2) throw error
        await sleep(150)
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
