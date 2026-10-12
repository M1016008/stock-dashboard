import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { Notice } from '@/components/ui/EmptyState'
import { MtfCloseCalendarClient } from '../../mtf-close-calendar/MtfCloseCalendarClient'

export const metadata: Metadata = {
  title: 'US MTF Close Calendar | StockBoard',
  description: 'NYSE/Nasdaq の通常取引日（America/New_York の市場日付）で、日・週・月の12時間足が同時に確定する日を月間カレンダーで確認します。',
}

export const dynamic = 'force-dynamic'

const US_MARKET_TIME_ZONE = 'America/New_York'

// 「今日」はブラウザのローカル時刻や JST ではなく、米国市場の日付で決める。
function newYorkToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_MARKET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export default function UsMtfCloseCalendarPage() {
  const today = newYorkToday()
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="米国株"
        title="US MTF確定日"
        subtitle="NYSE/Nasdaq の通常取引日について、日足から5か月足まで12本のローソク足がどの日に同時に確定するかを月単位で確認します。"
        meta={(
          <>
            <span>市場日付 <strong className="font-semibold text-[var(--color-text-primary)]">{US_MARKET_TIME_ZONE}</strong></span>
            <span>NYSE/Nasdaq 通常取引のみ（時間外取引は含みません）</span>
          </>
        )}
      />
      <Notice tone="info" title="日付の根拠と検証状況">
        実データの範囲内は US 日足で確認できた取引日、範囲外は米国取引所の休日ルールで求めた予定日です（臨時休場は予定に反映されません）。足の区切りは TradingView で検証済みの JP 版と共通のルールですが、US 固有の TradingView 照合はまだ完了していません。
      </Notice>
      <MtfCloseCalendarClient market="US" initialMonth={today.slice(0, 7)} today={today} />
    </div>
  )
}
