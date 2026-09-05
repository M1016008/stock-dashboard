import type { FinancialOverviewValue } from '@/lib/server/financial-overview-read-model'

export type FinancialSummaryFormat = 'percent' | 'multiple' | 'currency' | 'per_share'

export interface FormattedFinancialSummaryValue {
  text: string
  availability: FinancialOverviewValue['availability'] | 'loading'
  reason: string | null
}

export interface MaAngleSummaryInput {
  ma5Angle: number | null
  ma25Angle: number | null
  ma75Angle: number | null
  ma200Angle: number | null
}

export interface StockDecisionSummaryUrls {
  financial: string
  physical: string
  sector: string
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}兆円`
  if (absolute >= 1e8) return `${(value / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}億円`
  if (absolute >= 1e4) return `${(value / 1e4).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}万円`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円`
}

function isNotMeaningfulReason(code: string | undefined): boolean {
  return Boolean(code && (code.includes('_nm') || code.includes('non_positive')))
}

export function formatFinancialSummaryValue(
  point: FinancialOverviewValue | null | undefined,
  format: FinancialSummaryFormat,
  options: { forecast?: boolean; signed?: boolean } = {},
): FormattedFinancialSummaryValue {
  if (!point) return { text: '—', availability: 'loading', reason: null }
  if (point.availability === 'not_applicable') {
    return { text: 'N/A', availability: point.availability, reason: point.reason?.message ?? '適用外です。' }
  }
  if (point.availability !== 'available' || point.value == null || !Number.isFinite(point.value)) {
    const code = point.reason?.code
    const text = options.forecast && code?.includes('no_current_fy_forecast')
      ? '予想なし'
      : isNotMeaningfulReason(code)
        ? 'N/M'
        : '—'
    return { text, availability: point.availability, reason: point.reason?.message ?? 'データがありません。' }
  }

  const value = point.value
  if (format === 'percent') {
    return {
      text: `${options.signed && value > 0 ? '+' : ''}${value.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`,
      availability: 'available',
      reason: null,
    }
  }
  if (format === 'multiple') {
    return {
      text: `${value.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}倍`,
      availability: 'available',
      reason: null,
    }
  }
  if (format === 'per_share') {
    return {
      text: `${value.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}円`,
      availability: 'available',
      reason: null,
    }
  }
  return { text: compactNumber(value), availability: 'available', reason: null }
}

export function buildStockDecisionSummaryUrls(
  rawTicker: string,
  analysisDate: string | null,
  universe: string | null = null,
): StockDecisionSummaryUrls {
  const ticker = rawTicker.replace(/\.T$/i, '')
  const financialParams = new URLSearchParams()
  const physicalParams = new URLSearchParams({ market: 'JP', limit: '40' })
  const sectorParams = new URLSearchParams({ taxonomy: '33' })
  if (analysisDate) {
    financialParams.set('as_of', analysisDate)
    physicalParams.set('date', analysisDate)
    sectorParams.set('date', analysisDate)
  }
  if (universe) sectorParams.set('universe', universe)
  const financialQuery = financialParams.toString()
  return {
    financial: `/api/financial-overview/${encodeURIComponent(ticker)}${financialQuery ? `?${financialQuery}` : ''}`,
    physical: `/api/physical-momentum/${encodeURIComponent(ticker)}?${physicalParams.toString()}`,
    sector: `/api/sectors/stock-context/${encodeURIComponent(ticker)}?${sectorParams.toString()}`,
  }
}

function angleDegrees(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return value * 180 / Math.PI
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export function summarizeMaStructure(input: MaAngleSummaryInput | null | undefined): string {
  if (!input) return 'MA構造未判定'
  const short = [angleDegrees(input.ma5Angle), angleDegrees(input.ma25Angle)]
    .filter((value): value is number => value != null)
  const long = [angleDegrees(input.ma75Angle), angleDegrees(input.ma200Angle)]
    .filter((value): value is number => value != null)
  const all = [...short, ...long]
  if (all.length < 3) return 'MA構造未判定'

  const shortMean = mean(short)
  const longMean = mean(long)
  const positive = all.filter((value) => value > 0.2).length
  const negative = all.filter((value) => value < -0.2).length
  if (shortMean != null && longMean != null && shortMean > 0.2 && longMean > 0.2 && positive >= 3) return '上方向へ拡散'
  if (shortMean != null && longMean != null && shortMean < -0.2 && longMean < -0.2 && negative >= 3) return '下方向へ拡散'
  if (shortMean != null && longMean != null && shortMean > 0.2 && longMean < -0.2) return '短期上向き・長期収縮'
  if (shortMean != null && longMean != null && shortMean < -0.2 && longMean > 0.2) return '短期調整・長期残存'
  if (positive > 0 && negative > 0) return '時間軸がねじれ'
  return 'MA構造は中立'
}
