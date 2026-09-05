import { execAll, execGet } from '@/lib/db/client'
import { getCurrentSimilars } from '@/lib/queries/ml-insights'
import { getSectorStructureBoard } from '@/lib/queries/sectors'
import { getFinancialOverviewReadModel, type FinancialOverviewValue } from '@/lib/server/financial-overview-read-model'
import { getShareholderReturnsReadModel } from '@/lib/server/shareholder-returns-read-model'
import type { ShareholderReturnValue } from '@/lib/shareholder-returns'
import type {
  ComparisonAvailability,
  ComparisonCompany,
  ComparisonDistribution,
  ComparisonMetricKey,
  ComparisonValue,
  SimilarityCandidate,
  SimilarityCandidateGroup,
  SimilarityComparisonReadModel,
} from '@/lib/similarity-comparison'

const CACHE_TTL_MS = 60_000
const MAX_SELECTED = 8
const CANDIDATE_LIMIT = 6
const FINANCIAL_PATTERN = /銀行|保険|証券|金融/

type ProfileFeatureRow = {
  ticker: string
  name: string | null
  active: number
  marketSegment: string | null
  sector33Code: string | null
  sector33Name: string | null
  custom60Name: string | null
  subIndustry: string | null
  sharesOutstanding: number | null
  price: number | null
  forwardPer: number | null
  pbr: number | null
  psr: number | null
  fcfYield: number | null
  evEbitda: number | null
  roe: number | null
  revenueGrowth: number | null
}

type StructureRow = {
  ticker: string
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
  snapshotDate: string | null
  pms: number | null
  pfs: number | null
  physicalDate: string | null
}

type FinancialFeatureKey = 'revenueScale' | 'revenueGrowth' | 'roe' | 'pbr' | 'forwardPer' | 'fcfYield'

type FinancialFeature = {
  key: FinancialFeatureKey
  label: string
  weight: number
  value: (row: ProfileFeatureRow) => number | null
}

const FINANCIAL_FEATURES: FinancialFeature[] = [
  {
    key: 'revenueScale',
    label: '売上規模',
    weight: 1,
    value: (row) => {
      const marketCap = finite(row.price) && finite(row.sharesOutstanding) ? row.price * row.sharesOutstanding : null
      return marketCap != null && marketCap > 0 && finite(row.psr) && row.psr > 0
        ? Math.log10(marketCap / row.psr)
        : null
    },
  },
  { key: 'revenueGrowth', label: '売上成長率', weight: 1.2, value: (row) => numeric(row.revenueGrowth) },
  { key: 'roe', label: 'ROE', weight: 1.1, value: (row) => numeric(row.roe) },
  { key: 'pbr', label: 'PBR', weight: 0.8, value: (row) => positive(row.pbr) },
  { key: 'forwardPer', label: 'Forward PER', weight: 0.9, value: (row) => positive(row.forwardPer) },
  { key: 'fcfYield', label: 'FCF Yield', weight: 0.9, value: (row) => numeric(row.fcfYield) },
]

const modelCache = new Map<string, { expiresAt: number; value: SimilarityComparisonReadModel }>()

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numeric(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function positive(value: unknown): number | null {
  const parsed = numeric(value)
  return parsed != null && parsed > 0 ? parsed : null
}

function isFinancialProfile(row: ProfileFeatureRow): boolean {
  return FINANCIAL_PATTERN.test(`${row.sector33Name ?? ''} ${row.custom60Name ?? ''}`)
}

function quantile(values: number[], ratio: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function round(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function profileStageCode(row: StructureRow | undefined): string | null {
  if (!row) return null
  const values = [row.dailyA, row.dailyB, row.weeklyA, row.weeklyB, row.monthlyA, row.monthlyB]
  return values.every((value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6)
    ? values.join('')
    : null
}

function unavailable(
  reason: string,
  availability: Exclude<ComparisonAvailability, 'available'> = 'missing',
  source = 'read-model',
): ComparisonValue {
  return { value: null, unit: null, availability, reason, source, asOf: null }
}

function available(value: number, unit: string, source: string, asOf: string | null): ComparisonValue {
  return { value, unit, availability: 'available', reason: null, source, asOf }
}

function fromOverview(value: FinancialOverviewValue, source = 'financial-overview'): ComparisonValue {
  if (value.value == null || value.availability !== 'available') {
    return unavailable(
      value.reason?.message ?? '比較可能な値がありません。',
      value.availability === 'not_applicable' ? 'not_applicable' : 'missing',
      source,
    )
  }
  return available(value.value, value.unit ?? 'NUMBER', source, value.publishedAt ?? value.periodEnd)
}

function fromReturn(value: ShareholderReturnValue, source = 'shareholder-returns'): ComparisonValue {
  if (value.value == null || value.availability !== 'available') {
    const availability = value.availability === 'available' ? 'missing' : value.availability
    return unavailable(value.reason ?? '比較可能な値がありません。', availability, source)
  }
  return available(value.value, value.unit ?? 'NUMBER', source, value.publishedAt ?? value.periodEnd)
}

function fromServing(
  value: number | null,
  unit: string,
  asOf: string | null,
  options: { financialSector?: boolean; positiveOnly?: boolean } = {},
): ComparisonValue {
  if (options.financialSector) {
    return unavailable('金融業では通常企業向け指標を適用しません。', 'not_applicable', 'valuation-serving')
  }
  if (value == null || !Number.isFinite(value)) return unavailable('指定日時点のServing値がありません。', 'missing', 'valuation-serving')
  if (options.positiveOnly && value <= 0) return unavailable('分母または利益が正数でないためN/Mです。', 'not_meaningful', 'valuation-serving')
  return available(value, unit, 'valuation-serving', asOf)
}

function normalizeSelected(ticker: string, selected: string[] | undefined, allowed: Set<string>, fallback: string[]): string[] {
  const source = selected?.length ? selected : fallback
  const output = [ticker]
  for (const value of source) {
    const normalized = value.toUpperCase().replace(/\.T$/i, '')
    if (!allowed.has(normalized) || output.includes(normalized)) continue
    output.push(normalized)
    if (output.length >= MAX_SELECTED) break
  }
  return output
}

function featureScales(rows: ProfileFeatureRow[]) {
  return new Map(FINANCIAL_FEATURES.map((feature) => {
    const values = rows.map(feature.value).filter((value): value is number => value != null)
    const q25 = quantile(values, 0.25)
    const q75 = quantile(values, 0.75)
    const scale = q25 != null && q75 != null && q75 > q25 ? q75 - q25 : 1
    return [feature.key, scale] as const
  }))
}

function financialSimilarity(
  base: ProfileFeatureRow,
  candidate: ProfileFeatureRow,
  scales: Map<FinancialFeatureKey, number>,
) {
  let weightedDistance = 0
  let usedWeight = 0
  const totalWeight = FINANCIAL_FEATURES.reduce((sum, feature) => sum + feature.weight, 0)
  const contributions: Array<{ label: string; distance: number }> = []
  for (const feature of FINANCIAL_FEATURES) {
    const left = feature.value(base)
    const right = feature.value(candidate)
    if (left == null || right == null) continue
    const distance = Math.min(4, Math.abs(left - right) / (scales.get(feature.key) ?? 1))
    weightedDistance += distance * feature.weight
    usedWeight += feature.weight
    contributions.push({ label: feature.label, distance })
  }
  if (usedWeight < totalWeight * 0.3) return null
  const distance = weightedDistance / usedWeight
  const coverage = usedWeight / totalWeight
  const score = 100 * Math.exp(-0.85 * distance) * (0.4 + 0.6 * coverage)
  const closest = contributions.sort((a, b) => a.distance - b.distance).slice(0, 2).map((item) => item.label)
  return {
    score: round(Math.max(0, Math.min(100, score)), 1),
    coveragePercent: round(coverage * 100, 0),
    reason: closest.length > 0 ? `${closest.join('・')}が近い` : '共通指標による類似',
  }
}

function candidateFromProfile(
  row: ProfileFeatureRow,
  similarity: ReturnType<typeof financialSimilarity>,
  reason?: string,
): SimilarityCandidate {
  return {
    ticker: row.ticker,
    name: row.name,
    sector33: row.sector33Name,
    custom60: row.custom60Name,
    subIndustry: row.subIndustry,
    score: similarity?.score ?? null,
    coveragePercent: similarity?.coveragePercent ?? null,
    reason: reason ?? similarity?.reason ?? '分類が一致',
    stageCode: null,
  }
}

function sortBySimilarity(
  rows: ProfileFeatureRow[],
  base: ProfileFeatureRow,
  scales: Map<FinancialFeatureKey, number>,
) {
  return rows
    .filter((row) => row.ticker !== base.ticker)
    .map((row) => ({ row, similarity: financialSimilarity(base, row, scales) }))
    .sort((left, right) => (
      (right.similarity?.score ?? -1) - (left.similarity?.score ?? -1)
      || left.row.ticker.localeCompare(right.row.ticker)
    ))
}

function distribution(metric: ComparisonMetricKey, values: Array<number | null>, peerCount: number): ComparisonDistribution {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value))
  return {
    metric,
    validCount: valid.length,
    peerCount,
    percentile25: round(quantile(valid, 0.25)),
    median: round(quantile(valid, 0.5)),
    percentile75: round(quantile(valid, 0.75)),
  }
}

async function loadStructureRows(tickers: string[], asOf: string): Promise<Map<string, StructureRow>> {
  if (tickers.length === 0) return new Map()
  const placeholders = tickers.map(() => '?').join(',')
  const rows = await execAll<StructureRow>(`
    SELECT
      u.ticker,
      ds.daily_a_stage AS dailyA,
      ds.daily_b_stage AS dailyB,
      ds.weekly_a_stage AS weeklyA,
      ds.weekly_b_stage AS weeklyB,
      ds.monthly_a_stage AS monthlyA,
      ds.monthly_b_stage AS monthlyB,
      ds.date AS snapshotDate,
      pm.physical_momentum_score AS pms,
      pm.physical_force_score AS pfs,
      pm.date AS physicalDate
    FROM ticker_universe u
    LEFT JOIN daily_snapshots ds
      ON ds.ticker = u.ticker
     AND ds.date = (SELECT MAX(d.date) FROM daily_snapshots d WHERE d.ticker = u.ticker AND d.date <= ?)
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'JP' AND pm.symbol = u.ticker
     AND pm.date = (SELECT MAX(p.date) FROM physical_momentum_metrics p WHERE p.market = 'JP' AND p.symbol = u.ticker AND p.date <= ?)
    WHERE u.ticker IN (${placeholders})
  `, [asOf, asOf, ...tickers])
  return new Map(rows.map((row) => [row.ticker, row]))
}

async function buildModel(
  ticker: string,
  requestedAsOf?: string | null,
  requestedSelected?: string[],
): Promise<SimilarityComparisonReadModel> {
  const latestPrice = await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date FROM ohlcv_daily WHERE ticker = ? ${requestedAsOf ? 'AND date <= ?' : ''}
  `, requestedAsOf ? [ticker, requestedAsOf.slice(0, 10)] : [ticker])
  const asOf = requestedAsOf?.slice(0, 10) ?? latestPrice?.date ?? new Date().toISOString().slice(0, 10)
  const valuationDate = (await execGet<{ date: string | null }>(`
    SELECT MAX(valuation_date) AS date FROM valuation_daily_serving WHERE valuation_date <= ?
  `, [asOf]))?.date ?? null
  const profiles = await execAll<ProfileFeatureRow>(`
    SELECT
      u.ticker, u.name, u.active,
      u.market_segment AS marketSegment,
      u.sector33_code AS sector33Code,
      u.sector33_name AS sector33Name,
      sc.major_category AS custom60Name,
      sc.sub_industry AS subIndustry,
      u.shares_outstanding AS sharesOutstanding,
      v.price,
      v.forward_per AS forwardPer,
      v.pbr,
      v.psr,
      v.fcf_yield AS fcfYield,
      v.ev_ebitda AS evEbitda,
      v.roe,
      v.revenue_growth AS revenueGrowth
    FROM ticker_universe u
    LEFT JOIN stock_classification sc ON sc.ticker = u.ticker
    LEFT JOIN valuation_daily_serving v ON v.ticker = u.ticker AND v.valuation_date = ?
    WHERE u.active = 1
  `, [valuationDate ?? ''])
  const profileMap = new Map(profiles.map((row) => [row.ticker, row]))
  const base = profileMap.get(ticker)
  if (!base) throw new Error(`active_ticker_not_found:${ticker}`)
  const scales = featureScales(profiles)
  const rankedAll = sortBySimilarity(profiles, base, scales)
  const financialRanked = rankedAll.filter(({ row }) => (
    isFinancialProfile(base)
      ? Boolean(base.sector33Name && row.sector33Name === base.sector33Name)
      : !isFinancialProfile(row)
  ))
  const sectorRanked = rankedAll.filter(({ row }) => base.sector33Name && row.sector33Name === base.sector33Name)
  const exactSub = rankedAll.filter(({ row }) => base.subIndustry && row.subIndustry === base.subIndustry)
  const sameCustom = rankedAll.filter(({ row }) => base.custom60Name && row.custom60Name === base.custom60Name)
  const customRanked = [...exactSub, ...sameCustom.filter(({ row }) => !exactSub.some((item) => item.row.ticker === row.ticker))]
  const similarDate = (await execGet<{ date: string | null }>(`
    SELECT MAX(as_of_date) AS date FROM serving_current_similars
    WHERE base_ticker = ? AND as_of_date <= ?
  `, [ticker, asOf]))?.date ?? null
  const structural = similarDate ? await getCurrentSimilars({ ticker, date: similarDate, limit: CANDIDATE_LIMIT }) : { asOfDate: null, rows: [] }

  const groups: SimilarityCandidateGroup[] = [
    {
      kind: 'sector33',
      label: '同業',
      description: `J-Quants 33業種${base.sector33Name ? `「${base.sector33Name}」` : ''}`,
      asOf: valuationDate,
      candidates: sectorRanked.slice(0, CANDIDATE_LIMIT).map(({ row, similarity }) => candidateFromProfile(row, similarity, '33業種が一致')),
    },
    {
      kind: 'custom',
      label: '独自分類',
      description: base.subIndustry ? `細分類「${base.subIndustry}」を優先` : `60分類${base.custom60Name ? `「${base.custom60Name}」` : ''}`,
      asOf: valuationDate,
      candidates: customRanked.slice(0, CANDIDATE_LIMIT).map(({ row, similarity }) => candidateFromProfile(
        row,
        similarity,
        row.subIndustry && row.subIndustry === base.subIndustry ? '独自細分類が一致' : '独自60分類が一致',
      )),
    },
    {
      kind: 'financial',
      label: '財務類似',
      description: '規模・成長・収益性・Valuationの共有指標で比較',
      asOf: valuationDate,
      candidates: financialRanked.filter(({ similarity }) => similarity != null).slice(0, CANDIDATE_LIMIT)
        .map(({ row, similarity }) => candidateFromProfile(row, similarity)),
    },
    {
      kind: 'structure',
      label: '株価・MA構造',
      description: '既存の本質類似モデルによる6ステージ・MA形状',
      asOf: structural.asOfDate,
      candidates: structural.rows.map((row) => {
        const profile = profileMap.get(row.similarTicker)
        const payload = row.payload as { similar?: { name?: string | null; stageCode?: string | null } }
        return {
          ticker: row.similarTicker,
          name: profile?.name ?? payload.similar?.name ?? null,
          sector33: profile?.sector33Name ?? null,
          custom60: profile?.custom60Name ?? null,
          subIndustry: profile?.subIndustry ?? null,
          score: round(row.similarityScore * 100, 1),
          coveragePercent: null,
          reason: '既存MLのMA・物理特徴量が近い',
          stageCode: payload.similar?.stageCode ?? null,
        }
      }),
    },
  ]

  const recommendations = [ticker]
  for (const group of groups) {
    const candidate = group.candidates.find((item) => !recommendations.includes(item.ticker))
    if (candidate) recommendations.push(candidate.ticker)
    if (recommendations.length >= 6) break
  }
  for (const candidate of groups[2].candidates) {
    if (!recommendations.includes(candidate.ticker)) recommendations.push(candidate.ticker)
    if (recommendations.length >= 6) break
  }
  const selectedTickers = normalizeSelected(ticker, requestedSelected, new Set(profileMap.keys()), recommendations)
  const structureRows = await loadStructureRows(selectedTickers, asOf)
  for (const group of groups) {
    for (const candidate of group.candidates) {
      candidate.stageCode ??= profileStageCode(structureRows.get(candidate.ticker))
    }
  }
  const [overviews, returns, sectorBoard] = await Promise.all([
    Promise.all(selectedTickers.map((code) => getFinancialOverviewReadModel(code, asOf))),
    Promise.all(selectedTickers.map((code) => getShareholderReturnsReadModel(code, asOf))),
    getSectorStructureBoard('33', { requestedDate: asOf, includeAllRows: true }),
  ])
  const overviewMap = new Map(overviews.map((model) => [model.ticker, model]))
  const returnsMap = new Map(returns.map((model) => [model.ticker, model]))
  const sectorScoreMap = new Map(sectorBoard.rows.flatMap((row) => [
    [row.groupKey, row.trendStructureScore] as const,
    [row.groupName, row.trendStructureScore] as const,
  ]))
  const companies: ComparisonCompany[] = selectedTickers.map((code) => {
    const profile = profileMap.get(code)!
    const valuation = profile
    const overview = overviewMap.get(code)!
    const shareholder = returnsMap.get(code)!
    const structure = structureRows.get(code)
    const financialSector = FINANCIAL_PATTERN.test(`${profile.sector33Name ?? ''} ${profile.custom60Name ?? ''}`)
    const structureScore = sectorScoreMap.get(profile.sector33Code ?? '') ?? sectorScoreMap.get(profile.sector33Name ?? '') ?? null
    const latestRevenue = overview.performanceAndGrowth.ltmRevenue.value != null
      ? overview.performanceAndGrowth.ltmRevenue
      : overview.performanceAndGrowth.latestFyRevenue
    const metrics: Record<ComparisonMetricKey, ComparisonValue> = {
      revenue: fromOverview(latestRevenue),
      revenueGrowth: fromOverview(overview.performanceAndGrowth.ltmRevenueGrowth),
      epsGrowth: fromOverview(overview.performanceAndGrowth.epsGrowth),
      operatingMargin: fromOverview(overview.performanceAndGrowth.operatingMargin),
      roe: fromOverview(overview.quality.roe),
      roa: fromOverview(overview.quality.roa),
      standardFcf: fromReturn(shareholder.sustainability.standardFcf),
      forwardPer: fromServing(valuation.forwardPer, 'MULTIPLE', valuationDate, { positiveOnly: true }),
      pbr: fromServing(valuation.pbr, 'MULTIPLE', valuationDate, { positiveOnly: true }),
      fcfYield: fromServing(valuation.fcfYield, 'PERCENT', valuationDate, { financialSector }),
      evEbitda: fromServing(valuation.evEbitda, 'MULTIPLE', valuationDate, { financialSector, positiveOnly: true }),
      dividendYield: fromReturn(shareholder.current.forecastDividendYield),
      payoutRatio: fromReturn(shareholder.current.payoutRatio),
      dpsCagr5y: fromReturn(shareholder.direction.dpsCagr5y),
      pms: structure?.pms == null ? unavailable('PMSがありません。', 'missing', 'physical-momentum') : available(structure.pms, 'SCORE', 'physical-momentum', structure.physicalDate),
      pfs: structure?.pfs == null ? unavailable('PFSがありません。', 'missing', 'physical-momentum') : available(structure.pfs, 'SCORE', 'physical-momentum', structure.physicalDate),
      sectorStructureScore: structureScore == null ? unavailable('33業種の構造スコアがありません。', 'missing', 'sector-structure') : available(structureScore, 'SCORE', 'sector-structure', sectorBoard.latestDate),
    }
    return {
      ticker: code,
      name: profile.name,
      marketSegment: profile.marketSegment,
      sector33: profile.sector33Name,
      custom60: profile.custom60Name,
      subIndustry: profile.subIndustry,
      isBase: code === ticker,
      stageCode: profileStageCode(structure),
      stages: {
        dailyA: structure?.dailyA ?? null,
        dailyB: structure?.dailyB ?? null,
        weeklyA: structure?.weeklyA ?? null,
        weeklyB: structure?.weeklyB ?? null,
        monthlyA: structure?.monthlyA ?? null,
        monthlyB: structure?.monthlyB ?? null,
      },
      metrics,
    }
  })

  const sectorPeers = profiles.filter((row) => base.sector33Name && row.sector33Name === base.sector33Name)
  const distributions: Partial<Record<ComparisonMetricKey, ComparisonDistribution>> = {
    revenueGrowth: distribution('revenueGrowth', sectorPeers.map((row) => numeric(row.revenueGrowth)), sectorPeers.length),
    roe: distribution('roe', sectorPeers.map((row) => numeric(row.roe)), sectorPeers.length),
    forwardPer: distribution('forwardPer', sectorPeers.map((row) => positive(row.forwardPer)), sectorPeers.length),
    pbr: distribution('pbr', sectorPeers.map((row) => positive(row.pbr)), sectorPeers.length),
    fcfYield: distribution('fcfYield', sectorPeers.map((row) => numeric(row.fcfYield)), sectorPeers.length),
    evEbitda: distribution('evEbitda', sectorPeers.map((row) => positive(row.evEbitda)), sectorPeers.length),
  }

  return {
    contractVersion: 'similarity-comparison-v1',
    ticker,
    asOf,
    valuationDate,
    structureDate: sectorBoard.latestDate,
    classification: {
      name: base.name,
      sector33: base.sector33Name,
      custom60: base.custom60Name,
      subIndustry: base.subIndustry,
    },
    candidateGroups: groups,
    recommendations,
    selectedTickers,
    companies,
    sectorDistribution: {
      label: 'J-Quants 33業種',
      groupName: base.sector33Name,
      metrics: distributions,
    },
    coverage: {
      activeUniverse: profiles.length,
      financialFeatureUniverse: financialRanked.filter(({ similarity }) => similarity != null).length + 1,
      sectorPeers: sectorPeers.length,
      selectedCompanies: companies.length,
    },
  }
}

export async function getSimilarityComparisonReadModel(
  rawTicker: string,
  requestedAsOf?: string | null,
  selected?: string[],
): Promise<SimilarityComparisonReadModel> {
  const ticker = rawTicker.toUpperCase().replace(/\.T$/i, '')
  const normalizedSelected = selected?.map((value) => value.toUpperCase().replace(/\.T$/i, '')).sort() ?? []
  const key = `${ticker}:${requestedAsOf?.slice(0, 10) ?? 'latest'}:${normalizedSelected.join(',')}`
  const cached = modelCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const model = await buildModel(ticker, requestedAsOf, normalizedSelected)
  modelCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: model })
  return model
}
