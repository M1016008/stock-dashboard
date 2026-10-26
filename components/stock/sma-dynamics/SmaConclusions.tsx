'use client'

// Plain-language results for Price Freeze and the price scenario. Numbers come straight
// from the computed series; nothing here recalculates or interpolates.
import type { ReactNode } from 'react'
import { describeHorizon, type SmaLabAvailable, type SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import { SMA_DELTA_BEGINNER } from '@/lib/sma-dynamics-insight'
import type { ScenarioEvaluation } from '@/lib/sma-dynamics-scenario'
import { formatPct, type PriceFormat } from './SmaDynamicsPanels'
import { ConclusionRows, DirectionGlyph, SmaDot } from './SmaSimulationParts'

function direction(delta: number | null) {
  if (delta == null) return null
  return delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
}

const MOVE_WORD = { up: '上がります', down: '下がります', flat: '変わりません' } as const
const SLOPE_WORD = { up: '上向き', down: '下向き', flat: '横ばい' } as const

export function FreezeConclusion({ result, periods, fmt }: { result: SmaLabAvailable; periods: readonly SmaLabPeriod[]; fmt: PriceFormat }) {
  const horizon = result.projection.bars.length
  const rows = result.periods.filter((summary) => summary.status === 'ok' && periods.includes(summary.period))
  const items: Array<{ label: string; body: ReactNode }> = [
    {
      label: '前提',
      body: <>終値が基準日 ({result.asOf.date}) の <b className="font-mono">{fmt(result.asOf.close)}</b> のまま、T+{horizon} ({describeHorizon(result.timeframe, horizon, result.projection.bars)}) まで動かないと仮定します。</>,
    },
  ]
  if (rows.length === 0) {
    items.push({ label: '結果', body: '表示するSMAを選んでください。' })
  } else {
    items.push({
      label: '結果',
      body: (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {rows.map((summary) => {
            const first = direction(summary.anchorValue == null ? null : (result.projection.sma[summary.period][0] ?? NaN) - summary.anchorValue)
            const overall = direction(summary.endChange)
            return (
              <li key={summary.period} data-conclusion-period={summary.period}>
                <span className="inline-flex items-center gap-1 font-mono font-bold"><SmaDot period={summary.period} />SMA{summary.period}</span>{' '}
                <span className="font-mono">{fmt(summary.anchorValue)} → {fmt(summary.endValue)} ({formatPct(summary.endChangePct)})</span>
                {overall && <span>。T+{horizon} までに{MOVE_WORD[overall]}</span>}
                {first && <span>。T+1 は前の足より{SLOPE_WORD[first]} <DirectionGlyph direction={first} /></span>}
              </li>
            )
          })}
        </ul>
      ),
    })
  }
  const settled = rows.filter((summary) => summary.period <= horizon)
  items.push({
    label: 'しくみ',
    body: (
      <span className="text-[var(--color-text-secondary)]">
        {SMA_DELTA_BEGINNER}価格固定では、新しく加わる株価がすべて固定した価格になります。
        {settled.length > 0 && ` ${settled.map((summary) => `SMA${summary.period} は T+${summary.period}`).join('、')} 以降、窓の中がすべて固定した価格になるため ${fmt(result.asOf.close)} で一定になります。`}
      </span>
    ),
  })
  return <div data-sma-conclusion data-sma-conclusion-mode="freeze"><ConclusionRows items={items} /></div>
}

/**
 * One-sentence lead for a selected scenario, built from the evaluated series: the assumed
 * close move at the last projected bar and each selected SMA's direction on that bar only
 * (exact sign vs. the previous bar, as in the result rows). Says nothing about earlier bars.
 */
export function scenarioResultLead({ result, evaluation, periods }: { result: SmaLabAvailable; evaluation: ScenarioEvaluation; periods: readonly SmaLabPeriod[] }): string {
  const horizon = result.projection.bars.length
  const last = horizon - 1
  const pct = evaluation.cells[last]?.pctFromAnchor ?? null
  const move = pct == null || !Number.isFinite(pct)
    ? `T+${horizon}の仮定終値はありません。`
    : `T+${horizon}の仮定終値は基準日比 ${formatPct(pct)}。`
  const groups = new Map<keyof typeof SLOPE_WORD, string[]>()
  const unavailable: string[] = []
  for (const period of periods) {
    const summary = result.periods.find((item) => item.period === period)
    const series = evaluation.sma[period]
    const value = summary?.status === 'ok' && series ? series[last] : null
    const previous = last > 0 ? series?.[last - 1] ?? null : summary?.anchorValue ?? null
    const slope = value == null || previous == null ? null : direction(value - previous)
    if (slope) groups.set(slope, [...(groups.get(slope) ?? []), `SMA${period}`])
    else unavailable.push(`SMA${period}`)
  }
  const parts = [...groups].map(([slope, names]) => `${names.join('・')}は${SLOPE_WORD[slope]}`)
  return [
    move,
    parts.length > 0 ? `その足では、${parts.join('、')}です。` : '',
    unavailable.length > 0 ? `${unavailable.join('・')}はその足の値を計算できません。` : '',
  ].join('')
}

export function ScenarioConclusion({
  result,
  evaluation,
  periods,
  fmt,
  premise,
  lead,
}: {
  result: SmaLabAvailable
  evaluation: ScenarioEvaluation
  periods: readonly SmaLabPeriod[]
  fmt: PriceFormat
  /** Replaces the "入力した…" premise when the closes came from a selected scenario, not typing. */
  premise?: ReactNode
  /** One-sentence result shown before the rows (selected scenarios). */
  lead?: string
}) {
  const horizon = result.projection.bars.length
  if (evaluation.filled === 0) {
    return (
      <div data-sma-conclusion data-sma-conclusion-mode="scenario" data-empty="true">
        <ConclusionRows
          items={[
            { label: '前提', body: `基準日 (${result.asOf.date}) の終値 ${fmt(result.asOf.close)} から先の価格を、あなたが入力します。` },
            { label: '次の操作', body: '「例から始める」を押すか、T+1 以降の終値を直接入力してください。入力するたびにチャートのSMAが再計算されます。' },
          ]}
        />
      </div>
    )
  }
  const lastFilled = [...evaluation.cells].reverse().find((cell) => cell.close != null)
  const rows = result.periods.filter((summary) => summary.status === 'ok' && periods.includes(summary.period))
  const items: Array<{ label: string; body: ReactNode }> = [
    {
      label: '前提',
      body: premise ?? (
        <>
          入力した {evaluation.filled}/{horizon}本の終値で再計算しました
          {lastFilled && <>。最後の入力 T+{lastFilled.k} は <b className="font-mono">{fmt(lastFilled.close)}</b> (現値比 {formatPct(lastFilled.pctFromAnchor)})</>}。
        </>
      ),
    },
    {
      label: '結果',
      body: rows.length === 0 ? '表示するSMAを選んでください。' : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {rows.map((summary) => {
            const series = evaluation.sma[summary.period]
            let k = -1
            for (let i = series.length - 1; i >= 0; i -= 1) if (series[i] != null) { k = i; break }
            if (k < 0) {
              return (
                <li key={summary.period} data-conclusion-period={summary.period}>
                  <span className="inline-flex items-center gap-1 font-mono font-bold"><SmaDot period={summary.period} />SMA{summary.period}</span>{' '}
                  未入力の足を含む計算窓のため、まだ表示できません。
                </li>
              )
            }
            const value = series[k]!
            const previous = k > 0 ? series[k - 1] : summary.anchorValue
            const slope = direction(previous == null ? null : value - previous)
            const frozen = result.projection.sma[summary.period][k]
            return (
              <li key={summary.period} data-conclusion-period={summary.period}>
                <span className="inline-flex items-center gap-1 font-mono font-bold"><SmaDot period={summary.period} />SMA{summary.period}</span>{' '}
                <span className="font-mono">T+{k + 1} で {fmt(value)}</span>
                <span> (最終確定足 {fmt(summary.anchorValue)} 比 {formatPct(summary.anchorValue == null ? null : ((value - summary.anchorValue) / summary.anchorValue) * 100)}。価格固定なら {fmt(frozen)})</span>
                {slope && <span>。その足では{SLOPE_WORD[slope]} <DirectionGlyph direction={slope} /></span>}
              </li>
            )
          })}
        </ul>
      ),
    },
  ]
  if (evaluation.missingK.length > 0 && evaluation.filled > 0) {
    items.push({ label: '注意', body: <span className="text-[var(--color-text-secondary)]">未入力の足は補完しません。その足を含む計算窓のSMAは表示しません。</span> })
  }
  return (
    <div data-sma-conclusion data-sma-conclusion-mode="scenario">
      {lead && <p className="m-0 mb-2 text-[14px] font-bold leading-6 text-[var(--color-text-primary)]" data-scenario-result-lead>{lead}</p>}
      <ConclusionRows items={items} />
    </div>
  )
}
