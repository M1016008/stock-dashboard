// components/hex/TransitionMatrixMock.tsx
// 期間内のステージ遷移を、行=移動前 / 列=移動先のフローマップとして表示する。

import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { getTransitionMatrix, type Timescale, type Period } from '@/lib/queries/hex'

const STAGES = [1, 2, 3, 4, 5, 6] as const

const PERIOD_LABEL: Record<Period, string> = {
  today: '本日',
  week: '今週',
  month: '今月',
}

const TIMESCALE_LABEL: Record<Timescale, string> = {
  daily_a: '日足A',
  daily_b: '日足B',
  weekly_a: '週足A',
  weekly_b: '週足B',
  monthly_a: '月足A',
  monthly_b: '月足B',
}

type Relation = 'cycle' | 'reverse' | 'jump'

const RELATION_META: Record<Relation, { label: string; rgb: string; text: string; note: string }> = {
  cycle: {
    label: '循環順',
    rgb: '22, 163, 74',
    text: '#14532d',
    note: '1→2→3→4→5→6→1 の向き',
  },
  reverse: {
    label: '逆方向',
    rgb: '37, 99, 235',
    text: '#1e3a8a',
    note: '循環と反対向きの戻り',
  },
  jump: {
    label: '大きな変化',
    rgb: '217, 119, 6',
    text: '#713f12',
    note: '隣接ステージを飛ばす変化',
  },
}

export async function TransitionMatrixMock({ timescale, period }: { timescale: Timescale; period: Period }) {
  const cells = await getTransitionMatrix(timescale, period)
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0)
  const total = cells.reduce((a, c) => a + c.count, 0)
  const get = (from: number, to: number) =>
    cells.find((c) => c.from_stage === from && c.to_stage === to)?.count ?? 0

  const totals = cells.reduce(
    (acc, cell) => {
      const relation = getRelation(cell.from_stage, cell.to_stage)
      acc[relation] += cell.count
      return acc
    },
    { cycle: 0, reverse: 0, jump: 0 } satisfies Record<Relation, number>,
  )
  const topRoutes = [...cells].sort((a, b) => b.count - a.count).slice(0, 4)
  const top = topRoutes[0]

  return (
    <div>
      <div className="sb-hd">
        <h2 className="sb-h2-sm">ステージ遷移フロー</h2>
        <span>
          {TIMESCALE_LABEL[timescale]} · {PERIOD_LABEL[period]} · 合計 {total.toLocaleString()} 件
        </span>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label="集計対象"
          value={`${PERIOD_LABEL[period]}の変化`}
          detail="同じステージに留まった銘柄は除外"
        />
        <SummaryTile
          label="最多ルート"
          value={top ? `${top.from_stage} → ${top.to_stage}` : 'なし'}
          detail={top ? `${top.count.toLocaleString()}件 / ${formatPct(top.count, total)}` : '遷移なし'}
        />
        <SummaryTile
          label={RELATION_META.cycle.label}
          value={`${totals.cycle.toLocaleString()}件`}
          detail={RELATION_META.cycle.note}
          tone="cycle"
        />
        <SummaryTile
          label={RELATION_META.reverse.label}
          value={`${totals.reverse.toLocaleString()}件`}
          detail={RELATION_META.reverse.note}
          tone="reverse"
        />
      </div>

      <div className="sb-card">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
          <span>行が移動前、列が移動先です。</span>
          <span>色が濃いほど件数が多く、色味で遷移の種類を分けています。</span>
          <span className="text-[var(--color-text-tertiary)]">対角線は維持のため集計外です。</span>
        </div>

        <div className="overflow-x-auto">
          <div
            className="grid gap-1.5 text-[11px] tabular-nums"
            style={{ gridTemplateColumns: '108px repeat(6, minmax(86px, 1fr))', minWidth: 680 }}
          >
            <div className="flex items-end justify-end pr-1 text-[10px] text-[var(--color-text-tertiary)]">
              FROM / TO
            </div>
            {STAGES.map((stage) => (
              <StageHeader key={`to-${stage}`} stage={stage} prefix="→" />
            ))}

            {STAGES.map((from) => (
              <MatrixRow key={`row-${from}`} from={from} get={get} max={max} total={total} />
            ))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1.35fr]">
          <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
            <div className="mb-2 text-[11px] font-semibold text-[var(--color-text-primary)]">色の読み方</div>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(RELATION_META) as Relation[]).map((key) => {
                const meta = RELATION_META[key]
                return (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium"
                    style={{
                      borderColor: `rgba(${meta.rgb}, 0.35)`,
                      background: `rgba(${meta.rgb}, 0.10)`,
                      color: meta.text,
                    }}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: `rgb(${meta.rgb})` }}
                    />
                    {meta.label}
                  </span>
                )
              })}
            </div>
          </div>

          <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-white p-3">
            <div className="mb-2 text-[11px] font-semibold text-[var(--color-text-primary)]">
              件数の多い遷移
            </div>
            {topRoutes.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {topRoutes.map((route) => (
                  <RouteChip
                    key={`${route.from_stage}-${route.to_stage}`}
                    from={route.from_stage}
                    to={route.to_stage}
                    count={route.count}
                    total={total}
                  />
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-[var(--color-text-tertiary)]">この期間にステージ変化はありません。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MatrixRow({
  from,
  get,
  max,
  total,
}: {
  from: number
  get: (from: number, to: number) => number
  max: number
  total: number
}) {
  return (
    <>
      <StageHeader stage={from} suffix="→" align="right" />
      {STAGES.map((to) => {
        const n = get(from, to)
        const isDiag = from === to
        if (isDiag) {
          return (
            <div
              key={`cell-${from}-${to}`}
              className="flex min-h-[54px] items-center justify-center rounded-[6px] border border-dashed border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]"
              title={`${from}→${to}: 維持は集計外`}
            >
              -
            </div>
          )
        }

        const relation = getRelation(from, to)
        const meta = RELATION_META[relation]
        const intensity = max > 0 ? Math.sqrt(n / max) : 0
        const alpha = n > 0 ? 0.08 + intensity * 0.48 : 0

        return (
          <div
            key={`cell-${from}-${to}`}
            className="flex min-h-[54px] flex-col items-center justify-center rounded-[6px] border px-1 text-center transition-colors"
            style={{
              borderColor: n > 0 ? `rgba(${meta.rgb}, ${0.18 + intensity * 0.38})` : 'var(--color-border-soft)',
              background: n > 0 ? `rgba(${meta.rgb}, ${alpha.toFixed(2)})` : 'var(--color-surface-subtle)',
              color: n > 0 && intensity > 0.62 ? meta.text : 'var(--color-text-primary)',
            }}
            title={`${from}→${to}: ${n.toLocaleString()}件 (${formatPct(n, total)})`}
          >
            {n > 0 ? (
              <>
                <span className="text-[13px] font-semibold leading-none">{n.toLocaleString()}</span>
                <span className="mt-1 text-[10px] text-[var(--color-text-secondary)]">{formatPct(n, total)}</span>
              </>
            ) : (
              <span className="text-[10px] text-[var(--color-text-tertiary)]">0</span>
            )}
          </div>
        )
      })}
    </>
  )
}

function StageHeader({
  stage,
  prefix = '',
  suffix = '',
  align = 'center',
}: {
  stage: number
  prefix?: string
  suffix?: string
  align?: 'center' | 'right'
}) {
  return (
    <div
      className={`flex min-h-[42px] flex-col justify-center rounded-[6px] border px-2 ${
        align === 'right' ? 'items-end text-right' : 'items-center text-center'
      }`}
      style={{
        background: STAGE_BG_COLORS[stage],
        borderColor: STAGE_BORDER_COLORS[stage],
        color: STAGE_BORDER_COLORS[stage],
      }}
      title={STAGE_LABELS[stage]}
    >
      <span className="text-[12px] font-bold">
        {prefix}
        {stage}
        {suffix}
      </span>
      <span className="mt-0.5 max-w-full truncate text-[9px] font-medium opacity-80">{STAGE_LABELS[stage]}</span>
    </div>
  )
}

function SummaryTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone?: Relation
}) {
  const meta = tone ? RELATION_META[tone] : null
  return (
    <div
      className="rounded-[6px] border p-3"
      style={{
        borderColor: meta ? `rgba(${meta.rgb}, 0.28)` : 'var(--color-border-soft)',
        background: meta ? `rgba(${meta.rgb}, 0.07)` : 'var(--color-surface-subtle)',
      }}
    >
      <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[17px] font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</div>
      <div className="mt-1 text-[10px] leading-4 text-[var(--color-text-secondary)]">{detail}</div>
    </div>
  )
}

function RouteChip({ from, to, count, total }: { from: number; to: number; count: number; total: number }) {
  const relation = getRelation(from, to)
  const meta = RELATION_META[relation]
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-[6px] border px-2.5 py-2"
      style={{ borderColor: `rgba(${meta.rgb}, 0.24)`, background: `rgba(${meta.rgb}, 0.06)` }}
    >
      <div className="flex items-center gap-1.5">
        <MiniStage stage={from} />
        <span className="text-[11px] text-[var(--color-text-tertiary)]">→</span>
        <MiniStage stage={to} />
        <span className="ml-1 text-[10px] font-medium" style={{ color: meta.text }}>
          {meta.label}
        </span>
      </div>
      <div className="text-right">
        <div className="text-[12px] font-semibold tabular-nums text-[var(--color-text-primary)]">
          {count.toLocaleString()}件
        </div>
        <div className="text-[10px] tabular-nums text-[var(--color-text-tertiary)]">{formatPct(count, total)}</div>
      </div>
    </div>
  )
}

function MiniStage({ stage }: { stage: number }) {
  return (
    <span
      className="inline-flex h-6 min-w-6 items-center justify-center rounded-[5px] border px-1.5 text-[11px] font-bold"
      style={{
        background: STAGE_BG_COLORS[stage],
        borderColor: STAGE_BORDER_COLORS[stage],
        color: STAGE_BORDER_COLORS[stage],
      }}
    >
      {stage}
    </span>
  )
}

function getRelation(from: number, to: number): Relation {
  const forwardSteps = (to - from + 6) % 6
  const backwardSteps = (from - to + 6) % 6
  if (forwardSteps === 1) return 'cycle'
  if (backwardSteps === 1) return 'reverse'
  return 'jump'
}

function formatPct(count: number, total: number): string {
  if (total <= 0) return '0.0%'
  return `${((count / total) * 100).toFixed(1)}%`
}
