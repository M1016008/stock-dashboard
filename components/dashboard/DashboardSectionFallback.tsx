// components/dashboard/DashboardSectionFallback.tsx
//
// Dashboard の読み込み中プレースホルダー。
// 完成形と同じ骨組み (罫線・列・行の高さ) を描き、データが入ったときのずれを抑える。
// サーバー専用の依存を持たないこと (日付切替中ビュー = クライアントからも使うため)。

import {
  SIGNAL_AREA,
  SIGNAL_ROW_GRID,
  SIGNAL_SUB_GRID,
  SkeletonBlock,
} from '@/components/dashboard/DashboardPrimitives'

export const DASHBOARD_SECTION_META = {
  momentum: { label: '市場マップ', description: '勢いの4レーンと17業種のPMS分布', height: 760 },
  signals: { label: '売買候補', description: 'シナリオを集約した買う/売る候補', height: 900 },
  'trade-overview': { label: 'シナリオ進捗', description: '保存した売買シナリオの到達・撤退', height: 420 },
  events: { label: '決算・材料', description: '決算予定と発表後、株探の材料ニュース', height: 560 },
  earnings: { label: '決算注意', description: '決算予定と発表後フォロー', height: 520 },
  materials: { label: '材料', description: '株探の材料ニュース', height: 460 },
  research: { label: '次の分析', description: 'AI銘柄リサーチへの入口', height: 96 },
} as const

export type DashboardSectionId = keyof typeof DASHBOARD_SECTION_META

function RowLines({ rows, rowClassName }: { rows: number; rowClassName: string }) {
  return (
    <div className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={rowClassName}>
          <SkeletonBlock className="h-3 w-12" />
          <div className="grid min-w-0 gap-1.5">
            <SkeletonBlock className={`h-3 ${index % 3 === 0 ? 'w-3/5' : index % 3 === 1 ? 'w-4/5' : 'w-2/3'}`} />
            <SkeletonBlock className="h-2.5 w-2/5" />
          </div>
          <SkeletonBlock className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  )
}

function SectionBody({ section }: { section: DashboardSectionId }) {
  switch (section) {
    case 'momentum':
      return (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7">
          <SkeletonBlock className="h-3 w-2/5" />
          <div className="grid grid-cols-[minmax(0,1fr)] gap-y-5 md:grid-cols-2 md:gap-x-6 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, lane) => (
              <div key={lane} className="min-w-0 border-t-2 border-[var(--color-border-default)]">
                <SkeletonBlock className="my-2.5 h-3 w-16" />
                {Array.from({ length: 8 }, (_, index) => (
                  <div key={index} className={`grid grid-cols-[16px_minmax(0,1fr)_3rem] items-center gap-x-2 border-t border-[var(--color-border-soft)] py-2 ${index >= 5 ? 'max-md:hidden' : ''}`}>
                    <SkeletonBlock className="h-2.5 w-3" />
                    <div className="grid gap-1.5">
                      <SkeletonBlock className="h-3 w-4/5" />
                      <SkeletonBlock className="h-2.5 w-3/5" />
                    </div>
                    <SkeletonBlock className="ml-auto h-3 w-10" />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 lg:grid-cols-2">
            {[0, 1].map((column) => (
              <div key={column} className={`divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-default)] ${column === 1 ? 'max-lg:border-t-0' : ''}`}>
                {Array.from({ length: 9 }, (_, index) => (
                  <div key={index} className="grid grid-cols-[8rem_minmax(0,1fr)_3.5rem] items-center gap-x-3 py-[9px]">
                    <SkeletonBlock className="h-3 w-24" />
                    <SkeletonBlock className="h-[6px] w-full" />
                    <SkeletonBlock className="ml-auto h-3 w-10" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )
    case 'signals':
      return (
        <div>
          <div className="grid gap-x-8 gap-y-3 border-b border-[var(--color-border-soft)] pb-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-end">
            <div>
              <SkeletonBlock className="mb-1.5 h-2.5 w-16" />
              <SkeletonBlock className="h-9 w-48" />
            </div>
            <div>
              <SkeletonBlock className="mb-1.5 h-2.5 w-2/5" />
              <SkeletonBlock className="h-9 w-full" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-[var(--color-border-soft)] py-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index}>
                <SkeletonBlock className="mb-1 h-2.5 w-14" />
                <SkeletonBlock className="h-8 w-full" />
              </div>
            ))}
          </div>
          {/* 件数行 + 免責文 */}
          <div className="grid gap-1.5 py-2">
            <div className="flex items-center justify-between gap-4">
              <SkeletonBlock className="h-2.5 w-1/2" />
              <SkeletonBlock className="h-7 w-32" />
            </div>
            <SkeletonBlock className="h-2.5 w-2/3" />
          </div>
          {/* 一覧と同じ列定義 (SIGNAL_ROW_GRID) で骨組みを描く */}
          <div className="border-y border-l-2 border-y-[var(--color-border-default)] border-l-[var(--color-border-soft)]">
            <div className={`hidden border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1.5 md:grid ${SIGNAL_ROW_GRID}`}>
              <SkeletonBlock className={`${SIGNAL_AREA.sc} h-2.5 w-14`} />
              <SkeletonBlock className={`${SIGNAL_AREA.id} h-2.5 w-20`} />
              <SkeletonBlock className={`${SIGNAL_AREA.px} ml-auto h-2.5 w-16`} />
              <SkeletonBlock className={`${SIGNAL_AREA.sn} h-2.5 w-14`} />
              <SkeletonBlock className={`${SIGNAL_AREA.wt} h-2.5 w-full`} />
              <div className={SIGNAL_SUB_GRID}>
                <div className={SIGNAL_AREA.tp}><SkeletonBlock className="h-2.5 w-16" /></div>
                <div className={SIGNAL_AREA.ts}><SkeletonBlock className="h-2.5 w-16 xl:ml-auto" /></div>
                <div className={SIGNAL_AREA.st}><SkeletonBlock className="h-2.5 w-full" /></div>
                <div className={SIGNAL_AREA.ph}><SkeletonBlock className="h-2.5 w-full" /></div>
                <div className={SIGNAL_AREA.vo}><SkeletonBlock className="ml-auto h-2.5 w-10" /></div>
              </div>
            </div>
            <div className="flex items-center gap-2 px-2 pb-1 pt-2">
              <SkeletonBlock className="h-2.5 w-24" />
            </div>
            <div className="divide-y divide-[var(--color-border-soft)]">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className={`grid px-2 py-2.5 md:py-2 ${SIGNAL_ROW_GRID}`}>
                  <div className={`${SIGNAL_AREA.sc} flex flex-col items-start gap-1 self-start md:flex-row md:items-center md:self-center`}>
                    <SkeletonBlock className="h-2.5 w-5 max-md:order-2 md:ml-1" />
                    <SkeletonBlock className="h-6 w-9" />
                  </div>
                  <div className={`${SIGNAL_AREA.id} grid min-w-0 gap-1.5`}>
                    <SkeletonBlock className={`h-3.5 ${index % 3 === 0 ? 'w-3/5' : index % 3 === 1 ? 'w-4/5' : 'w-2/3'}`} />
                    <SkeletonBlock className="h-2.5 w-2/5" />
                  </div>
                  <div className={`${SIGNAL_AREA.px} grid justify-items-end gap-1.5`}>
                    <SkeletonBlock className="h-3.5 w-16" />
                    <SkeletonBlock className="h-2.5 w-11" />
                  </div>
                  <div className={`${SIGNAL_AREA.sn} flex gap-2 md:grid md:gap-1.5`}>
                    <SkeletonBlock className="h-3 w-14" />
                    <SkeletonBlock className="h-2.5 w-8" />
                  </div>
                  <div className={`${SIGNAL_AREA.wt} grid gap-1.5`}>
                    <SkeletonBlock className="h-[6px] w-full" />
                    <SkeletonBlock className="h-2.5 w-full" />
                  </div>
                  <div className={SIGNAL_SUB_GRID}>
                    <div className={SIGNAL_AREA.tp}><SkeletonBlock className="h-3 w-4/5" /></div>
                    <div className={`${SIGNAL_AREA.ts} flex gap-3 xl:grid xl:justify-items-end xl:gap-1.5`}>
                      <SkeletonBlock className="h-3 w-20" />
                      <SkeletonBlock className="h-3 w-20" />
                    </div>
                    <div className={`${SIGNAL_AREA.st} grid w-fit grid-cols-3 gap-x-1.5 md:w-auto`}>
                      {[0, 1, 2].map((group) => (
                        <div key={group} className="flex justify-center gap-0.5">
                          <SkeletonBlock className="h-4 w-[18px]" />
                          <SkeletonBlock className="h-4 w-[18px]" />
                        </div>
                      ))}
                    </div>
                    <div className={`${SIGNAL_AREA.ph} grid grid-cols-3 gap-x-1.5`}>
                      {[0, 1, 2].map((cell) => (
                        <SkeletonBlock key={cell} className="ml-auto h-3 w-8" />
                      ))}
                    </div>
                    <div className={SIGNAL_AREA.vo}><SkeletonBlock className="ml-auto h-3 w-10" /></div>
                  </div>
                  <div className={`${SIGNAL_AREA.tg} flex h-8 items-center justify-self-end md:h-7`}>
                    <SkeletonBlock className="h-3 w-10 md:w-3.5" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    case 'trade-overview':
      return (
        <div>
          <div className="flex gap-7 pb-3">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="grid gap-1">
                <SkeletonBlock className="h-2.5 w-12" />
                <SkeletonBlock className="h-5 w-8" />
              </div>
            ))}
          </div>
          <RowLines rows={4} rowClassName="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-x-4 py-5" />
        </div>
      )
    case 'events':
      return (
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <SectionBody section="earnings" />
          <SectionBody section="materials" />
        </div>
      )
    case 'earnings':
      return (
        <div>
          <div className="border-b-2 border-[var(--color-border-default)] pb-2">
            <SkeletonBlock className="h-3.5 w-32" />
          </div>
          <SkeletonBlock className="my-2.5 h-2.5 w-3/5" />
          <RowLines rows={8} rowClassName="grid grid-cols-[3.25rem_minmax(0,1fr)_4.5rem] items-center gap-x-3 py-3" />
        </div>
      )
    case 'materials':
      return (
        <div>
          <div className="border-b-2 border-[var(--color-border-default)] pb-2">
            <SkeletonBlock className="h-3.5 w-28" />
          </div>
          <SkeletonBlock className="my-2.5 h-2.5 w-1/2" />
          <RowLines rows={5} rowClassName="grid grid-cols-[4.75rem_minmax(0,1fr)_3rem] items-center gap-x-3 py-3" />
        </div>
      )
    case 'research':
    default:
      return (
        <div>
          <SkeletonBlock className="mb-2.5 h-2.5 w-2/5" />
          <div className="grid border-y border-[var(--color-border-soft)] sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className={`flex items-center gap-3 px-3 py-3 ${index >= 1 ? 'max-sm:hidden' : ''}`}>
                <SkeletonBlock className="h-4 w-4" />
                <div className="grid flex-1 gap-1.5">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="h-2.5 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )
  }
}

export function DashboardSectionFallback({
  section,
  caption,
  quiet = false,
}: {
  section: DashboardSectionId
  /** 既定は「{セクション名}を読み込み中」。日付切替中などは文言を差し替える */
  caption?: string
  /** 親が状態を読み上げる場合 (切替中ビューなど) は role を付けない */
  quiet?: boolean
}) {
  const { label } = DASHBOARD_SECTION_META[section]
  const text = caption ?? `${label}を読み込み中`

  return (
    <div role={quiet ? undefined : 'status'} aria-live={quiet ? undefined : 'polite'} className="min-w-0">
      <span className="sr-only">{text}</span>
      <div className="motion-safe:animate-pulse" aria-hidden="true">
        <SectionBody section={section} />
      </div>
    </div>
  )
}

/* ---------- 「今日の市場」(Hero) の骨組み ---------- */

export function MarketStateSkeleton() {
  return (
    <div className="grid motion-safe:animate-pulse md:grid-cols-2 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]" aria-hidden="true">
      <div className="px-4 pb-4 pt-3 md:col-span-2 lg:col-span-1">
        <SkeletonBlock className="h-2.5 w-24" />
        <SkeletonBlock className="mt-2 h-7 w-48" />
        <SkeletonBlock className="mt-3 h-3 w-4/5" />
        <div className="mt-4 grid gap-y-[12px]">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="grid grid-cols-[7.25rem_minmax(0,1fr)_3.25rem_4.75rem] items-center gap-x-3 max-sm:gap-x-2">
              <SkeletonBlock className="h-3 w-20" />
              <SkeletonBlock className="h-[6px] w-full" />
              <SkeletonBlock className="ml-auto h-3 w-10" />
              <SkeletonBlock className="ml-auto h-3 w-14" />
            </div>
          ))}
        </div>
        <SkeletonBlock className="mt-3 h-2.5 w-3/5" />
      </div>
      {[0, 1].map((column) => (
        <div
          key={column}
          className={`border-t border-[var(--color-border-soft)] px-4 pb-4 pt-3 lg:border-t-0 ${column === 0 ? 'lg:border-l' : 'md:border-l'}`}
        >
          <SkeletonBlock className="h-3 w-20" />
          <div className="mt-2.5 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
            {Array.from({ length: column === 0 ? 5 : 4 }, (_, index) => (
              <div key={index} className="grid grid-cols-[5.75rem_minmax(0,1fr)_3.25rem] items-center gap-x-3 py-[13px]">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="h-[6px] w-full" />
                <SkeletonBlock className="ml-auto h-3 w-10" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function AgendaSkeleton({ bordered = false }: { bordered?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`min-w-0 px-4 py-2.5 motion-safe:animate-pulse ${bordered ? 'border-t border-[var(--color-border-soft)] md:border-l md:border-t-0' : ''}`}
    >
      <SkeletonBlock className="mt-0.5 h-3 w-20" />
      <div className="mt-1 flex min-h-[38px] items-end gap-5">
        <SkeletonBlock className="h-6 w-10" />
        <SkeletonBlock className="h-6 w-10" />
        <SkeletonBlock className="h-6 w-10" />
      </div>
    </div>
  )
}

/** 日付切替中に「今日の市場」全体を置き換える骨組み */
export function DashboardMarketBriefSkeleton({ caption, historical = false }: { caption?: string; historical?: boolean }) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-t-[3px] border-t-[var(--color-brand-900)] bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border-soft)] px-4 py-2">
        <span className="text-[14px] font-bold text-[var(--color-brand-900)]">{historical ? 'この日の市場' : '今日の市場'}</span>
        {caption && <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{caption}</span>}
      </div>
      <MarketStateSkeleton />
      <div className="grid border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] md:grid-cols-3">
        <AgendaSkeleton />
        <AgendaSkeleton bordered />
        <AgendaSkeleton bordered />
      </div>
    </section>
  )
}
