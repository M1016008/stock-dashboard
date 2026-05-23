// components/dashboard/EarningsCalendarPanel.tsx
// 決算発表予定銘柄を、株価・平均出来高・6軸ステージ込みの一覧で表示する。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { IndustryBadges } from '@/components/ui/IndustryBadges'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'
import { getEarningsCalendarDashboard } from '@/lib/queries/dashboard'

type EarningsDashboard = Awaited<ReturnType<typeof getEarningsCalendarDashboard>>
type EarningsRows = EarningsDashboard['rows']

function fmtVol(v: number | null) {
  if (v == null) return '---'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  return Math.round(v / 1_000).toLocaleString() + 'K'
}

function fmtPrice(v: number | null) {
  if (v == null) return '---'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '---'
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

function tone(v: number | null) {
  if (v == null) return ''
  return v > 0 ? 'text-[var(--color-price-up)]' : v < 0 ? 'text-[var(--color-price-down)]' : ''
}

function fmtRunTime(value: string | number | null | undefined) {
  if (value == null) return '---'
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function dayLabel(daysLeft: number) {
  if (daysLeft === 0) return '本日'
  if (daysLeft > 0) return `+${daysLeft}d`
  return `${Math.abs(daysLeft)}日前`
}

function dayBucket(rows: EarningsRows) {
  const groups = [
    { key: 'today', label: '本日', tone: 'bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]', rows: [] as EarningsRows },
    { key: 'soon', label: '1〜3日以内', tone: 'bg-[var(--color-brand-50)] text-[var(--color-brand-800)]', rows: [] as EarningsRows },
    { key: 'week', label: '1週間以内', tone: 'bg-[var(--color-pattern-50)] text-[var(--color-pattern-700)]', rows: [] as EarningsRows },
    { key: 'twoWeeks', label: '2週間以内', tone: 'bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]', rows: [] as EarningsRows },
    { key: 'later', label: 'それ以降', tone: 'bg-white text-[var(--color-text-tertiary)]', rows: [] as EarningsRows },
  ]
  for (const row of rows) {
    if (row.daysLeft <= 0) groups[0].rows.push(row)
    else if (row.daysLeft <= 3) groups[1].rows.push(row)
    else if (row.daysLeft <= 7) groups[2].rows.push(row)
    else if (row.daysLeft <= 14) groups[3].rows.push(row)
    else groups[4].rows.push(row)
  }
  return groups.filter((group) => group.rows.length > 0)
}

function sourceLabel(source: string | null) {
  if (source === 'jpx') return 'JPX公式'
  if (source === 'jquants') return 'J-Quants'
  return '取得済み'
}

function signalTone(label: string) {
  if (label === '上昇候補' || label === 'ブレイク直前' || label === '高値継続') {
    return 'border-[rgba(22,163,74,0.22)] bg-[rgba(22,163,74,0.08)] text-[var(--color-price-up)]'
  }
  if (label === '下落警戒' || label === 'MA下抜け') {
    return 'border-[rgba(220,38,38,0.22)] bg-[rgba(220,38,38,0.08)] text-[var(--color-price-down)]'
  }
  if (label.startsWith('MA')) {
    return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
  }
  return 'border-[rgba(37,99,235,0.18)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
}

function SignalBadges({ labels, codes }: { labels: string[] | undefined; codes: string[] | undefined }) {
  const all = labels ?? []
  if (all.length === 0) {
    return <span className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">---</span>
  }
  return (
    <div className="flex max-w-[340px] flex-wrap gap-1" title={(codes ?? []).join(', ')}>
      {all.map((label) => (
        <span
          key={label}
          className={`rounded-full border px-1.5 py-[2px] text-[10px] font-bold leading-[1.15] whitespace-nowrap ${signalTone(label)}`}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

function EarningsTable({ rows, mode = 'upcoming' }: { rows: EarningsRows; mode?: 'upcoming' | 'completed' }) {
  const completed = mode === 'completed'
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-[12px] ${completed ? 'min-w-[1700px]' : 'min-w-[1620px]'}`}>
        <thead>
          <tr className="text-left text-[11px] font-bold text-[var(--color-text-tertiary)]">
            <th className="pb-3 pl-2 pr-3">発表</th>
            <th className="pb-3 pr-3">銘柄名</th>
            <th className="pb-3 pr-3">貸借/信用</th>
            <th className="pb-3 pr-3">J-Quants業種</th>
            <th className="pb-3 pr-4">シグナル</th>
            {completed && <th className="pb-3 pr-3 text-right">決算後</th>}
            <th className="pb-3 pr-3 text-right">現在株価</th>
            <th className="pb-3 pr-3 text-right">前日比</th>
            <th className="pb-3 pr-3 text-right">10日平均</th>
            <th className="pb-3 pr-3 text-right">30日平均</th>
            <th className="pb-3 pr-3 text-right">60日平均</th>
            <th className="pb-3 pr-3">日足A/B</th>
            <th className="pb-3 pr-3">週足A/B</th>
            <th className="pb-3 pr-2">月足A/B</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {rows.map((row) => (
            <tr key={row.ticker + row.announce_date} className="hover:bg-[var(--color-surface-subtle)]">
              <td className={`py-3 pl-2 pr-3 tabular-nums ${row.daysLeft === 0 ? 'font-bold text-[var(--color-price-up)]' : 'text-[var(--color-text-secondary)]'}`}>
                <div>{dayLabel(row.daysLeft)}</div>
                <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{row.announce_date.slice(5)}</div>
                <div className="mt-1 text-[10px] font-bold text-[var(--color-brand-700)]">{sourceLabel(row.source)}</div>
              </td>
              <td className="py-3 pr-3">
                <Link href={`/stock/${row.ticker}`} className="font-bold tabular-nums hover:underline">{row.ticker}</Link>
                <div className="mt-1 max-w-[260px] truncate font-semibold">{row.name ?? row.ticker}</div>
              </td>
              <td className="py-3 pr-3">
                <MarginBadges
                  marginType={row.marginType}
                  creditRatio={row.creditRatio}
                  shortRatio={row.shortRatio}
                  compact={completed}
                />
              </td>
              <td className="py-3 pr-3">
                <IndustryBadges
                  sector17={row.sector17Name}
                  sector33={row.sector33Name}
                  marketSegment={row.marketSegment}
                  compact
                />
              </td>
              <td className="py-3 pr-4 align-top">
                <SignalBadges labels={row.signalLabels} codes={row.signalCodes} />
              </td>
              {completed && (
                <td className={`py-3 pr-3 text-right tabular-nums font-bold ${tone(row.postEarningsChangePct)}`}>
                  <div>{fmtPct(row.postEarningsChangePct)}</div>
                  <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                    {row.postEarningsBaseDate ? `${row.postEarningsBaseDate.slice(5)}比` : '基準なし'}
                    {row.postEarningsTradingDays != null ? ` / ${row.postEarningsTradingDays}営業日` : ''}
                  </div>
                  <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                    基準 {fmtPrice(row.postEarningsBasePrice)}
                  </div>
                </td>
              )}
              <td className="py-3 pr-3 text-right tabular-nums font-semibold">{fmtPrice(row.price)}</td>
              <td className={`py-3 pr-3 text-right tabular-nums font-semibold ${tone(row.changePct)}`}>
                {row.changePct == null ? '---' : (row.changePct > 0 ? '+' : '') + row.changePct.toFixed(2) + '%'}
              </td>
              <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume10)}</td>
              <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume30)}</td>
              <td className="py-3 pr-3 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtVol(row.avgVolume60)}</td>
              <td className="py-3 pr-3">
                <div className="flex items-center gap-1"><StageTag stage={row.daily_a_stage} size="xs" /><StageTag stage={row.daily_b_stage} size="xs" /></div>
              </td>
              <td className="py-3 pr-3">
                <div className="flex items-center gap-1"><StageTag stage={row.weekly_a_stage} size="xs" /><StageTag stage={row.weekly_b_stage} size="xs" /></div>
              </td>
              <td className="py-3 pr-2">
                <div className="flex items-center gap-1"><StageTag stage={row.monthly_a_stage} size="xs" /><StageTag stage={row.monthly_b_stage} size="xs" /></div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export async function EarningsCalendarPanel({ date }: { date?: string | null }) {
  const data = await getEarningsCalendarDashboard(14, date)
  const rows = data.rows
  const upcomingGroups = dayBucket(rows)
  const completedRows = data.completedRows
  return (
    <Card>
      <CardHeader
        title="決算発表銘柄"
        hint={data.windowStart && data.windowEnd ? `${data.windowStart}〜${data.windowEnd} / J-Quants + JPX公式` : 'J-Quants + JPX公式'}
      />
      {rows.length === 0 ? (
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-6 text-center">
          <div className="text-[13px] font-bold text-[var(--color-text-secondary)]">
            {data.status === 'error' ? 'データ取得失敗' : data.status === 'stale' ? '決算カレンダー未更新' : data.status === 'empty' ? 'データ未取り込み' : '該当銘柄なし'}
          </div>
          <div className="mx-auto mt-2 max-w-[720px] text-[12px] font-medium leading-relaxed text-[var(--color-text-tertiary)]">
            {data.message}
          </div>
          {data.latestAnnounceDate && (
            <div className="mt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              DB内の最新決算日: {data.latestAnnounceDate}
            </div>
          )}
          <div className="mt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            DB件数: {data.totalRows.toLocaleString()}件 / 最新取得: {fmtRunTime(data.latestImportedAt)} / 最終バッチ: {data.lastRun?.status ?? '---'}・{data.lastRun?.rowsInserted ?? 0}件・{fmtRunTime(data.lastRun?.finishedAt)}
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 text-[12px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
            <div>{data.message}</div>
            <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              DB件数: {data.totalRows.toLocaleString()}件 / 最新取得: {fmtRunTime(data.latestImportedAt)} / 最終バッチ: {data.lastRun?.status ?? '---'}・{data.lastRun?.rowsInserted ?? 0}件・{fmtRunTime(data.lastRun?.finishedAt)}
            </div>
          </div>
          <div className="space-y-4">
            {upcomingGroups.map((group) => (
              <section key={group.key} className="rounded-[8px] border border-[var(--color-border-soft)] bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-3 py-2">
                  <div className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${group.tone}`}>
                    {group.label}
                  </div>
                  <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                    {group.rows.length.toLocaleString()}銘柄
                  </div>
                </div>
                <div className="p-3">
                  <EarningsTable rows={group.rows} />
                </div>
              </section>
            ))}
          </div>
        </>
      )}
      {rows.length === 0 && data.referenceRows.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-bold text-[var(--color-text-secondary)]">
            最新取得分（参考）
          </div>
          <EarningsTable rows={data.referenceRows} />
        </div>
      )}
      {completedRows.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-bold text-[var(--color-text-primary)]">発表後2週間の値動き</div>
              <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                決算発表後、最初に取引があった終値を基準に、最新株価までの変化を追跡します。
              </div>
            </div>
            <span className="rounded-full bg-[var(--color-surface-subtle)] px-2.5 py-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
              {completedRows.length.toLocaleString()}銘柄
            </span>
          </div>
          <EarningsTable rows={completedRows} mode="completed" />
        </div>
      )}
    </Card>
  )
}
