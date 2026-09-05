'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  BriefcaseBusiness,
  Building2,
  ChevronRight,
  CircleUserRound,
  Factory,
  FileText,
  Globe2,
  History,
  Landmark,
  ShieldCheck,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  CompanyInformationReadModel,
  PolicyHoldingRow,
} from '@/lib/company-information'
import type {
  CompanyNarrativeFact,
  OperatingSegmentFact,
  SegmentMetricFact,
} from '@/lib/edinet-xbrl'

interface CompanyInformationDetailProps {
  ticker: string
  analysisDate?: string | null
}

type CompanySubTab = 'overview' | 'segments' | 'employees' | 'officers' | 'shareholders'

const SUB_TABS: Array<{ id: CompanySubTab; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: '概要', icon: Building2 },
  { id: 'segments', label: '事業・セグメント', icon: Factory },
  { id: 'employees', label: '従業員', icon: Users },
  { id: 'officers', label: '役員', icon: CircleUserRound },
  { id: 'shareholders', label: '株主・保有', icon: Landmark },
]

function formatNumber(value: number | null, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}%`
}

function formatHoldingRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const percent = Math.abs(value) <= 1 ? value * 100 : value
  return `${percent.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}%`
}

function formatMoney(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}兆円`
  if (abs >= 100_000_000) return `${(value / 100_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}億円`
  if (abs >= 10_000) return `${(value / 10_000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}万円`
  return `${formatNumber(value)}円`
}

function formatFiscalYearEnd(value: string | null): string {
  if (!value) return '—'
  const [month, day] = value.split('-').map(Number)
  return Number.isFinite(month) && Number.isFinite(day) ? `${month}月${day}日` : value
}

function formatMetric(metric: SegmentMetricFact | null): string {
  return metric ? formatMoney(metric.value) : '—'
}

function SectionHeading({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-2.5">
      <Icon size={15} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
      <div className="min-w-0">
        <h3 className="text-[11px] font-black text-[var(--color-text-primary)]">{title}</h3>
        <p className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">{subtitle}</p>
      </div>
    </div>
  )
}

function NarrativeDisclosure({
  title,
  fact,
  preview = false,
}: {
  title: string
  fact: CompanyNarrativeFact | null
  preview?: boolean
}) {
  if (!fact) {
    return (
      <div className="border-b border-[var(--color-border-soft)] px-4 py-3 last:border-b-0">
        <div className="text-[10px] font-black text-[var(--color-text-primary)]">{title}</div>
        <div className="mt-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]">対象有報から取得できませんでした。</div>
      </div>
    )
  }
  return (
    <div className="border-b border-[var(--color-border-soft)] px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-black text-[var(--color-text-primary)]">{title}</div>
        <div className="font-mono text-[7px] text-[var(--color-text-tertiary)]">{fact.concept}</div>
      </div>
      {preview && (
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[10px] font-semibold leading-5 text-[var(--color-text-secondary)]">
          {fact.text}
        </p>
      )}
      <details className={preview ? 'mt-1.5' : 'mt-1'}>
        <summary className="cursor-pointer text-[9px] font-black text-[var(--color-brand-700)]">
          {preview ? '全文を見る' : '内容を表示'}
        </summary>
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-[var(--color-border-default)] pl-3 text-[10px] font-medium leading-5 text-[var(--color-text-secondary)]">
          {fact.text}
        </p>
      </details>
    </div>
  )
}

function CompanyAtGlance({ model }: { model: CompanyInformationReadModel }) {
  const normalSegments = model.segmentInformation.segments.filter((segment) => segment.kind === 'business')
  const employee = model.employees.latest.consolidated ?? model.employees.latest.nonConsolidated
  return (
    <div className="grid border-b border-[var(--color-border-default)] bg-[var(--color-border-soft)] sm:grid-cols-3 sm:gap-px">
      <div className="border-b border-[var(--color-border-soft)] bg-white px-4 py-3 sm:border-b-0">
        <div className="text-[8px] font-black text-[var(--color-text-tertiary)]">事業概要</div>
        <div className="mt-1 line-clamp-2 text-[10px] font-bold leading-4 text-[var(--color-text-primary)]">
          {model.overview.businessDescription?.text ?? '事業内容の開示を取得できませんでした。'}
        </div>
      </div>
      <div className="border-b border-[var(--color-border-soft)] bg-white px-4 py-3 sm:border-b-0">
        <div className="text-[8px] font-black text-[var(--color-text-tertiary)]">主要セグメント</div>
        <div className="mt-1 text-[10px] font-bold leading-4 text-[var(--color-text-primary)]">
          {normalSegments.length > 0 ? normalSegments.slice(0, 3).map((segment) => segment.name).join(' / ') : '単一事業または構造化データなし'}
        </div>
      </div>
      <div className="bg-white px-4 py-3">
        <div className="text-[8px] font-black text-[var(--color-text-tertiary)]">従業員</div>
        <div className="mt-1 font-mono text-[14px] font-black text-[var(--color-text-primary)]">
          {employee?.employeeCount == null ? '—' : `${formatNumber(employee.employeeCount)}人`}
        </div>
        <div className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">{employee?.consolidation === 'consolidated' ? '連結' : '単体'}</div>
      </div>
    </div>
  )
}

function OverviewTab({ model }: { model: CompanyInformationReadModel }) {
  const identityRows = [
    ['会社名', model.identity.companyName],
    ['EDINETコード', model.identity.edinetCode],
    ['市場', model.identity.marketSegment],
    ['17業種', model.identity.sector17],
    ['33業種', model.identity.sector33],
    ['独自60分類', model.identity.custom60],
    ['独自細分類', model.identity.subIndustry],
    ['会計基準', model.identity.accountingStandard],
    ['決算期', formatFiscalYearEnd(model.identity.fiscalYearEnd)],
  ]
  return (
    <div className="space-y-3">
      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
        <SectionHeading icon={Building2} title="会社概要" subtitle="分類と法定開示の基準情報" />
        <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] sm:grid-cols-3">
          {identityRows.map(([label, value]) => (
            <div key={label} className="min-w-0 bg-white px-3 py-2.5">
              <div className="text-[7px] font-black text-[var(--color-text-tertiary)]">{label}</div>
              <div className="mt-0.5 break-words text-[9px] font-black text-[var(--color-text-primary)]">{value || '—'}</div>
            </div>
          ))}
        </div>
        <CompanyAtGlance model={model} />
        <NarrativeDisclosure title="事業の内容" fact={model.overview.businessDescription} preview />
        <NarrativeDisclosure title="経営方針・経営環境" fact={model.overview.businessPolicy} />
        <NarrativeDisclosure title="沿革" fact={model.overview.companyHistory} />
      </section>
      <SourceNote model={model} />
    </div>
  )
}

function segmentComposition(segments: OperatingSegmentFact[]) {
  const rows = segments.filter((segment) => segment.kind === 'business' || segment.kind === 'other')
  const externalComplete = rows.length > 0 && rows.every((segment) => segment.externalRevenue != null)
  const revenueComplete = rows.length > 0 && rows.every((segment) => segment.revenue != null)
  if (!externalComplete && !revenueComplete) return null
  const basis = externalComplete ? 'externalRevenue' as const : 'revenue' as const
  const values = rows.map((segment) => ({ segment, value: segment[basis]!.value })).filter((row) => row.value > 0)
  const total = values.reduce((sum, row) => sum + row.value, 0)
  return total > 0 ? { basis, total, values } : null
}

function SegmentComposition({ segments }: { segments: OperatingSegmentFact[] }) {
  const composition = segmentComposition(segments)
  if (!composition) {
    return <div className="px-4 py-4 text-[9px] font-semibold text-[var(--color-text-tertiary)]">同一定義で比較できる売上構成データが揃っていません。</div>
  }
  const colors = ['#0f4c81', '#2878a8', '#51a2c8', '#70b7a5', '#d2a34b', '#8b90a0']
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[9px] font-black text-[var(--color-text-primary)]">売上構成</div>
        <div className="text-[7px] font-bold text-[var(--color-text-tertiary)]">{composition.basis === 'externalRevenue' ? '外部顧客売上高ベース' : 'セグメント売上高ベース'}</div>
      </div>
      <div className="flex h-5 w-full overflow-hidden border border-[var(--color-border-default)]" role="img" aria-label="セグメント売上構成">
        {composition.values.map((row, index) => (
          <div
            key={row.segment.key}
            style={{ width: `${(row.value / composition.total) * 100}%`, backgroundColor: colors[index % colors.length] }}
            title={`${row.segment.name} ${formatPercent((row.value / composition.total) * 100)}`}
          />
        ))}
      </div>
      <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {composition.values.map((row, index) => (
          <div key={row.segment.key} className="flex min-w-0 items-center gap-1.5 text-[8px]">
            <span className="h-2 w-2 shrink-0" style={{ backgroundColor: colors[index % colors.length] }} />
            <span className="truncate font-bold text-[var(--color-text-secondary)]">{row.segment.name}</span>
            <span className="ml-auto shrink-0 font-mono font-black text-[var(--color-text-primary)]">{formatPercent((row.value / composition.total) * 100)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SegmentKindLabel({ segment }: { segment: OperatingSegmentFact }) {
  if (segment.kind === 'business') return null
  const labels: Record<OperatingSegmentFact['kind'], string> = {
    business: '',
    other: 'その他',
    adjustment: '調整',
    corporate: '全社',
    total: '合計',
  }
  return <span className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-1 py-0.5 text-[7px] font-black text-[var(--color-text-tertiary)]">{labels[segment.kind]}</span>
}

function SegmentsTab({ model }: { model: CompanyInformationReadModel }) {
  const info = model.segmentInformation
  const maxGeography = Math.max(0, ...info.geographicAreas.map((area) => area.revenue.value))
  return (
    <div className="space-y-3">
      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
        <SectionHeading icon={Factory} title="事業・セグメント" subtitle={`${info.periodEnd ?? '期間不明'} / ${info.accountingFramework}`} />
        <SegmentComposition segments={info.segments} />
        <div className="overflow-x-auto border-t border-[var(--color-border-default)]">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead className="bg-[var(--color-surface-subtle)] text-[8px] font-black text-[var(--color-text-secondary)]">
              <tr>
                <th className="sticky left-0 z-10 bg-[var(--color-surface-subtle)] px-3 py-2">セグメント</th>
                <th className="px-3 py-2 text-right">外部顧客売上</th>
                <th className="px-3 py-2 text-right">売上高</th>
                <th className="px-3 py-2 text-right">セグメント間</th>
                <th className="px-3 py-2 text-right">利益・損失</th>
                <th className="px-3 py-2 text-right">資産</th>
                <th className="px-3 py-2 text-right">減価償却</th>
                <th className="px-3 py-2 text-right">設備投資</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)] text-[9px]">
              {info.segments.map((segment) => (
                <tr key={segment.key} className={segment.kind === 'business' ? 'bg-white' : 'bg-[var(--color-surface-subtle)]'}>
                  <td className={`sticky left-0 z-10 px-3 py-2.5 font-black text-[var(--color-text-primary)] ${segment.kind === 'business' ? 'bg-white' : 'bg-[var(--color-surface-subtle)]'}`}>
                    <div className="flex items-center gap-1.5">{segment.name}<SegmentKindLabel segment={segment} /></div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatMetric(segment.externalRevenue)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatMetric(segment.revenue)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatMetric(segment.intersegmentRevenue)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatMetric(segment.profitLoss)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatMetric(segment.assets)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatMetric(segment.depreciation)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatMetric(segment.capitalExpenditure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {info.segments.length === 0 && <div className="px-4 py-5 text-[9px] font-semibold text-[var(--color-text-tertiary)]">構造化された報告セグメントはありません。</div>}
      </section>

      {info.geographicAreas.length > 0 && (
        <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
          <SectionHeading icon={Globe2} title="地域別売上高" subtitle="事業セグメントとは分離して表示" />
          <div className="divide-y divide-[var(--color-border-soft)]">
            {info.geographicAreas.map((area) => (
              <div key={`${area.name}:${area.periodEnd}`} className="grid grid-cols-[90px_1fr_auto] items-center gap-3 px-4 py-2.5 text-[9px]">
                <div className="font-black text-[var(--color-text-primary)]">{area.name}</div>
                <div className="h-2 bg-[var(--color-surface-subtle)]">
                  <div className="h-full bg-[var(--color-brand-600)]" style={{ width: `${maxGeography > 0 ? (area.revenue.value / maxGeography) * 100 : 0}%` }} />
                </div>
                <div className="font-mono font-black text-[var(--color-text-primary)]">{formatMoney(area.revenue.value)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {info.majorCustomers.length > 0 && (
        <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
          <SectionHeading icon={BriefcaseBusiness} title="主要顧客" subtitle="有報で構造化されている場合のみ表示" />
          <div className="divide-y divide-[var(--color-border-soft)]">
            {info.majorCustomers.map((customer) => (
              <div key={`${customer.name}:${customer.periodEnd}`} className="grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2.5 text-[9px]">
                <div className="font-black text-[var(--color-text-primary)]">{customer.name}</div>
                <div className="font-mono">{formatMetric(customer.revenue)}</div>
                <div className="font-mono">{customer.revenueRatio ? formatHoldingRatio(customer.revenueRatio.value) : '—'}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3">
        <div className="flex items-start gap-2">
          <History size={14} className="mt-0.5 shrink-0 text-[var(--color-brand-700)]" />
          <div>
            <div className="text-[9px] font-black text-[var(--color-text-primary)]">セグメント時系列</div>
            <p className="mt-0.5 text-[8px] font-semibold leading-4 text-[var(--color-text-secondary)]">{model.segmentTimeline.reason}</p>
            <p className="mt-1 font-mono text-[7px] text-[var(--color-text-tertiary)]">保存済み期間: {model.segmentTimeline.availablePeriods.map((row) => row.periodEnd).join(' / ') || 'なし'}</p>
          </div>
        </div>
      </section>
    </div>
  )
}

function EmployeesTab({ model }: { model: CompanyInformationReadModel }) {
  const consolidated = model.employees.latest.consolidated
  const standalone = model.employees.latest.nonConsolidated
  const summary = [
    ['連結従業員数', consolidated?.employeeCount == null ? '—' : `${formatNumber(consolidated.employeeCount)}人`],
    ['単体従業員数', standalone?.employeeCount == null ? '—' : `${formatNumber(standalone.employeeCount)}人`],
    ['平均年齢', standalone?.averageAgeYears == null ? '—' : `${formatNumber(standalone.averageAgeYears, 1)}歳`],
    ['平均勤続年数', standalone?.averageLengthOfServiceYears == null ? '—' : `${formatNumber(standalone.averageLengthOfServiceYears, 1)}年`],
    ['平均年間給与', standalone?.averageAnnualSalary == null ? '—' : formatMoney(standalone.averageAnnualSalary)],
  ]
  const maxEmployees = Math.max(0, ...model.employees.history.flatMap((row) => [
    row.consolidated?.employeeCount ?? 0,
    row.nonConsolidated?.employeeCount ?? 0,
  ]))
  return (
    <div className="space-y-3">
      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
        <SectionHeading icon={Users} title="従業員" subtitle="連結と単体を混ぜず、評価を加えずに表示" />
        <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] sm:grid-cols-5">
          {summary.map(([label, value]) => (
            <div key={label} className="bg-white px-3 py-3">
              <div className="text-[7px] font-black text-[var(--color-text-tertiary)]">{label}</div>
              <div className="mt-1 font-mono text-[12px] font-black text-[var(--color-text-primary)]">{value}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
        <SectionHeading icon={History} title="従業員・給与推移" subtitle="保存済み有報の期間だけを表示" />
        <div className="divide-y divide-[var(--color-border-soft)]">
          {model.employees.history.map((row) => (
            <div key={row.documentId} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2 text-[8px]">
                <span className="font-mono font-black text-[var(--color-text-primary)]">{row.periodEnd}</span>
                <span className="text-[var(--color-text-tertiary)]">公表 {row.publishedAt.slice(0, 10)}</span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {[
                  ['連結', row.consolidated?.employeeCount ?? null, '#0f4c81'],
                  ['単体', row.nonConsolidated?.employeeCount ?? null, '#51a2c8'],
                ].map(([label, rawValue, color]) => {
                  const value = rawValue as number | null
                  return (
                    <div key={String(label)} className="grid grid-cols-[32px_1fr_auto] items-center gap-2 text-[8px]">
                      <span className="font-black text-[var(--color-text-secondary)]">{label}</span>
                      <div className="h-2 bg-[var(--color-surface-subtle)]"><div className="h-full" style={{ width: `${value && maxEmployees > 0 ? (value / maxEmployees) * 100 : 0}%`, backgroundColor: String(color) }} /></div>
                      <span className="font-mono font-black">{value == null ? '—' : `${formatNumber(value)}人`}</span>
                    </div>
                  )
                })}
              </div>
              {row.nonConsolidated?.averageAnnualSalary != null && (
                <div className="mt-2 text-[8px] font-semibold text-[var(--color-text-secondary)]">単体平均給与 <span className="font-mono font-black text-[var(--color-text-primary)]">{formatMoney(row.nonConsolidated.averageAnnualSalary)}</span></div>
              )}
            </div>
          ))}
          {model.employees.history.length === 0 && <div className="px-4 py-5 text-[9px] text-[var(--color-text-tertiary)]">従業員履歴はありません。</div>}
        </div>
      </section>
    </div>
  )
}

function OfficersTab({ model }: { model: CompanyInformationReadModel }) {
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
      <SectionHeading icon={CircleUserRound} title="現任役員" subtitle={`${model.officers.officers.length}名 / 略歴は展開式`} />
      <div className="grid gap-px bg-[var(--color-border-soft)] lg:grid-cols-2">
        {model.officers.officers.map((officer) => (
          <article key={`${officer.name}:${officer.role ?? ''}`} className="min-w-0 bg-white px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-[11px] font-black text-[var(--color-text-primary)]">{officer.name}</h4>
                <p className="mt-0.5 text-[9px] font-bold leading-4 text-[var(--color-text-secondary)]">{officer.role ?? '役職未取得'}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                {officer.outside === true && <span className="border border-[var(--color-border-default)] px-1 py-0.5 text-[7px] font-black">社外</span>}
                {officer.independent === true && <span className="border border-[var(--color-brand-300)] bg-[var(--color-brand-50)] px-1 py-0.5 text-[7px] font-black text-[var(--color-brand-800)]">独立</span>}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[8px] font-semibold text-[var(--color-text-tertiary)]">
              <span>任期 <b className="text-[var(--color-text-primary)]">{officer.term ?? '—'}</b></span>
              <span>所有株式 <b className="font-mono text-[var(--color-text-primary)]">{officer.sharesHeld == null ? '—' : `${formatNumber(officer.sharesHeld)}株`}</b></span>
            </div>
            {officer.biography && (
              <details className="mt-2 border-t border-[var(--color-border-soft)] pt-2">
                <summary className="cursor-pointer text-[8px] font-black text-[var(--color-brand-700)]">略歴を見る</summary>
                <p className="mt-2 whitespace-pre-wrap text-[9px] font-medium leading-5 text-[var(--color-text-secondary)]">{officer.biography}</p>
              </details>
            )}
          </article>
        ))}
      </div>
      {model.officers.officers.length === 0 && <div className="px-4 py-5 text-[9px] text-[var(--color-text-tertiary)]">構造化された役員情報はありません。</div>}
      {model.officers.outsideOfficerNarrative && (
        <NarrativeDisclosure title="社外役員に関する開示" fact={model.officers.outsideOfficerNarrative} />
      )}
    </section>
  )
}

function PolicyHoldingTable({ rows }: { rows: PolicyHoldingRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] border-collapse text-left">
        <thead className="bg-[var(--color-surface-subtle)] text-[8px] font-black text-[var(--color-text-secondary)]">
          <tr><th className="px-3 py-2">順位</th><th className="px-3 py-2">銘柄・企業</th><th className="px-3 py-2">区分</th><th className="px-3 py-2 text-right">株式数</th><th className="px-3 py-2 text-right">計上額</th><th className="px-3 py-2">保有目的等</th></tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)] text-[9px]">
          {rows.map((row) => (
            <tr key={`${row.rank}:${row.issuerName}`}>
              <td className="px-3 py-2.5 font-mono">{row.rank}</td>
              <td className="px-3 py-2.5 font-black text-[var(--color-text-primary)]">{row.issuerName}</td>
              <td className="px-3 py-2.5">{row.holdingType ?? '—'}</td>
              <td className="px-3 py-2.5 text-right font-mono">{row.shares == null ? '—' : `${formatNumber(row.shares)}株`}</td>
              <td className="px-3 py-2.5 text-right font-mono">{formatMoney(row.bookValue)}</td>
              <td className="max-w-[360px] px-3 py-2.5 text-[8px] leading-4 text-[var(--color-text-secondary)]">{row.purpose ?? row.quantitativeEffect ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ShareholdersTab({ model }: { model: CompanyInformationReadModel }) {
  const summary = model.shareholders.policySummary
  return (
    <div className="space-y-3">
      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
        <SectionHeading icon={Landmark} title="大株主" subtitle={`${model.shareholders.major.length}件 / 最新有報`} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] border-collapse text-left">
            <thead className="bg-[var(--color-surface-subtle)] text-[8px] font-black text-[var(--color-text-secondary)]"><tr><th className="px-3 py-2">順位</th><th className="px-3 py-2">株主名</th><th className="px-3 py-2 text-right">所有株式数</th><th className="px-3 py-2 text-right">所有割合</th></tr></thead>
            <tbody className="divide-y divide-[var(--color-border-soft)] text-[9px]">
              {model.shareholders.major.map((row) => <tr key={`${row.rank}:${row.holderName}`}><td className="px-3 py-2.5 font-mono">{row.rank}</td><td className="px-3 py-2.5 font-black">{row.holderName}</td><td className="px-3 py-2.5 text-right font-mono">{row.shares == null ? '—' : `${formatNumber(row.shares)}株`}</td><td className="px-3 py-2.5 text-right font-mono">{formatHoldingRatio(row.holdingRatio)}</td></tr>)}
            </tbody>
          </table>
        </div>
        {model.shareholders.major.length === 0 && <div className="px-4 py-5 text-[9px] text-[var(--color-text-tertiary)]">大株主情報は取得できませんでした。</div>}
      </section>

      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
        <SectionHeading icon={ShieldCheck} title="政策保有株式" subtitle="特定投資株式とみなし保有を区別" />
        <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] sm:grid-cols-4">
          {[
            ['保有銘柄数', `${summary.count}銘柄`],
            ['計上額合計', formatMoney(summary.bookValueTotal)],
            ['自己資本比', formatPercent(summary.equityRatio)],
            ['時価総額比', formatPercent(summary.marketCapRatio)],
          ].map(([label, value]) => <div key={label} className="bg-white px-3 py-3"><div className="text-[7px] font-black text-[var(--color-text-tertiary)]">{label}</div><div className="mt-1 font-mono text-[12px] font-black text-[var(--color-text-primary)]">{value}</div></div>)}
        </div>
        {summary.reason && <p className="border-y border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2 text-[8px] font-semibold text-[var(--color-text-secondary)]">{summary.reason}</p>}
        <PolicyHoldingTable rows={model.shareholders.policy} />
        {model.shareholders.policy.length === 0 && <div className="px-4 py-5 text-[9px] text-[var(--color-text-tertiary)]">政策保有株式は取得できないか、開示対象がありません。</div>}
      </section>

      {model.shareholders.largeReports.length > 0 && (
        <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
          <SectionHeading icon={FileText} title="大量保有報告" subtitle="既存DBに保存済みの報告のみ" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead className="bg-[var(--color-surface-subtle)] text-[8px] font-black text-[var(--color-text-secondary)]"><tr><th className="px-3 py-2">提出日</th><th className="px-3 py-2">保有者</th><th className="px-3 py-2 text-right">保有割合</th><th className="px-3 py-2 text-right">前回</th><th className="px-3 py-2">目的</th></tr></thead>
              <tbody className="divide-y divide-[var(--color-border-soft)] text-[9px]">{model.shareholders.largeReports.map((row) => <tr key={row.documentId}><td className="px-3 py-2.5 font-mono">{row.submittedAt?.slice(0, 10) ?? '—'}</td><td className="px-3 py-2.5 font-black">{row.holderName ?? '—'}</td><td className="px-3 py-2.5 text-right font-mono">{formatHoldingRatio(row.holdingRatio)}</td><td className="px-3 py-2.5 text-right font-mono">{formatHoldingRatio(row.previousHoldingRatio)}</td><td className="max-w-[320px] px-3 py-2.5 text-[8px]">{row.purpose ?? '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function SourceNote({ model }: { model: CompanyInformationReadModel }) {
  return (
    <section className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3">
      <div className="flex items-start gap-2">
        <FileText size={14} className="mt-0.5 shrink-0 text-[var(--color-brand-700)]" />
        <div className="min-w-0">
          <div className="text-[9px] font-black text-[var(--color-text-primary)]">EDINET法定開示</div>
          <p className="mt-0.5 break-all font-mono text-[7px] text-[var(--color-text-tertiary)]">{model.snapshot.documentId} / 公表 {model.snapshot.publishedAt} / 対象 {model.snapshot.periodEnd ?? '—'}</p>
          <p className="mt-1 text-[8px] font-semibold leading-4 text-[var(--color-text-secondary)]">{model.sourcePolicy.edinet}</p>
          <p className="text-[8px] font-semibold leading-4 text-[var(--color-text-secondary)]">{model.sourcePolicy.shikiho}</p>
        </div>
      </div>
    </section>
  )
}

export function CompanyInformationDetail({ ticker, analysisDate }: CompanyInformationDetailProps) {
  const [model, setModel] = useState<CompanyInformationReadModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<CompanySubTab>('overview')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (analysisDate) params.set('as_of', analysisDate)
    fetch(`/api/company-information/${encodeURIComponent(ticker)}${params.size ? `?${params}` : ''}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? '企業情報の保存データがありません。' : '企業情報を取得できませんでした。')
        return response.json() as Promise<CompanyInformationReadModel>
      })
      .then(setModel)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [analysisDate, ticker])

  const currentContent = useMemo(() => {
    if (!model) return null
    if (tab === 'segments') return <SegmentsTab model={model} />
    if (tab === 'employees') return <EmployeesTab model={model} />
    if (tab === 'officers') return <OfficersTab model={model} />
    if (tab === 'shareholders') return <ShareholdersTab model={model} />
    return <OverviewTab model={model} />
  }, [model, tab])

  if (loading) {
    return <div className="border border-[var(--color-border-default)] bg-white px-4 py-10 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">企業情報を読み込んでいます…</div>
  }
  if (error || !model) {
    return <div className="border border-[var(--color-border-default)] bg-white px-4 py-10 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">{error ?? '企業情報がありません。'}</div>
  }

  return (
    <div className="space-y-3">
      <header className="border border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><Building2 size={17} className="text-[var(--color-brand-700)]" /><h2 className="text-[14px] font-black text-[var(--color-brand-900)]">企業情報</h2></div>
            <p className="mt-0.5 text-[8px] font-semibold text-[var(--color-text-secondary)]">EDINET法定開示 / 最新有報を基準</p>
          </div>
          <div className="text-right text-[7px] font-semibold text-[var(--color-text-tertiary)]"><div>分析基準日 {model.asOf}</div><div>有報 {model.snapshot.periodEnd ?? '—'}</div></div>
        </div>
      </header>
      <nav className="flex overflow-x-auto border border-[var(--color-border-default)] bg-white" aria-label="企業情報の表示切替">
        {SUB_TABS.map((item) => {
          const Icon = item.icon
          return <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[9px] font-black ${tab === item.id ? 'border-[var(--color-market-red)] bg-[var(--color-surface-subtle)] text-[var(--color-brand-900)]' : 'border-transparent text-[var(--color-text-secondary)]'}`} aria-pressed={tab === item.id}><Icon size={12} />{item.label}</button>
        })}
      </nav>
      {currentContent}
      {tab !== 'overview' && <SourceNote model={model} />}
    </div>
  )
}
