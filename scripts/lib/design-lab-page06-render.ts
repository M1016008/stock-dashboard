import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PAGE } from '@/components/reports/design-lab/page06/layout'
import type { Page06NarrativeSource } from '@/components/reports/design-lab/page06/NarrativePanel'
import { Page06MomentumMatrix } from '@/components/reports/design-lab/page06/Page06MomentumMatrix'
import type { DailyCloseReport } from '@/lib/daily-close-report'
import type { MomentumMatrixModel } from '@/lib/daily-close-momentum-matrix'
import { validatePage06Narrative, type Page06ClaudeInput, type Page06Narrative } from '@/lib/daily-close-page06-narrative-content'

// Page 06 Design Lab「レンダリング」層。
// snapshot (データ + 判定結果 + Narrative) → HTML → PDF / PNG。DB・Claude には触れない。
// Chrome headless の起動条件は既存 Daily Close PDF (lib/server/daily-close-mail-pdf.ts) と揃える:
// --headless=new / --no-pdf-header-footer / 一時 user-data-dir / @page A4 landscape。

export const SNAPSHOT_VERSION = 1

export type Page06Snapshot = {
  version: typeof SNAPSHOT_VERSION
  reportDate: string
  generatedAt: string
  dataStatus: DailyCloseReport['dataStatus']
  constraints: Record<string, string>
  model: MomentumMatrixModel
  claudeInput: Page06ClaudeInput
  narrative:
    | { source: 'claude-code-subscription'; model: string | null; durationMs: number | null; text: Page06Narrative }
    | { source: 'deterministic'; fallbackReason: string; fallbackDetail: string | null; text: Page06Narrative }
  deterministicFallback: Page06Narrative
}

export type RenderVariant = 'claude' | 'deterministic'

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_TIMEOUT_MS = 60_000
const PNG_SCALE = 2

export function baseName(reportDate: string, variant: RenderVariant): string {
  return `page06-momentum-matrix-${reportDate}${variant === 'deterministic' ? '-deterministic' : ''}`
}

export function readSnapshot(file: string): Page06Snapshot {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as Page06Snapshot
  if (snapshot.version !== SNAPSHOT_VERSION) throw new Error(`unsupported snapshot version: ${snapshot.version}`)
  // Claude 文章を手で編集した場合も、入力外の数値・分類名が混ざっていないことを再検証する
  if (snapshot.narrative.source === 'claude-code-subscription') {
    const validated = validatePage06Narrative(snapshot.narrative.text, snapshot.claudeInput, snapshot.model.points.map((point) => point.name))
    if (!validated.ok) throw new Error(`snapshot narrative failed validation: ${validated.reason}`)
  }
  return snapshot
}

export function renderPage06Html(snapshot: Page06Snapshot, variant: RenderVariant): string {
  const narrative = variant === 'deterministic' ? snapshot.deterministicFallback : snapshot.narrative.text
  const narrativeSource: Page06NarrativeSource = variant === 'deterministic'
    ? { kind: 'deterministic', reason: null }
    : snapshot.narrative.source === 'deterministic'
      ? { kind: 'deterministic', reason: snapshot.narrative.fallbackReason }
      : { kind: 'claude', model: snapshot.narrative.model }
  const element = createElement(Page06MomentumMatrix, { model: snapshot.model, narrative, narrativeSource, generatedAt: snapshot.generatedAt })
  return `<!doctype html>\n${renderToStaticMarkup(element)}\n`
}

// Chrome headless は出力後もプロセスが残ることがあるため、出力ファイルのサイズが安定したら終了させる
function runChromeUntilFile(args: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.STOCKBOARD_CHROME_PATH ?? DEFAULT_CHROME_PATH, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let settled = false
    let lastSize = -1
    let stableChecks = 0
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000) })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(poll)
      if (child.exitCode == null) child.kill('SIGKILL')
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error(`Chrome render timed out: ${path.basename(outputPath)}`)), CHROME_TIMEOUT_MS)
    const poll = setInterval(() => {
      try {
        const size = fs.statSync(outputPath).size
        stableChecks = size > 1_000 && size === lastSize ? stableChecks + 1 : 0
        lastSize = size
        if (stableChecks >= 4) finish()
      } catch {
        stableChecks = 0
      }
    }, 250)
    child.once('error', () => finish(new Error('Chrome is unavailable')))
    child.once('exit', (code) => {
      if (settled) return
      if (fs.existsSync(outputPath)) finish()
      else finish(new Error(`Chrome exited (${code ?? 'signal'}) without output: ${stderr.replace(/\s+/g, ' ').trim().slice(0, 200)}`))
    })
  })
}

async function withChromeProfile<T>(task: (profileDir: string) => Promise<T>): Promise<T> {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-design-lab-chrome-'))
  try {
    return await task(profileDir)
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
}

function baseChromeArgs(profileDir: string): string[] {
  return ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profileDir}`, '--virtual-time-budget=5000']
}

export function countPdfPages(bytes: Buffer): number {
  return bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0
}

export async function renderPdf(htmlPath: string, pdfPath: string): Promise<{ pages: number }> {
  fs.rmSync(pdfPath, { force: true })
  await withChromeProfile((profileDir) => runChromeUntilFile([
    ...baseChromeArgs(profileDir), '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], pdfPath))
  const bytes = fs.readFileSync(pdfPath)
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('generated file is not a PDF')
  return { pages: countPdfPages(bytes) }
}

export async function renderPng(htmlPath: string, pngPath: string): Promise<void> {
  fs.rmSync(pngPath, { force: true })
  await withChromeProfile((profileDir) => runChromeUntilFile([
    ...baseChromeArgs(profileDir), '--hide-scrollbars', `--force-device-scale-factor=${PNG_SCALE}`,
    `--window-size=${PAGE.viewportWidthPx},${PAGE.viewportHeightPx}`, `--screenshot=${pngPath}`, `file://${htmlPath}`,
  ], pngPath))
}

export async function renderSnapshot(snapshot: Page06Snapshot, outDir: string): Promise<Record<RenderVariant, { html: string; pdf: string; png: string; pdfPages: number }>> {
  fs.mkdirSync(outDir, { recursive: true })
  const result = {} as Record<RenderVariant, { html: string; pdf: string; png: string; pdfPages: number }>
  for (const variant of ['claude', 'deterministic'] as const) {
    const name = baseName(snapshot.reportDate, variant)
    const html = path.join(outDir, `${name}.html`)
    const pdf = path.join(outDir, `${name}.pdf`)
    const png = path.join(outDir, `${name}.png`)
    fs.writeFileSync(html, renderPage06Html(snapshot, variant))
    const { pages } = await renderPdf(html, pdf)
    await renderPng(html, png)
    result[variant] = { html, pdf, png, pdfPages: pages }
  }
  return result
}
