import { unzipSync } from 'fflate'

const API_BASE = 'https://api.edinet-fsa.go.jp/api/v2'
const DEFAULT_MAX_ATTEMPTS = Math.max(1, Number(process.env.EDINET_MAX_ATTEMPTS ?? 5))
const REQUEST_TIMEOUT_MS = Math.max(10_000, Number(process.env.EDINET_REQUEST_TIMEOUT_MS ?? 120_000))

export interface EdinetDocumentIndexRow {
  docID: string
  edinetCode?: string | null
  secCode?: string | null
  filerName?: string | null
  docTypeCode?: string | null
  submitDateTime?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  withdrawalStatus?: string | null
  xbrlFlag?: string | null
}

function apiKey(): string {
  const value = process.env.EDINET_API_KEY?.trim()
  if (!value) throw new Error('EDINET_API_KEY is not configured')
  return value
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class EdinetHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

async function edinetFetch(url: string, label: string): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (response.ok) return response
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === DEFAULT_MAX_ATTEMPTS) {
        throw new EdinetHttpError(`${label}: HTTP ${response.status}`, retryable)
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 750 * (2 ** (attempt - 1)))
      await sleep(delay)
    } catch (error) {
      lastError = error
      if (error instanceof EdinetHttpError && !error.retryable) throw error
      if (attempt === DEFAULT_MAX_ATTEMPTS) break
      await sleep(Math.min(30_000, 750 * (2 ** (attempt - 1))))
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
  throw new Error(`${label}: request failed after ${DEFAULT_MAX_ATTEMPTS} attempts (${detail})`)
}

export async function listEdinetDocuments(date: string): Promise<EdinetDocumentIndexRow[]> {
  const params = new URLSearchParams({ date, type: '2', 'Subscription-Key': apiKey() })
  const response = await edinetFetch(
    `${API_BASE}/documents.json?${params}`,
    `EDINET documents date=${date}`,
  )
  const payload = await response.json() as { results?: EdinetDocumentIndexRow[] }
  return payload.results ?? []
}

export async function downloadEdinetPublicXbrl(
  documentId: string,
  maxArchiveBytes = 80 * 1024 * 1024,
): Promise<string> {
  const params = new URLSearchParams({ type: '1', 'Subscription-Key': apiKey() })
  const response = await edinetFetch(
    `${API_BASE}/documents/${encodeURIComponent(documentId)}?${params}`,
    `EDINET document ${documentId}`,
  )
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > maxArchiveBytes) throw new Error(`EDINET archive too large: ${contentLength} bytes`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxArchiveBytes) throw new Error(`EDINET archive too large: ${bytes.byteLength} bytes`)
  const files = unzipSync(bytes, {
    filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name),
  })
  const xbrl = Object.entries(files).sort((left, right) => right[1].byteLength - left[1].byteLength)[0]
  if (!xbrl) throw new Error(`EDINET document ${documentId}: PublicDoc XBRL not found`)
  return new TextDecoder('utf-8').decode(xbrl[1])
}

export function tickerFromEdinetSecurityCode(secCode?: string | null): string | null {
  const value = secCode?.trim() ?? ''
  if (!/^[0-9A-Z]{5}$/.test(value)) return null
  return value.endsWith('0') ? value.slice(0, -1) : value
}

export function isAnnualSecuritiesReport(document: EdinetDocumentIndexRow): boolean {
  return ['120', '130'].includes(document.docTypeCode ?? '')
    && document.withdrawalStatus !== '1'
    && document.xbrlFlag === '1'
    && tickerFromEdinetSecurityCode(document.secCode) != null
}
