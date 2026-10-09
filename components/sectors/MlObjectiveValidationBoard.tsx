import type { MlObjectiveValidation } from '@/lib/queries/ml-insights'
import { SectionHeader } from '@/components/ui/SectionHeader'

function fmtRate(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(1)}%`
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtLift(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(2)}x`
}

function variantLabel(variant: MlObjectiveValidation['variant']) {
  return variant === 'enhanced' ? '強化版' : '基準版'
}

function directionLabel(direction: 'up' | 'down') {
  return direction === 'up' ? '上昇候補' : '下落警戒'
}

function splitLabel(split: 'validation' | 'test') {
  return split === 'test' ? '未学習テスト' : '調整検証'
}

function toneFor(direction: 'up' | 'down') {
  return direction === 'up' ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

function ValidationTable({
  title,
  rows,
}: {
  title: string
  rows: MlObjectiveValidation[]
}) {
  const periodLabel = rows[0]?.split === 'test'
    ? `${rows[0]?.validationStartDate ?? '-'} → 期間ごとの確定日`
    : `${rows[0]?.validationStartDate ?? '-'} → ${rows[0]?.validationEndDate ?? '-'}`
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {periodLabel}
        </span>
      </div>
      <div className="table-scroll">
        <table className="w-full min-w-[760px] text-[12px]">
          <thead>
            <tr className="text-left text-[11px] font-bold">
              <th className="py-2 pl-3 pr-2">期間</th>
              <th className="py-2 pr-2">方向</th>
              <th className="py-2 pr-2 text-right">条件</th>
              <th className="py-2 pr-2 text-right">市場</th>
              <th className="py-2 pr-2 text-right">上位20</th>
              <th className="py-2 pr-2 text-right">上位60</th>
              <th className="py-2 pr-2 text-right">Lift</th>
              <th className="py-2 pr-2 text-right">逆行率</th>
              <th className="py-2 pr-2 text-right">順行幅</th>
              <th className="py-2 pr-3 text-right">件数</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {rows.map((row) => (
              <tr key={`${row.variant}-${row.split}-${row.horizonDays}-${row.direction}`}>
                <td className="py-2 pl-3 pr-2 font-bold tabular-nums text-[var(--color-brand-900)]">
                  {row.horizonDays}日
                </td>
                <td className={`py-2 pr-2 font-bold ${toneFor(row.direction)}`}>
                  {directionLabel(row.direction)}
                  <span className="ml-1 rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-tertiary)]">
                    {variantLabel(row.variant)}
                  </span>
                </td>
                <td className="py-2 pr-2 text-right font-bold tabular-nums text-[var(--color-text-secondary)]">
                  {fmtPct(row.targetPct)}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">
                  {fmtRate(row.baselineHitRate)}
                </td>
                <td className="py-2 pr-2 text-right font-bold tabular-nums text-[var(--color-brand-900)]">
                  {fmtRate(row.top20HitRate)}
                </td>
                <td className="py-2 pr-2 text-right font-bold tabular-nums text-[var(--color-brand-900)]">
                  {fmtRate(row.top60HitRate)}
                </td>
                <td className="py-2 pr-2 text-right font-bold tabular-nums text-[var(--color-brand-900)]">
                  {fmtLift(row.liftTop60VsBaseline)}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">
                  {fmtRate(row.top60AdverseRate)}
                </td>
                <td className={`py-2 pr-2 text-right font-bold tabular-nums ${toneFor(row.direction)}`}>
                  {fmtPct(row.top60AvgDirectionalReturnPct)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">
                  {row.sampleCount.toLocaleString('ja-JP')}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-5 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">
                  検証結果は未作成です
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function MlObjectiveValidationBoard({
  rows,
}: {
  rows: MlObjectiveValidation[]
}) {
  const sorted = [...rows].sort((a, b) =>
    a.split.localeCompare(b.split)
    || a.horizonDays - b.horizonDays
    || a.direction.localeCompare(b.direction),
  )
  const testRows = sorted.filter((row) => row.split === 'test')
  const validationRows = sorted.filter((row) => row.split === 'validation')
  const train = sorted[0]

  return (
    <section className="min-w-0">
      <SectionHeader
        level={1}
        title="ML客観検証"
        description="過去だけで学習し、検証期間と未学習のテスト期間で答え合わせした結果です。"
        actions={train ? (
          <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            学習 {train.trainStartDate ?? '-'} → {train.trainEndDate ?? '-'}
          </span>
        ) : undefined}
      />

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        <ValidationTable title={splitLabel('test')} rows={testRows} />
        <ValidationTable title={splitLabel('validation')} rows={validationRows} />
      </div>

      <div className="mt-3 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
        市場は同期間の全サンプル到達率、上位20/60はモデルスコア順の上位群です。Liftは上位60到達率 ÷ 市場到達率、逆行率は反対方向条件に入った割合です。通常表示は強化版のみで、基準版はAPIのvariant指定で確認できます。
      </div>
    </section>
  )
}
