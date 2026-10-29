import fs from 'node:fs'
import path from 'node:path'
import {
  assessJpOhlcvConflictLineage,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

type ProviderRow = {
  Date: string
  Code: string
  O: number | null
  H: number | null
  L: number | null
  C: number | null
  Vo: number | null
  AdjFactor: number | null
  AdjO: number | null
  AdjH: number | null
  AdjL: number | null
  AdjC: number | null
  AdjVo: number | null
}

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function absolute(flag: string): string {
  const result = value(flag)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function existingRows(file: string): JpOhlcvValue[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (Array.isArray(parsed)) return parsed as JpOhlcvValue[]
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)) {
    return (parsed as { rows: JpOhlcvValue[] }).rows
  }
  throw new Error('existing_rows_missing')
}

async function providerRows(code: string, from: string, to: string): Promise<ProviderRow[]> {
  const key = process.env.JQUANTS_API_KEY
  if (!key) throw new Error('JQUANTS_API_KEY_required')
  const rows: ProviderRow[] = []
  let paginationKey: string | null = null
  do {
    const url = new URL('https://api.jquants.com/v2/equities/bars/daily')
    url.searchParams.set('code', code)
    url.searchParams.set('from', from)
    url.searchParams.set('to', to)
    if (paginationKey) url.searchParams.set('pagination_key', paginationKey)
    const response = await fetch(url, { headers: { 'x-api-key': key } })
    if (!response.ok) throw new Error(`jquants_conflict_audit_http_${response.status}`)
    const body = await response.json() as { data?: ProviderRow[]; pagination_key?: string }
    rows.push(...(body.data ?? []))
    paginationKey = body.pagination_key ?? null
  } while (paginationKey)
  return rows.sort((left, right) => left.Date.localeCompare(right.Date))
}

async function main(): Promise<void> {
  const date = value('--date')
  const codes = [...new Set(value('--codes').split(',').map((entry) => entry.trim()).filter(Boolean))].sort()
  const existing = existingRows(absolute('--existing-json'))
  const output = absolute('--output')
  const requestedAt = new Date().toISOString()
  const evidence = []
  for (const code of codes) {
    const rows = await providerRows(code, value('--from'), value('--to'))
    const target = rows.find((row) => row.Date === date)
    const stored = existing.find((row) => row.ticker === code && row.date === date)
    if (!target || !stored || target.AdjO == null || target.AdjH == null || target.AdjL == null
      || target.AdjC == null || target.AdjVo == null) throw new Error(`conflict_evidence_missing:${code}`)
    const official: JpOfficialOhlcvValue = {
      ticker: code,
      date,
      open: target.AdjO,
      high: target.AdjH,
      low: target.AdjL,
      close: target.AdjC,
      volume: Math.round(target.AdjVo),
      adjustmentFactor: target.AdjFactor ?? 1,
    }
    const actions = rows.filter((row) => row.Date > date && row.AdjFactor != null && Math.abs(row.AdjFactor - 1) > Number.EPSILON)
    evidence.push({
      code,
      targetRaw: { open: target.O, high: target.H, low: target.L, close: target.C, volume: target.Vo },
      targetAdjusted: official,
      productionExisting: stored,
      laterCorporateActions: actions.map((row) => ({ date: row.Date, adjustmentFactor: row.AdjFactor })),
      assessment: assessJpOhlcvConflictLineage({
        existing: stored,
        currentOfficial: official,
        laterAdjustmentFactors: actions.map((row) => row.AdjFactor ?? 1),
      }),
      providerSeriesSha256: stableSha256(rows.map((row) => ({
        Date: row.Date, Code: row.Code, O: row.O, H: row.H, L: row.L, C: row.C, Vo: row.Vo,
        AdjFactor: row.AdjFactor, AdjO: row.AdjO, AdjH: row.AdjH, AdjL: row.AdjL, AdjC: row.AdjC, AdjVo: row.AdjVo,
      }))),
    })
  }
  const report = {
    version: 1,
    requestedAt,
    completedAt: new Date().toISOString(),
    endpoint: '/v2/equities/bars/daily',
    date,
    evidence,
    secretMaterialPersisted: false,
    disposition: 'PRESERVE_EXISTING_HOLD',
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ output, reportSha256: stableSha256(report), conflicts: evidence.length }))
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
