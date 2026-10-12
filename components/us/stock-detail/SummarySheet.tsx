import type { ReactNode } from 'react'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import {
  normalizeStage,
  shortStageLabel,
  STAGE_TIMEFRAME_LABELS,
  US_STAGE_KEYS,
  type UsStageEntry,
} from './technical-view'

/** サマリーの1行。左の共通見出し軸(sm以上は固定幅)と横罫で読む。モバイルは見出しの下に内容を縦に流す */
export function SheetRow({
  label,
  note,
  level = 3,
  children,
}: {
  label: string
  note?: string
  level?: 3 | 4
  children: ReactNode
}) {
  const Heading = level === 3 ? 'h3' : 'h4'
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-1.5 border-t border-[var(--color-border-soft)] py-3 first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 sm:block">
        <Heading
          className={level === 3
            ? 'm-0 text-[12px] font-bold leading-5 text-[var(--color-text-primary)]'
            : 'm-0 text-[11px] font-bold leading-5 text-[var(--color-text-secondary)]'}
        >
          {label}
        </Heading>
        {note && <span className="block font-mono text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{note}</span>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** 二次レイヤーの値。ラベルを上、数値(mono/tabular)を下に置き、列で比べる */
export function LedgerItem({ label, value, detail, color }: { label: string; value: string; detail?: string; color?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className="m-0 font-mono text-[13px] font-semibold tabular-nums" style={{ color: color ?? 'var(--color-text-primary)' }}>
        <span className="break-words">{value}</span>
        {detail && <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">{detail}</span>}
      </dd>
    </div>
  )
}

export function ConditionList({ conditions }: { conditions: string[] }) {
  return (
    <ul className="m-0 mt-0.5 grid gap-0.5 p-0">
      {conditions.map((condition) => (
        <li key={condition} className="flex gap-1.5 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]">
          <span className="mt-2 h-1 w-1 shrink-0 bg-[var(--color-text-tertiary)]" aria-hidden="true" />
          <span className="min-w-0">{condition}</span>
        </li>
      ))}
    </ul>
  )
}

/** 過去分析モードで表示しない現在情報を、空欄やダッシュではなく理由付きで示す */
export function CurrentOnlyDataNotice({ label }: { label: string }) {
  return (
    <p className="m-0 rounded-[4px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
      {label}
    </p>
  )
}

/** 6軸Stageを日足・週足・月足の順に1本のリボンで並べる(区画の間は1px、時間軸の間だけ少し空ける) */
export function StageRibbon({ stage }: { stage: UsStageEntry }) {
  return (
    <div className="grid max-w-[720px] grid-cols-3 gap-1" role="group" aria-label="6ステージ(日足・週足・月足 × A・B)" data-overview-stage-ribbon>
      {[0, 2, 4].map((start) => (
        <div key={start} role="group" aria-label={STAGE_TIMEFRAME_LABELS[start / 2]} className="min-w-0">
          <span className="mb-1 block text-[11px] font-bold text-[var(--color-text-secondary)]">{STAGE_TIMEFRAME_LABELS[start / 2]}</span>
          <div className="grid grid-cols-2 gap-px">
            {US_STAGE_KEYS.slice(start, start + 2).map(({ key, label }) => (
              <SixStageCell key={key} label={label} stage={stage[key]} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function SixStageCell({ label, stage }: { label: string; stage: number | null }) {
  const validStage = normalizeStage(stage)
  const color = validStage ? STAGE_BORDER_COLORS[validStage] : 'var(--color-border-default)'
  const bg = validStage ? STAGE_BG_COLORS[validStage] : 'var(--color-surface-subtle)'
  const title = validStage ? STAGE_LABELS[validStage] : '未判定'
  return (
    <div
      title={`${label}: ${title}`}
      className="min-w-0 px-1 pb-1.5 pt-2 text-center"
      style={{ background: bg, boxShadow: `inset 0 3px 0 ${color}` }}
    >
      <span className="block text-[11px] font-bold leading-4 text-[var(--color-text-secondary)]">{label}</span>
      <strong className="block font-mono text-[15px] font-black leading-5 text-[var(--color-text-primary)]">
        {validStage ? `S${validStage}` : '-'}
      </strong>
      <span className="block text-[11px] font-semibold leading-tight text-[var(--color-text-secondary)] [word-break:keep-all]">
        <span className="sr-only">{title} </span>
        <span aria-hidden="true">{validStage ? shortStageLabel(validStage) : '不足'}</span>
      </span>
    </div>
  )
}
