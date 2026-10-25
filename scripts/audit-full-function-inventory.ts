import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

type EvidenceStatus = 'PASS' | 'FAIL' | 'NOT_TESTED'

interface SweepResult {
  script?: string
  name?: string
  status?: string
}

interface InventoryItem {
  kind: 'page' | 'api' | 'component' | 'calculation' | 'job'
  id: string
  file: string | null
  methods?: string[]
  parameters?: string[]
  controls?: Record<string, number>
  controlDetails?: ControlDetail[]
  searchLike?: boolean
  evidence: string[]
  status: EvidenceStatus
}

interface ControlDetail {
  kind: string
  line: number
  label: string | null
  attributes: Record<string, string>
}

const root = process.cwd()
const args = process.argv.slice(2)

function argument(name: string): string | null {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : null
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  const files: string[] = []
  const queue = [directory]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.next')) continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  return files.sort()
}

function relative(file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

function routePath(file: string, prefix: 'app' | 'api'): string {
  const normalized = relative(file)
    .replace(/^app\//, '/')
    .replace(/\/(page|route)\.(tsx|ts)$/, '')
  return prefix === 'api' ? normalized : normalized || '/'
}

function count(source: string, expression: RegExp): number {
  return [...source.matchAll(expression)].length
}

function controls(source: string): Record<string, number> {
  return {
    buttons: count(source, /<button\b/g),
    inputs: count(source, /<input\b/g),
    selects: count(source, /<select\b/g),
    textareas: count(source, /<textarea\b/g),
    forms: count(source, /<form\b/g),
    links: count(source, /<(?:Link|a)\b/g),
    clickHandlers: count(source, /\bonClick\s*=/g),
    changeHandlers: count(source, /\bonChange\s*=/g),
    fetches: count(source, /\bfetch\s*\(/g),
    persistedSettings: count(source, /\b(?:localStorage|sessionStorage)\b/g),
  }
}

const CONTROL_TAG = /^(?:button|input|select|textarea|a|Link|Button|IconButton|Toggle|Switch|Checkbox|Radio|Slider|Tabs?|Menu|Combobox)$/i
const CONTROL_ATTRIBUTES = new Set(['aria-label', 'title', 'name', 'id', 'data-testid', 'type', 'href', 'role'])

function jsxAttributeValue(attribute: ts.JsxAttribute): string {
  if (!attribute.initializer) return 'true'
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text
  if (ts.isJsxExpression(attribute.initializer)) return attribute.initializer.expression?.getText().slice(0, 160) ?? ''
  return attribute.initializer.getText().slice(0, 160)
}

function listControlDetails(file: string, source: string): ControlDetail[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const details: ControlDetail[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const kind = node.tagName.getText(sourceFile)
      if (CONTROL_TAG.test(kind)) {
        const attributes: Record<string, string> = {}
        for (const property of node.attributes.properties) {
          if (!ts.isJsxAttribute(property)) continue
          const name = property.name.getText(sourceFile)
          if (CONTROL_ATTRIBUTES.has(name) || name === 'onClick' || name === 'onChange') {
            attributes[name] = jsxAttributeValue(property)
          }
        }
        let label = attributes['aria-label'] ?? attributes.title ?? attributes.name ?? attributes['data-testid'] ?? null
        if (!label && ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent)) {
          const text = node.parent.children
            .filter(ts.isJsxText)
            .map((child) => child.text.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' ')
          if (text) label = text.slice(0, 160)
        }
        details.push({
          kind,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          label,
          attributes,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return details
}

function apiMethods(source: string): string[] {
  const methods = new Set<string>()
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
    methods.add(match[1])
  }
  for (const match of source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
    methods.add(match[1])
  }
  return [...methods].sort()
}

function apiParameters(source: string): string[] {
  const parameters = new Set<string>()
  for (const match of source.matchAll(/(?:searchParams|params)\.get\(\s*['"]([^'"]+)['"]\s*\)/g)) parameters.add(match[1])
  for (const match of source.matchAll(/(?:searchParams|params)\.getAll\(\s*['"]([^'"]+)['"]\s*\)/g)) parameters.add(match[1])
  for (const match of source.matchAll(/\bbody\.([A-Za-z_$][\w$]*)/g)) parameters.add(`body:${match[1]}`)
  for (const match of source.matchAll(/\bbody\[['"]([^'"]+)['"]\]/g)) parameters.add(`body:${match[1]}`)
  for (const match of source.matchAll(/\{\s*params\s*\}\s*:\s*\{[^}]*params\s*:\s*(?:Promise<)?\{([^}]+)\}/g)) {
    for (const field of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*[?:]/g)) parameters.add(`path:${field[1]}`)
  }
  return [...parameters].sort()
}

function loadSweep(file: string | null): Map<string, EvidenceStatus> {
  const statuses = new Map<string, EvidenceStatus>()
  if (!file || !fs.existsSync(file)) return statuses
  const parsed = JSON.parse(read(file)) as { results?: SweepResult[] } | SweepResult[]
  const results = Array.isArray(parsed) ? parsed : parsed.results ?? []
  for (const result of results) {
    const name = path.basename(result.script ?? result.name ?? '')
    if (!name) continue
    statuses.set(name, result.status === 'PASS' ? 'PASS' : result.status === 'FAIL' ? 'FAIL' : 'NOT_TESTED')
  }
  return statuses
}

const sweepStatuses = loadSweep(argument('--sweep'))
const testFiles = walk(path.join(root, 'scripts')).filter((file) => /(^|\/)test[-_].+\.(ts|tsx|py)$/.test(file))
const testSources = testFiles.map((file) => ({ file, name: path.basename(file), source: read(file) }))

function evidenceFor(file: string, publicPath: string): { tests: string[]; status: EvidenceStatus } {
  const rel = relative(file)
  const basename = path.basename(path.dirname(file))
  const tokens = new Set([rel, publicPath, publicPath.replace(/\[[^\]]+\]/g, ''), basename])
  const tests = testSources
    .filter((test) => [...tokens].some((token) => token.length >= 4 && test.source.includes(token)))
    .map((test) => test.name)
  if (tests.some((test) => sweepStatuses.get(test) === 'FAIL')) return { tests, status: 'FAIL' }
  if (tests.some((test) => sweepStatuses.get(test) === 'PASS')) return { tests, status: 'PASS' }
  return { tests, status: 'NOT_TESTED' }
}

const pageFiles = walk(path.join(root, 'app')).filter((file) => /\/page\.tsx?$/.test(file))
const apiFiles = walk(path.join(root, 'app', 'api')).filter((file) => /\/route\.ts$/.test(file))
const componentFiles = walk(path.join(root, 'components')).filter((file) => /\.(ts|tsx)$/.test(file))
const libFiles = walk(path.join(root, 'lib')).filter((file) => /\.(ts|tsx)$/.test(file))
const scriptFiles = walk(path.join(root, 'scripts')).filter((file) => /\.(ts|tsx|py)$/.test(file))

const items: InventoryItem[] = []

for (const file of pageFiles) {
  const id = routePath(file, 'app')
  const source = read(file)
  const evidence = evidenceFor(file, id)
  items.push({
    kind: 'page', id, file: relative(file), controls: controls(source), controlDetails: listControlDetails(file, source),
    evidence: evidence.tests, status: evidence.status,
  })
}

const searchPattern = /(?:search|screener|transition|analog|similar|period|backtest|ranking|candidate|explorer)/i
for (const file of apiFiles) {
  const id = routePath(file, 'api')
  const source = read(file)
  const evidence = evidenceFor(file, id)
  items.push({
    kind: 'api', id, file: relative(file), methods: apiMethods(source), parameters: apiParameters(source),
    searchLike: searchPattern.test(id) || /\b(?:LIKE|ORDER BY|LIMIT|OFFSET|MATCH)\b/i.test(source),
    evidence: evidence.tests, status: evidence.status,
  })
}

for (const file of componentFiles) {
  const source = read(file)
  const controlCounts = controls(source)
  if (Object.values(controlCounts).every((value) => value === 0)) continue
  const id = relative(file)
  const evidence = evidenceFor(file, id)
  items.push({
    kind: 'component', id, file: id, controls: controlCounts, controlDetails: listControlDetails(file, source),
    evidence: evidence.tests, status: evidence.status,
  })
}

const calculationPattern = /(?:stage|momentum|physical|sma|moving-average|timeframe|two-year|analog|similar|backtest|screen|signal|feature|valuation|financial)/i
for (const file of libFiles.filter((candidate) => calculationPattern.test(relative(candidate)))) {
  const id = relative(file)
  const evidence = evidenceFor(file, id)
  items.push({ kind: 'calculation', id, file: id, evidence: evidence.tests, status: evidence.status })
}

const pkg = JSON.parse(read(path.join(root, 'package.json'))) as { scripts?: Record<string, string> }
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  if (!/^(?:batch|update|backfill|maintenance|audit|trigger|large-holders|storage|web|ml|backup):|(?:install|worker|scheduler|refresh|generate|build)/i.test(`${name} ${command}`)) continue
  const referenced = scriptFiles.find((file) => command.includes(relative(file))) ?? null
  const evidence = referenced ? evidenceFor(referenced, name) : { tests: [] as string[], status: 'NOT_TESTED' as const }
  items.push({ kind: 'job', id: name, file: referenced ? relative(referenced) : null, evidence: evidence.tests, status: evidence.status })
}

const byKind = Object.fromEntries(['page', 'api', 'component', 'calculation', 'job'].map((kind) => {
  const group = items.filter((item) => item.kind === kind)
  return [kind, {
    total: group.length,
    PASS: group.filter((item) => item.status === 'PASS').length,
    FAIL: group.filter((item) => item.status === 'FAIL').length,
    NOT_TESTED: group.filter((item) => item.status === 'NOT_TESTED').length,
  }]
}))
const totals = {
  total: items.length,
  PASS: items.filter((item) => item.status === 'PASS').length,
  FAIL: items.filter((item) => item.status === 'FAIL').length,
  NOT_TESTED: items.filter((item) => item.status === 'NOT_TESTED').length,
}
const controlUnitCount = items.reduce((sum, item) => sum + (item.controlDetails?.length ?? 0), 0)

const output = {
  generatedAt: new Date().toISOString(),
  head: process.env.GIT_COMMIT ?? null,
  coverageBasis: 'A PASS requires a direct textual test reference and a PASS in the supplied isolated sweep. Missing or indirect evidence remains NOT_TESTED.',
  counts: { pages: pageFiles.length, apiRoutes: apiFiles.length, testFiles: testFiles.length, controlUnits: controlUnitCount, ...totals, byKind },
  apiMethodCounts: Object.fromEntries(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => [
    method,
    items.filter((item) => item.kind === 'api' && item.methods?.includes(method)).length,
  ])),
  searchLikeApis: items.filter((item) => item.kind === 'api' && item.searchLike).map((item) => item.id),
  items,
}

const outDir = argument('--out')
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'function-inventory.json'), `${JSON.stringify(output, null, 2)}\n`)
  const rows = Object.entries(byKind).map(([kind, value]) => {
    const summary = value as { total: number; PASS: number; FAIL: number; NOT_TESTED: number }
    return `| ${kind} | ${summary.total} | ${summary.PASS} | ${summary.FAIL} | ${summary.NOT_TESTED} |`
  })
  fs.writeFileSync(path.join(outDir, 'function-inventory.md'), [
    '# StockBoard Function Inventory', '',
    `Generated: ${output.generatedAt}`, '',
    '| Kind | Total | PASS | FAIL | NOT_TESTED |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows, '',
    `Total: ${totals.total}; PASS ${totals.PASS}; FAIL ${totals.FAIL}; NOT_TESTED ${totals.NOT_TESTED}.`, '',
    `Search-like APIs: ${output.searchLikeApis.length}.`, '',
    '> PASS is intentionally conservative: direct test reference plus an isolated PASS is required.', '',
  ].join('\n'))
}

console.log(JSON.stringify(output.counts, null, 2))
