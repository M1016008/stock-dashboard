import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TriggerDiscoveryCurrentLab } from '@/components/trigger-discovery/design-lab/TriggerDiscoveryCurrentLab'
import { LAB_STATES, type LabState } from '@/components/trigger-discovery/design-lab/fixtures'

// Trigger Discovery「現在・単日時点」Design Lab のレンダラ。
// 静的Fixtureから HTML を生成し Chrome headless でPNGにする。DB/API/外部アクセスなし。
// 出力は引数で渡された出力ディレクトリのみ。

export const LAB_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'ipadLandscape', width: 1024, height: 768 },
  { name: 'ipadPortrait', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'wide', width: 1920, height: 1080 },
] as const

export type LabViewport = (typeof LAB_VIEWPORTS)[number]

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_TIMEOUT_MS = 60_000
export const DESIGN_LAB_OUTPUT_ROOT = '/Users/yoshio/Documents/ChatGPT/UI-DESIGN-QA/trigger-discovery/runs'
const DESIGN_LAB_COMPONENT_DIR = path.resolve(__dirname, '../../components/trigger-discovery/design-lab')
const PREVIEW_HOST = '127.0.0.1'
const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
}

const FORBIDDEN_DESIGN_LAB_SOURCE = [
  { label: 'network request', pattern: /\b(?:fetch|XMLHttpRequest|EventSource|WebSocket)\s*\(/ },
  { label: 'API path', pattern: /["'`]\/api(?:\/|["'`])/ },
  { label: 'database or storage import', pattern: /from\s+["'`]@\/lib\/(?:db|storage|server\/(?:storage|running-job-health))/ },
  { label: 'runtime environment', pattern: /\bprocess\.env\b/ },
  { label: 'runtime integration', pattern: /\b(?:prisma|sqlite|launchctl|LaunchAgent)\b/i },
] as const

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(target) : [target]
  })
}

export function assertFixtureOnlyDesignLabSources(): void {
  for (const file of sourceFiles(DESIGN_LAB_COMPONENT_DIR)) {
    const source = fs.readFileSync(file, 'utf8')
    for (const forbidden of FORBIDDEN_DESIGN_LAB_SOURCE) {
      if (forbidden.pattern.test(source)) throw new Error(`Design Lab isolation violation (${forbidden.label}): ${path.basename(file)}`)
    }
  }
}

export function assertDesignLabOutputDir(outDir: string): string {
  const resolved = path.resolve(outDir)
  const root = path.resolve(DESIGN_LAB_OUTPUT_ROOT)
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Design Lab output must be inside the isolated QA output root')
  return resolved
}

export function renderStateHtml(state: LabState, options: { drawerOpen?: boolean; barOpen?: boolean } = {}): string {
  const body = renderToStaticMarkup(createElement(TriggerDiscoveryCurrentLab, { state, ...options }))
  return `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trigger Discovery 現在・単日時点 — ${state}</title><style>html,body{margin:0;padding:0;height:100%}</style></head><body>${body}</body></html>\n`
}

export function renderPreviewIndex(files: Record<LabState, string>, extras: Array<{ label: string; file: string }>): string {
  const links = LAB_STATES.map((s) => `<li><a href="${files[s]}">${s}</a></li>`).join('')
  const more = extras.map((e) => `<li><a href="${e.file}">${e.label}</a></li>`).join('')
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Trigger Discovery Design Lab</title><style>body{font:14px system-ui;margin:24px}li{margin:6px 0}</style></head><body><h1>Trigger Discovery 現在・単日時点 Design Lab</h1><ul>${links}${more}</ul></body></html>\n`
}

function runChrome(args: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.STOCKBOARD_CHROME_PATH ?? DEFAULT_CHROME_PATH, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let settled = false
    let lastSize = -1
    let stable = 0
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2000) })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(poll)
      if (child.exitCode == null) child.kill('SIGKILL')
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error(`Chrome timed out: ${path.basename(outputPath)}`)), CHROME_TIMEOUT_MS)
    const poll = setInterval(() => {
      try {
        const size = fs.statSync(outputPath).size
        stable = size > 1000 && size === lastSize ? stable + 1 : 0
        lastSize = size
        if (stable >= 4) finish()
      } catch {
        stable = 0
      }
    }, 250)
    child.once('error', () => finish(new Error('Chrome is unavailable')))
    child.once('exit', (code) => {
      if (settled) return
      if (fs.existsSync(outputPath)) finish()
      else finish(new Error(`Chrome exited (${code ?? 'signal'}): ${stderr.replace(/\s+/g, ' ').trim().slice(0, 200)}`))
    })
  })
}

export function readPngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file)
  if (buf.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error(`not a PNG: ${file}`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export async function screenshot(htmlPath: string, pngPath: string, viewport: { width: number; height: number }): Promise<void> {
  fs.rmSync(pngPath, { force: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-tdl-chrome-'))
  // Chrome headless のレイアウト幅には下限(約500px)があるため、狭幅は iframe で実効ビューポートを再現する
  let target = htmlPath
  if (viewport.width < 500) {
    target = path.join(path.dirname(htmlPath), `_frame-${viewport.width}-${path.basename(htmlPath)}`)
    fs.writeFileSync(target, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}iframe{display:block;border:0;width:${viewport.width}px;height:${viewport.height}px}</style></head><body><iframe src="${path.basename(htmlPath)}" title="viewport"></iframe></body></html>`)
  }
  try {
    await runChrome([
      '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-device-scale-factor=1', '--virtual-time-budget=3000',
      `--window-size=${viewport.width},${viewport.height}`, `--screenshot=${pngPath}`, `file://${target}`,
    ], pngPath)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

export async function renderAll(outDir: string) {
  outDir = assertDesignLabOutputDir(outDir)
  assertFixtureOnlyDesignLabSources()
  fs.mkdirSync(path.join(outDir, 'screenshots'), { recursive: true })
  const files = {} as Record<LabState, string>
  for (const state of LAB_STATES) {
    files[state] = `trigger-discovery-${state}.html`
    fs.writeFileSync(path.join(outDir, files[state]), renderStateHtml(state))
  }
  const extraHtml = [
    { label: 'results + 詳細条件ドロワー/シート', file: 'trigger-discovery-results-drawer.html', options: { drawerOpen: true } },
    { label: 'results + Mobile条件バー展開', file: 'trigger-discovery-results-bar.html', options: { barOpen: true } },
  ]
  for (const e of extraHtml) fs.writeFileSync(path.join(outDir, e.file), renderStateHtml('results', e.options))
  fs.writeFileSync(path.join(outDir, 'trigger-discovery-initial-drawer.html'), renderStateHtml('initial', { drawerOpen: true }))
  extraHtml.push({ label: 'initial + 詳細条件ドロワー/シート', file: 'trigger-discovery-initial-drawer.html', options: { drawerOpen: true } })
  const previewPath = 'preview.html'
  fs.writeFileSync(path.join(outDir, previewPath), renderPreviewIndex(files, extraHtml))

  const screenshots: Array<{ state: LabState; viewport: string; width: number; height: number; path: string }> = []
  for (const state of LAB_STATES) {
    for (const vp of LAB_VIEWPORTS) {
      const rel = `screenshots/${state}-${vp.name}.png`
      await screenshot(path.join(outDir, files[state]), path.join(outDir, rel), vp)
      const size = readPngSize(path.join(outDir, rel))
      if (size.width !== vp.width || size.height !== vp.height) throw new Error(`unexpected size ${rel}: ${size.width}x${size.height}`)
      screenshots.push({ state, viewport: vp.name, width: size.width, height: size.height, path: rel })
    }
  }
  for (const [name, file, vp] of [
    ['drawer-desktop', 'trigger-discovery-results-drawer.html', LAB_VIEWPORTS[0]],
    ['drawer-ipadPortrait', 'trigger-discovery-results-drawer.html', LAB_VIEWPORTS[2]],
    ['drawer-mobile', 'trigger-discovery-results-drawer.html', LAB_VIEWPORTS[3]],
    ['initial-drawer-desktop', 'trigger-discovery-initial-drawer.html', LAB_VIEWPORTS[0]],
    ['initial-drawer-ipadLandscape', 'trigger-discovery-initial-drawer.html', LAB_VIEWPORTS[1]],
    ['initial-drawer-mobile', 'trigger-discovery-initial-drawer.html', LAB_VIEWPORTS[3]],
    ['bar-mobile', 'trigger-discovery-results-bar.html', LAB_VIEWPORTS[3]],
  ] as const) {
    await screenshot(path.join(outDir, file), path.join(outDir, `screenshots/extra-${name}.png`), vp)
  }
  const manifest = {
    version: 1,
    previewPath,
    screenshots,
    isolation: {
      fixtureOnly: true,
      productionApi: false,
      statusProbe: false,
      storageGuard: false,
      database: false,
      launchAgent: false,
    },
  }
  fs.writeFileSync(path.join(outDir, 'ui-design-lab-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function sendText(response: import('node:http').ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Design-Lab-Isolation': 'fixture-only',
  })
  response.end(body)
}

export async function startFixturePreviewServer(options: { outDir: string; port?: number }): Promise<{ server: Server; port: number; url: string }> {
  const outDir = assertDesignLabOutputDir(options.outDir)
  assertFixtureOnlyDesignLabSources()
  if (!fs.existsSync(path.join(outDir, 'preview.html'))) throw new Error('Design Lab preview.html is missing')

  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      sendText(response, 405, 'Method Not Allowed\n')
      return
    }

    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${PREVIEW_HOST}`).pathname)
    } catch {
      sendText(response, 400, 'Bad Request\n')
      return
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      sendText(response, 404, 'Design Lab has no API routes\n')
      return
    }

    const relative = pathname === '/' ? 'preview.html' : pathname.replace(/^\/+/, '')
    const extension = path.extname(relative).toLowerCase()
    if (!PREVIEW_CONTENT_TYPES[extension]) {
      sendText(response, 404, 'Not Found\n')
      return
    }
    const file = path.resolve(outDir, relative)
    if (!file.startsWith(`${outDir}${path.sep}`)) {
      sendText(response, 404, 'Not Found\n')
      return
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      sendText(response, 404, 'Not Found\n')
      return
    }
    if (!stat.isFile()) {
      sendText(response, 404, 'Not Found\n')
      return
    }
    response.writeHead(200, {
      'Content-Type': PREVIEW_CONTENT_TYPES[extension],
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Design-Lab-Isolation': 'fixture-only',
    })
    if (request.method === 'HEAD') response.end()
    else fs.createReadStream(file).pipe(response)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, PREVIEW_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { server, port: address.port, url: `http://${PREVIEW_HOST}:${address.port}/preview.html` }
}

if (process.argv[1]?.endsWith('ui-design-lab-trigger-discovery-render.ts')) {
  const args = process.argv.slice(2)
  const serve = args[0] === '--serve'
  const outDir = serve ? args[1] : args[0]
  if (!outDir || !path.isAbsolute(outDir)) {
    console.error('usage: ui-design-lab-trigger-discovery-render.ts [--serve] <absolute output dir> [--port N]')
    process.exit(2)
  }
  if (serve) {
    const portIndex = args.indexOf('--port')
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 3107
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      console.error('invalid preview port')
      process.exit(2)
    }
    startFixturePreviewServer({ outDir, port }).then((preview) => {
      console.log(`fixture-only preview: ${preview.url}`)
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : 'preview server failed')
      process.exit(1)
    })
  } else {
    renderAll(outDir).then((manifest) => {
      console.log(`rendered ${manifest.screenshots.length} screenshots -> ${outDir}`)
      process.exit(0)
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : 'render failed')
      process.exit(1)
    })
  }
}
