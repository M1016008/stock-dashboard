import { execGet } from '@/lib/db/client'
import {
  normalizeAsOf,
  type AccountingStandard,
  type ConsolidationScope,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import {
  FINANCIAL_DETAIL_DEFINITION_KEYS,
  type FinancialDetailAvailability,
  type FinancialDetailBalancePeriod,
  type FinancialDetailCashFlowPeriod,
  type FinancialDetailMetricPeriod,
  type FinancialDetailPlPeriod,
  type FinancialDetailReadModel,
  type FinancialDetailValue,
} from '@/lib/financial-detail'
import { METRIC_DEFINITION_REGISTRY, type FinancialMetricKey } from '@/lib/financial-metrics'
import type {
  FinancialPerformanceDetailPeriod,
  FinancialPerformanceSummaryValue,
} from '@/lib/financial-performance-detail'
import type { FinancialTimelineMode, FinancialTimelineValue } from '@/lib/financial-performance-timeline'
import { loadNormalizedFinancialFacts } from '@/lib/server/financial-foundation-store'
import { buildFinancialPerformanceDetail } from '@/lib/server/financial-performance-detail-read-model'

const MODES: FinancialTimelineMode[] = ['FY', 'YTD', 'STANDALONE', 'LTM']
const FINANCIAL_SECTOR_PATTERN = /銀行|保険|証券|金融/
const BALANCE_METRICS = ['total_assets', 'equity_attributable', 'equity_ratio', 'bps'] as const
const CASH_FLOW_METRICS = ['operating_cash_flow', 'investing_cash_flow', 'financing_cash_flow'] as const

interface TickerProfile {
  sector17_name: string | null
  sector33_name: string | null
}

function unavailable(
  reason: string,
  availability: Exclude<FinancialDetailAvailability, 'available'> = 'missing',
  definitionVersion: string | null = null,
): FinancialDetailValue {
  return {
    value: null,
    unit: null,
    availability,
    reason,
    periodLabel: null,
    periodStart: null,
    periodEnd: null,
    publishedAt: null,
    consolidationScope: null,
    accountingStandard: 'UNKNOWN',
    definitionVersion,
    inputIds: [],
  }
}

function correctionRank(status: string): number {
  if (status === 'restated') return 2
  if (status === 'corrected') return 1
  return 0
}

function latestFact(candidates: NormalizedFinancialFact[]): NormalizedFinancialFact | undefined {
  return [...candidates].sort((a, b) => (
    b.publishedAt.localeCompare(a.publishedAt)
    || correctionRank(b.correctionStatus) - correctionRank(a.correctionStatus)
    || b.factId.localeCompare(a.factId)
  ))[0]
}

function factValue(
  fact: NormalizedFinancialFact | undefined,
  periodLabel: string,
  definitionVersion: string | null = null,
  transform?: (value: number) => number,
  unit?: string,
): FinancialDetailValue {
  if (!fact) return unavailable('同一期間・会計基準・連結区分の正規化済みfactがありません。', 'missing', definitionVersion)
  return {
    value: transform ? transform(fact.value) : fact.value,
    unit: unit ?? fact.unit,
    availability: 'available',
    reason: null,
    periodLabel,
    periodStart: fact.periodStart,
    periodEnd: fact.periodEnd,
    publishedAt: fact.publishedAt,
    consolidationScope: fact.consolidationScope,
    accountingStandard: fact.accountingStandard,
    definitionVersion: definitionVersion ?? fact.definitionVersion,
    inputIds: definitionVersion
      ? (fact.inputFactIds.length > 0 ? fact.inputFactIds : [fact.factId])
      : [],
  }
}

function timelineValue(
  value: FinancialTimelineValue | null,
  period: FinancialPerformanceDetailPeriod,
  definitionVersion: string | null = null,
): FinancialDetailValue {
  if (!value) return unavailable('同一期間の正規化済みfactがありません。', 'missing', definitionVersion)
  return {
    value: value.value,
    unit: value.unit,
    availability: 'available',
    reason: null,
    periodLabel: period.label,
    periodStart: null,
    periodEnd: period.periodEnd,
    publishedAt: value.publishedAt,
    consolidationScope: period.consolidationScope,
    accountingStandard: period.accountingStandard,
    definitionVersion: definitionVersion ?? value.definitionVersion,
    inputIds: definitionVersion ? value.inputIds : [],
  }
}

function summaryValue(
  value: FinancialPerformanceSummaryValue,
  period: FinancialPerformanceDetailPeriod,
  definitionVersion: string,
): FinancialDetailValue {
  if (value.value == null) {
    return unavailable(
      value.reason ?? '算定に必要な正規化済みfactがありません。',
      value.availability === 'available' ? 'missing' : value.availability,
      definitionVersion,
    )
  }
  return {
    value: value.value,
    unit: value.unit,
    availability: 'available',
    reason: null,
    periodLabel: value.periodLabel ?? period.label,
    periodStart: null,
    periodEnd: period.periodEnd,
    publishedAt: period.publishedAt,
    consolidationScope: period.consolidationScope,
    accountingStandard: period.accountingStandard,
    definitionVersion,
    inputIds: value.inputIds,
  }
}

function periodLabel(targetFiscalYear: number | null, periodKind: string, periodEnd: string): string {
  const fiscal = `FY${String(targetFiscalYear ?? Number(periodEnd.slice(0, 4))).slice(-2)}`
  if (periodKind === 'FY') return fiscal
  if (periodKind === 'LTM') return `LTM ${periodEnd.slice(0, 7)}`
  return `${fiscal} ${periodKind}`
}

function modeAccumulation(mode: FinancialTimelineMode): NormalizedFinancialFact['accumulationKind'] {
  if (mode === 'FY') return 'FY'
  if (mode === 'YTD') return 'YTD'
  if (mode === 'STANDALONE') return 'STANDALONE'
  return 'LTM'
}

function exactFact(
  facts: NormalizedFinancialFact[],
  metric: string,
  period: Pick<FinancialPerformanceDetailPeriod, 'periodEnd' | 'periodKind' | 'consolidationScope' | 'accountingStandard'>,
  accumulationKind?: NormalizedFinancialFact['accumulationKind'],
): NormalizedFinancialFact | undefined {
  return latestFact(facts.filter((fact) => (
    fact.metric === metric
    && fact.periodEnd === period.periodEnd
    && fact.periodKind === period.periodKind
    && fact.consolidationScope === period.consolidationScope
    && fact.accountingStandard === period.accountingStandard
    && (!accumulationKind || fact.accumulationKind === accumulationKind)
  )))
}

function latestBalanceBefore(
  facts: NormalizedFinancialFact[],
  metric: string,
  beforeOrAt: string,
  scope: ConsolidationScope,
  standard: AccountingStandard,
): NormalizedFinancialFact | undefined {
  const candidates = facts.filter((fact) => (
    fact.metric === metric
    && fact.valueKind === 'instant'
    && fact.periodEnd <= beforeOrAt
    && fact.consolidationScope === scope
    && fact.accountingStandard === standard
  ))
  const periodEnd = candidates.map((fact) => fact.periodEnd).sort().at(-1)
  return periodEnd ? latestFact(candidates.filter((fact) => fact.periodEnd === periodEnd)) : undefined
}

function preferredScope<T extends { consolidationScope: ConsolidationScope }>(values: T[]): T[] {
  return values.some((value) => value.consolidationScope === 'consolidated')
    ? values.filter((value) => value.consolidationScope === 'consolidated')
    : values.filter((value) => value.consolidationScope === 'standalone')
}

function latestValue(values: FinancialDetailValue[]): FinancialDetailValue {
  return [...values]
    .filter((value) => value.value != null)
    .sort((a, b) => (
      (b.periodEnd ?? '').localeCompare(a.periodEnd ?? '')
      || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')
    ))[0] ?? unavailable('表示できる正規化済みfactがありません。')
}

function buildProfitAndLoss(
  facts: NormalizedFinancialFact[],
  performance: ReturnType<typeof buildFinancialPerformanceDetail>,
): FinancialDetailReadModel['profitAndLoss'] {
  return Object.fromEntries(MODES.map((mode) => {
    const accumulation = modeAccumulation(mode)
    const periods = performance.modes[mode].periods
      .filter((period) => period.pointType === 'actual')
      .map((period): FinancialDetailPlPeriod => {
        if (!period.consolidationScope) throw new Error(`Actual P/L period is missing consolidation scope: ${period.key}`)
        const ordinary = exactFact(facts, 'ordinary_profit', period, accumulation)
        return {
          key: `pl:${mode}:${period.key}`,
          label: period.label,
          periodEnd: period.periodEnd,
          targetFiscalYear: period.targetFiscalYear,
          periodKind: period.periodKind as NormalizedFinancialFact['periodKind'],
          publishedAt: period.publishedAt,
          consolidationScope: period.consolidationScope,
          accountingStandard: period.accountingStandard,
          metrics: {
            revenue: timelineValue(period.metrics.revenue, period),
            operatingProfit: timelineValue(period.metrics.operating_profit, period),
            ordinaryProfit: factValue(
              ordinary,
              period.label,
              null,
            ),
            netIncome: timelineValue(period.metrics.net_income_attributable, period),
            eps: timelineValue(period.metrics.eps_basic, period, METRIC_DEFINITION_REGISTRY.eps.version),
          },
        }
      })
    return [mode, periods]
  })) as FinancialDetailReadModel['profitAndLoss']
}

function buildBalanceSheet(facts: NormalizedFinancialFact[]): FinancialDetailReadModel['balanceSheet'] {
  const candidates = preferredScope(facts.filter((fact) => (
    fact.valueKind === 'instant' && BALANCE_METRICS.includes(fact.metric as typeof BALANCE_METRICS[number])
  )))
  const anchors = new Map<string, NormalizedFinancialFact>()
  for (const fact of candidates) {
    const key = [fact.periodEnd, fact.periodKind, fact.consolidationScope].join('|')
    const previous = anchors.get(key)
    if (!previous || fact.publishedAt > previous.publishedAt || (
      fact.publishedAt === previous.publishedAt && fact.accountingStandard !== 'UNKNOWN'
    )) anchors.set(key, fact)
  }
  const periods = [...anchors.values()].map((anchor): FinancialDetailBalancePeriod => {
    const label = periodLabel(anchor.targetFiscalYear, anchor.periodKind, anchor.periodEnd)
    const factFor = (metric: string) => latestFact(candidates.filter((fact) => (
      fact.metric === metric
      && fact.periodEnd === anchor.periodEnd
      && fact.periodKind === anchor.periodKind
      && fact.consolidationScope === anchor.consolidationScope
      && fact.accountingStandard === anchor.accountingStandard
    )))
    const totalAssets = factFor('total_assets')
    const equity = factFor('equity_attributable')
    const equityRatio = factFor('equity_ratio')
    const bps = factFor('bps')
    const publishedAt = [totalAssets, equity, equityRatio, bps]
      .filter((fact): fact is NormalizedFinancialFact => Boolean(fact))
      .map((fact) => fact.publishedAt)
      .sort()
      .at(-1) ?? anchor.publishedAt
    return {
      key: `bs:${anchor.periodEnd}:${anchor.periodKind}:${anchor.consolidationScope}:${anchor.accountingStandard}`,
      label,
      periodEnd: anchor.periodEnd,
      targetFiscalYear: anchor.targetFiscalYear,
      periodKind: anchor.periodKind,
      publishedAt,
      consolidationScope: anchor.consolidationScope,
      accountingStandard: anchor.accountingStandard,
      metrics: {
        totalAssets: factValue(totalAssets, label),
        equity: factValue(equity, label),
        equityRatio: factValue(
          equityRatio,
          label,
          METRIC_DEFINITION_REGISTRY.equity_ratio.version,
          (value) => value * 100,
          'PERCENT',
        ),
        bps: factValue(bps, label, METRIC_DEFINITION_REGISTRY.bps.version),
      },
    }
  }).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
  return {
    FY: periods.filter((period) => period.periodKind === 'FY'),
    QUARTER: periods.filter((period) => period.periodKind !== 'FY' && period.periodKind !== 'LTM'),
  }
}

function buildCashFlow(
  facts: NormalizedFinancialFact[],
  isFinancialSector: boolean,
): FinancialDetailReadModel['cashFlow'] {
  const scoped = preferredScope(facts.filter((fact) => CASH_FLOW_METRICS.includes(fact.metric as typeof CASH_FLOW_METRICS[number])))
  return Object.fromEntries(MODES.map((mode) => {
    const accumulation = modeAccumulation(mode)
    const candidates = scoped.filter((fact) => fact.accumulationKind === accumulation)
    const groups = new Map<string, NormalizedFinancialFact[]>()
    for (const fact of candidates) {
      const key = [fact.periodEnd, fact.periodKind, fact.consolidationScope, fact.accountingStandard].join('|')
      groups.set(key, [...(groups.get(key) ?? []), fact])
    }
    const periods = [...groups.entries()].map(([key, group]): FinancialDetailCashFlowPeriod => {
      const representative = [...group].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
      const label = periodLabel(representative.targetFiscalYear, representative.periodKind, representative.periodEnd)
      const factFor = (metric: string) => latestFact(group.filter((fact) => fact.metric === metric))
      const cfo = factFor('operating_cash_flow')
      const cfi = factFor('investing_cash_flow')
      const cff = factFor('financing_cash_flow')
      const simpleFcf = isFinancialSector
        ? unavailable(
            '金融業では営業CFと投資CFの意味が一般事業会社と異なるため、簡易FCFは適用外です。',
            'not_applicable',
            METRIC_DEFINITION_REGISTRY.simple_fcf.version,
          )
        : cfo && cfi
          ? {
              ...factValue(cfo, label, METRIC_DEFINITION_REGISTRY.simple_fcf.version),
              value: cfo.value + cfi.value,
              inputIds: [cfo.factId, cfi.factId],
            }
          : unavailable(
              '同一期間の営業CFと投資CFが揃っていないため簡易FCFを算定できません。',
              'missing',
              METRIC_DEFINITION_REGISTRY.simple_fcf.version,
            )
      return {
        key: `cf:${mode}:${key}`,
        label,
        periodEnd: representative.periodEnd,
        targetFiscalYear: representative.targetFiscalYear,
        periodKind: representative.periodKind,
        publishedAt: [cfo, cfi, cff]
          .filter((fact): fact is NormalizedFinancialFact => Boolean(fact))
          .map((fact) => fact.publishedAt)
          .sort()
          .at(-1) ?? representative.publishedAt,
        consolidationScope: representative.consolidationScope,
        accountingStandard: representative.accountingStandard,
        accumulationKind: mode,
        metrics: {
          operatingCashFlow: factValue(cfo, label),
          investingCashFlow: factValue(cfi, label),
          financingCashFlow: factValue(cff, label),
          simpleFcf,
        },
      }
    }).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
    return [mode, periods]
  })) as FinancialDetailReadModel['cashFlow']
}

function definitionVersion(key: FinancialMetricKey): string {
  return METRIC_DEFINITION_REGISTRY[key].version
}

function buildMetricPeriods(
  facts: NormalizedFinancialFact[],
  performance: ReturnType<typeof buildFinancialPerformanceDetail>,
  cashFlow: FinancialDetailReadModel['cashFlow'],
): FinancialDetailReadModel['metricPeriods'] {
  const build = (basis: 'FY' | 'LTM'): FinancialDetailMetricPeriod[] => {
    return performance.modes[basis].periods
      .filter((period) => period.pointType === 'actual')
      .map((period) => {
        if (!period.consolidationScope) throw new Error(`Actual metric period is missing consolidation scope: ${period.key}`)
        const equityRatio = latestBalanceBefore(
          facts,
          'equity_ratio',
          period.periodEnd,
          period.consolidationScope,
          period.accountingStandard,
        )
        const bps = latestBalanceBefore(
          facts,
          'bps',
          period.periodEnd,
          period.consolidationScope,
          period.accountingStandard,
        )
        const cash = cashFlow[basis].find((candidate) => (
          candidate.periodEnd === period.periodEnd
          && candidate.consolidationScope === period.consolidationScope
          && candidate.accountingStandard === period.accountingStandard
        ))
        return {
          key: `metrics:${basis}:${period.key}`,
          label: period.label,
          periodEnd: period.periodEnd,
          targetFiscalYear: period.targetFiscalYear,
          periodKind: period.periodKind as NormalizedFinancialFact['periodKind'],
          publishedAt: period.publishedAt,
          consolidationScope: period.consolidationScope,
          accountingStandard: period.accountingStandard,
          basis,
          metrics: {
            operatingMargin: summaryValue(period.profitability.operatingMargin, period, definitionVersion('operating_margin')),
            netMargin: summaryValue(period.profitability.netMargin, period, definitionVersion('net_margin')),
            roe: summaryValue(period.profitability.roe, period, definitionVersion('roe')),
            roa: summaryValue(period.profitability.roa, period, definitionVersion('roa')),
            equityRatio: factValue(
              equityRatio,
              period.label,
              definitionVersion('equity_ratio'),
              (value) => value * 100,
              'PERCENT',
            ),
            eps: timelineValue(period.metrics.eps_basic, period, definitionVersion('eps')),
            bps: factValue(bps, period.label, definitionVersion('bps')),
            simpleFcf: cash?.metrics.simpleFcf ?? unavailable(
              '同一期間の営業CFと投資CFが揃っていません。',
              'missing',
              definitionVersion('simple_fcf'),
            ),
          },
        }
      })
  }
  return { FY: build('FY'), LTM: build('LTM') }
}

export function buildFinancialDetail(
  ticker: string,
  asOf: string,
  allFacts: NormalizedFinancialFact[],
  isFinancialSector: boolean,
): FinancialDetailReadModel {
  const cutoff = normalizeAsOf(asOf)
  const facts = allFacts.filter((fact) => fact.ticker === ticker && fact.publishedAt <= cutoff)
  const performance = buildFinancialPerformanceDetail(ticker, asOf, facts, [], isFinancialSector)
  const profitAndLoss = buildProfitAndLoss(facts, performance)
  const balanceSheet = buildBalanceSheet(facts)
  const cashFlow = buildCashFlow(facts, isFinancialSector)
  const metricPeriods = buildMetricPeriods(facts, performance, cashFlow)
  const latestPerformance = [...performance.modes.LTM.periods]
    .reverse()
    .find((period) => period.pointType === 'actual')
    ?? [...performance.modes.FY.periods].reverse().find((period) => period.pointType === 'actual')
  const latestBalance = [...balanceSheet.FY, ...balanceSheet.QUARTER]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
    .at(-1)
  const latestCash = [...cashFlow.LTM].reverse()[0] ?? [...cashFlow.FY].reverse()[0]
  const noPerformance = unavailable('最新LTMまたはFYの業績factがありません。')
  const noBalance = unavailable('利用できるB/S時点値がありません。')
  const noCash = unavailable('利用できるC/F期間値がありません。')
  const latestBps = latestValue([...balanceSheet.FY, ...balanceSheet.QUARTER].map((period) => period.metrics.bps))

  return {
    contractVersion: 'financial-detail-v1',
    ticker,
    asOf: cutoff.slice(0, 10),
    isFinancialSector,
    summary: {
      profitability: {
        operatingMargin: latestPerformance
          ? summaryValue(latestPerformance.profitability.operatingMargin, latestPerformance, definitionVersion('operating_margin'))
          : noPerformance,
        netMargin: latestPerformance
          ? summaryValue(latestPerformance.profitability.netMargin, latestPerformance, definitionVersion('net_margin'))
          : noPerformance,
        roe: latestPerformance
          ? summaryValue(latestPerformance.profitability.roe, latestPerformance, definitionVersion('roe'))
          : noPerformance,
        roa: latestPerformance
          ? summaryValue(latestPerformance.profitability.roa, latestPerformance, definitionVersion('roa'))
          : noPerformance,
      },
      financialHealth: {
        equityRatio: latestBalance?.metrics.equityRatio ?? noBalance,
        totalAssets: latestBalance?.metrics.totalAssets ?? noBalance,
        equity: latestBalance?.metrics.equity ?? noBalance,
        bps: latestBps,
      },
      cashFlow: {
        operatingCashFlow: latestCash?.metrics.operatingCashFlow ?? noCash,
        investingCashFlow: latestCash?.metrics.investingCashFlow ?? noCash,
        financingCashFlow: latestCash?.metrics.financingCashFlow ?? noCash,
        simpleFcf: latestCash?.metrics.simpleFcf ?? noCash,
      },
      capitalEfficiency: {
        roe: latestPerformance
          ? summaryValue(latestPerformance.profitability.roe, latestPerformance, definitionVersion('roe'))
          : noPerformance,
        roa: latestPerformance
          ? summaryValue(latestPerformance.profitability.roa, latestPerformance, definitionVersion('roa'))
          : noPerformance,
        eps: latestPerformance
          ? timelineValue(latestPerformance.metrics.eps_basic, latestPerformance, definitionVersion('eps'))
          : noPerformance,
        bps: latestBps,
      },
    },
    metricPeriods,
    profitAndLoss,
    balanceSheet,
    cashFlow,
    definitions: Object.fromEntries(FINANCIAL_DETAIL_DEFINITION_KEYS.map((key) => [
      key,
      METRIC_DEFINITION_REGISTRY[key],
    ])) as FinancialDetailReadModel['definitions'],
    coverage: {
      facts: facts.length,
      profitAndLossPeriods: Object.values(profitAndLoss).reduce((sum, periods) => sum + periods.length, 0),
      balanceSheetPeriods: balanceSheet.FY.length + balanceSheet.QUARTER.length,
      cashFlowPeriods: Object.values(cashFlow).reduce((sum, periods) => sum + periods.length, 0),
    },
  }
}

export async function getFinancialDetailReadModel(
  ticker: string,
  requestedAsOf?: string | null,
): Promise<FinancialDetailReadModel> {
  const [latestPrice, profile, facts] = await Promise.all([
    execGet<{ date: string }>('SELECT date FROM ohlcv_daily WHERE ticker = ? ORDER BY date DESC LIMIT 1', [ticker]),
    execGet<TickerProfile>('SELECT sector17_name, sector33_name FROM ticker_universe WHERE ticker = ?', [ticker]),
    loadNormalizedFinancialFacts(ticker),
  ])
  const asOf = requestedAsOf || latestPrice?.date || new Date().toISOString().slice(0, 10)
  const sectorText = `${profile?.sector17_name ?? ''} ${profile?.sector33_name ?? ''}`
  return buildFinancialDetail(ticker, asOf, facts, FINANCIAL_SECTOR_PATTERN.test(sectorText))
}
