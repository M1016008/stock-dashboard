'use client'

// components/us/UsDataCoverageStrip.tsx
//
// US 画面共通の「データ鮮度とカバレッジ」帯。PageTitle のローカルナビ内 (または直下) に置き、
// 罫線 1 本で区切った 1 行を既定 (閉) とし、<details> で根拠を展開する。
//
// 原則:
// - 値は /api/us/status (server 算出) をそのまま描く。client で coverage を再定義しない
// - 今日との差から stale を推測しない。日付は「ソースの最新日」として示すだけ
// - この帯は共通ソース契約。画面ごとの分析基準日・as-of は既存表示が正 (ここで上書きしない)
// - 語彙: N/A = 仕様上非適用 / PARTIAL = 一部 coverage / UNVERIFIED = 外部基準と未照合 / — = データ欠落
// - status の取得失敗は「確認できません」。N/A にはしない

import { ChevronDown } from 'lucide-react'
import { StatusTag } from '@/components/layout/PageTitle'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import type { UsCoverageSummary, UsStatusSummary } from '@/lib/us-status'
import { useUsDataCoverage, type UsDataCoverageState } from './usDataCoverageResource'

export type UsDataCoverageScope =
  | 'dashboard'
  | 'market-momentum'
  | 'sectors'
  | 'screener'
  | 'stage-screener'
  | 'trigger-discovery'
  | 'ml-lens'
  | 'transitions'
  | 'backtest'
  | 'stock'
  | 'mtf-calendar'

// route → scope の対応は UsAnalysisNav (server でも評価される) 側に置く。
// 'use client' module の関数は server component から呼べないため。

// 閉じた行で最優先に見せる status (mobile でも残す)。
type PrimaryStatus = 'ohlcv' | 'snapshots' | 'company-forecasts' | 'tradingview-oracle'
// 閉じた行の補助 status (広い画面のみ)。contracts から導く。
type SecondaryStatus = 'historical-classification' | 'company-forecasts'

type ScopeCopy = {
  primary: PrimaryStatus
  secondary?: SecondaryStatus
  constraints: string[]
}

const SIX_STAGE = '6 Stage'

export const US_DATA_COVERAGE_SCOPE_COPY: Record<UsDataCoverageScope, ScopeCopy> = {
  dashboard: {
    primary: 'ohlcv',
    constraints: [
      '市場全体の集計は、価格（OHLCV）を取得できた銘柄だけで計算します。OHLCV が PARTIAL のときは、未取得の銘柄が集計に含まれていません。',
      '表示中の基準日・過去日表示は画面上の表示を正とします。',
    ],
  },
  'market-momentum': {
    primary: 'snapshots',
    constraints: [
      `モメンタムのレーンと表は、${SIX_STAGE}（日足・週足・月足の6軸ステージ）を算出できた銘柄だけが対象です。${SIX_STAGE} が PARTIAL のときは、未算出の銘柄が現れません。`,
      '表示中の基準日は画面上の表示を正とします。',
    ],
  },
  sectors: {
    primary: 'snapshots',
    secondary: 'historical-classification',
    constraints: [
      '業種は SEC SIC です。GICS ではありません。',
      'SIC は現在の分類のみ（current-only）で、過去時点の分類（historical PIT）はありません。過去日のセクター構成は再現できません。',
      `セクター集計は ${SIX_STAGE} を算出できた銘柄だけで行います。`,
    ],
  },
  screener: {
    primary: 'snapshots',
    secondary: 'company-forecasts',
    constraints: [
      'SIC 業種・Exchange など現在の値しかない属性（current-only）は、過去日では利用できません。条件は無効になり絞り込みに使われず、現在の値で代用することもありません。',
      '財務は SEC Companyfacts の実績値のみです。会社予想（ガイダンス）はありません。',
      'AS OF の基準日は画面上の表示を正とします。',
    ],
  },
  'stage-screener': {
    primary: 'snapshots',
    constraints: [
      `ステージ行列は ${SIX_STAGE} を算出できた銘柄だけを数えます。${SIX_STAGE} が PARTIAL のときは、未算出の銘柄がどのセルにも現れません。`,
    ],
  },
  'trigger-discovery': {
    primary: 'snapshots',
    secondary: 'historical-classification',
    constraints: [
      '単一日付・現時点の銘柄群を対象にした検索です。過去時点の分類（historical classification）での検索はできません。',
      '条件の保存・事後評価・通知・期間スキャンは未提供です。',
    ],
  },
  'ml-lens': {
    primary: 'ohlcv',
    constraints: [
      '調整済み価格の世代（generation）と各レイヤーの日付は、画面上の「データ基準日」を正とします。この帯は価格ソースの共通契約だけを示します。',
    ],
  },
  transitions: {
    primary: 'snapshots',
    secondary: 'historical-classification',
    constraints: [
      '遷移のイベント日は画面上の表示を正とします。',
      'Industry 条件は現在の SIC 分類です。過去時点の分類（historical classification）は利用できません。',
    ],
  },
  backtest: {
    primary: 'ohlcv',
    constraints: [
      'RGC・QMMM など、価格系列の source-quality（データ品質）問題をどう扱うかの方針は未決です。',
      'リターンの clip / winsorize（外れ値の切り詰め）は行っていません。',
      'Production での有効化は保留中（activation pending）です。検証用の表示として読んでください。',
    ],
  },
  stock: {
    primary: 'company-forecasts',
    constraints: [
      'この画面の価格・指標はこの銘柄の個別系列です。価格日は画面上の表示を正とします。',
      '財務は SEC Companyfacts の実績値のみです。会社予想（ガイダンス）はありません。',
      'SIC 業種・Exchange は現在の分類のみ（current-only）です。',
    ],
  },
  'mtf-calendar': {
    primary: 'tradingview-oracle',
    constraints: [
      '実データの範囲内は観測された US 取引日、範囲外は米国取引所の休日ルールで求めた予定日です（臨時休場は反映されません）。',
      'TradingView の US 1 銘柄（通常取引の日足）と、照合期間内の全取引日・12 本の足すべてで確定日が一致しました。銘柄・期間・件数はページ上の説明を正とします。',
      '照合期間外の確定日は同じ足区切りルールを当てはめた結果で、TradingView で直接確認したものではありません。US の他の銘柄では照合していません。',
    ],
  },
}

const LEGEND: Array<[string, string]> = [
  ['N/A', '仕様上適用しない'],
  ['PARTIAL', '一部の銘柄のみ取得'],
  ['UNVERIFIED', '外部基準と未照合'],
  ['—', 'データ欠落'],
]

// ── 整形 (表示のみ。値は server のものをそのまま使う) ──

function fmtCount(value: number): string {
  return value.toLocaleString('ja-JP')
}

// 通常は小数 2 桁の四捨五入。PARTIAL が丸めで「100.00%」に見えるときだけ 99.99% に留める。
function fmtPercent(value: number, partial: boolean): string {
  const rounded = value.toFixed(2)
  return `${partial && rounded === '100.00' ? '99.99' : rounded}%`
}

function priceBasisLabel(contracts: UsStatusSummary['contracts']): string {
  const basis = contracts.priceBasis === US_ADJUSTED_PRICE_BASIS ? 'Tiingo調整済' : contracts.priceBasis
  return `${basis}${contracts.priceFrequency}`
}

function taxonomyLabel(value: string): string {
  return value === 'SEC_SIC' ? 'SEC SIC' : value
}

function effectiveDatingLabel(value: string): string {
  return value === 'CURRENT_ONLY' ? '現在の分類のみ' : value
}

function fundamentalsSourceLabel(value: string): string {
  return value === 'SEC_COMPANYFACTS' ? 'SEC Companyfacts' : value
}

function fundamentalsBasisLabel(value: string): string {
  return value === 'ACTUAL_ONLY' ? '実績のみ' : value
}

function Missing({ label }: { label: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </>
  )
}

function DateValue({ value }: { value: string | null }) {
  return value
    ? <span className="font-mono tabular-nums text-[var(--color-text-primary)]">{value}</span>
    : <Missing label="日付データなし" />
}

// PARTIAL は covered/eligible/% を必ず併記。COMPLETE は警告 badge にしない。
function CoverageValue({ coverage }: { coverage: UsCoverageSummary }) {
  if (coverage.status === 'UNAVAILABLE' || coverage.percent == null) {
    return <Missing label="カバレッジを算出できるデータがありません" />
  }
  const ratio = (
    <span className="font-mono tabular-nums">
      {fmtCount(coverage.covered)}/{fmtCount(coverage.eligible)}
      <span className="text-[var(--color-text-tertiary)]">（{fmtPercent(coverage.percent, coverage.status === 'PARTIAL')}）</span>
    </span>
  )
  if (coverage.status === 'PARTIAL') {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <StatusTag tone="warning">PARTIAL</StatusTag>
        {ratio}
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-[var(--color-text-secondary)]">全件</span>
      {ratio}
    </span>
  )
}

function Sep({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`text-[var(--color-border-default)] ${className}`}>|</span>
}

function primaryCoverage(data: UsStatusSummary, primary: PrimaryStatus): { label: string; coverage: UsCoverageSummary } {
  return primary === 'snapshots'
    ? { label: SIX_STAGE, coverage: data.coverage.snapshots }
    : { label: '価格', coverage: data.coverage.ohlcv }
}

function NaStatus({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <StatusTag>N/A</StatusTag>
    </span>
  )
}

function PrimaryStatusValue({ data, primary }: { data: UsStatusSummary; primary: PrimaryStatus }) {
  // 照合済みは COMPLETE と同じく警告 badge にしない。範囲 (1 銘柄) を必ず併記する。
  if (primary === 'tradingview-oracle') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>TradingView照合</span>
        <span className="text-[var(--color-text-secondary)]">1銘柄で一致</span>
      </span>
    )
  }
  if (primary === 'company-forecasts') {
    return data.contracts.fundamentals.companyForecastsAvailable === false
      ? <NaStatus label="会社予想" />
      : <span>財務 {fundamentalsBasisLabel(data.contracts.fundamentals.basis)}</span>
  }
  const { label, coverage } = primaryCoverage(data, primary)
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{label}</span>
      <CoverageValue coverage={coverage} />
    </span>
  )
}

// contracts 上で非適用 (false) のときだけ N/A を出す。
function secondaryNaLabel(data: UsStatusSummary, secondary: SecondaryStatus | undefined): string | null {
  if (secondary === 'historical-classification') {
    return data.contracts.classification.historicalPitAvailable === false ? '過去分類' : null
  }
  if (secondary === 'company-forecasts') {
    return data.contracts.fundamentals.companyForecastsAvailable === false ? '会社予想' : null
  }
  return null
}

// 閉じた行の基準日: 画面が主に依存するソースの最新日 (server 値)。
function sourceDate(data: UsStatusSummary, primary: PrimaryStatus): string | null {
  return primary === 'snapshots' ? data.coverage.snapshots.date : data.coverage.ohlcv.date
}

function ClosedLine({ scope, ticker, data }: { scope: UsDataCoverageScope; ticker?: string; data: UsStatusSummary }) {
  const copy = US_DATA_COVERAGE_SCOPE_COPY[scope]
  const secondaryNa = secondaryNaLabel(data, copy.secondary)
  const population = scope === 'stock'
    ? <span>対象 <span className="font-mono font-semibold text-[var(--color-text-primary)]">{ticker ?? '—'}</span></span>
    : scope === 'mtf-calendar'
      ? <span>NYSE/Nasdaq 通常取引日</span>
      : (() => {
        const { coverage } = primaryCoverage(data, copy.primary)
        return (
          <span>
            母集団{' '}
            {coverage.status === 'UNAVAILABLE'
              ? <Missing label="母集団データなし" />
              : <span className="font-mono tabular-nums text-[var(--color-text-primary)]">{fmtCount(coverage.eligible)}</span>}
            {' '}銘柄
          </span>
        )
      })()
  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span className="max-sm:hidden">ソース基準日</span>
        <DateValue value={sourceDate(data, copy.primary)} />
      </span>
      <Sep className="max-sm:hidden" />
      <span className="max-sm:hidden">{population}</span>
      <Sep className="max-md:hidden" />
      <span className="max-md:hidden">{priceBasisLabel(data.contracts)}</span>
      <Sep />
      <PrimaryStatusValue data={data} primary={copy.primary} />
      {secondaryNa && (
        <span className="inline-flex items-center gap-3 max-lg:hidden">
          <Sep />
          <NaStatus label={secondaryNa} />
        </span>
      )}
    </>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="m-0 text-[11px] font-bold text-[var(--color-text-tertiary)]">{title}</h3>
      {children}
    </section>
  )
}

function DetailRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="m-0 min-w-0 text-right text-[var(--color-text-primary)]">{children}</dd>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">{children}</p>
}

function Constraints({ scope }: { scope: UsDataCoverageScope }) {
  return (
    <DetailSection title="この画面の制約">
      <ul className="m-0 flex list-disc flex-col gap-1 pl-4 leading-relaxed text-[var(--color-text-secondary)]">
        {US_DATA_COVERAGE_SCOPE_COPY[scope].constraints.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </DetailSection>
  )
}

function ReadyDetails({ scope, data }: { scope: UsDataCoverageScope; data: UsStatusSummary }) {
  const { classification, fundamentals } = data.contracts
  return (
    <>
      <DetailSection title="基準日">
        <dl className="m-0 flex flex-col gap-1">
          <DetailRow label="価格（OHLCV）最新日"><DateValue value={data.coverage.ohlcv.date} /></DetailRow>
          <DetailRow label={`${SIX_STAGE} 最新日`}><DateValue value={data.coverage.snapshots.date} /></DetailRow>
        </dl>
        <Note>共通データソースの最新日です。この画面の分析基準日は、画面上の表示を正とします。</Note>
      </DetailSection>
      <DetailSection title="母集団">
        <dl className="m-0 flex flex-col gap-1">
          <DetailRow label="価格（OHLCV）"><CoverageValue coverage={data.coverage.ohlcv} /></DetailRow>
          <DetailRow label={SIX_STAGE}><CoverageValue coverage={data.coverage.snapshots} /></DetailRow>
        </dl>
        <Note>
          取得数/対象数。対象は有効な投資対象の US 銘柄、{SIX_STAGE} は最新日に価格と必要な履歴がある銘柄です。
          {scope === 'stock' && ' 市場全体の値で、この銘柄の取得状況ではありません。'}
        </Note>
      </DetailSection>
      <DetailSection title="PIT境界">
        <dl className="m-0 flex flex-col gap-1">
          <DetailRow label="価格">
            {priceBasisLabel(data.contracts)}
            <code className="ml-1.5 font-mono text-[11px] text-[var(--color-text-tertiary)]">{data.contracts.priceBasis}</code>
          </DetailRow>
          <DetailRow label="業種分類">
            {taxonomyLabel(classification.taxonomy)}・{effectiveDatingLabel(classification.effectiveDating)}
          </DetailRow>
          <DetailRow label="過去時点の分類">
            {classification.historicalPitAvailable ? '利用可' : <StatusTag>N/A</StatusTag>}
          </DetailRow>
          <DetailRow label="財務">
            {fundamentalsSourceLabel(fundamentals.source)}・{fundamentalsBasisLabel(fundamentals.basis)}
          </DetailRow>
          <DetailRow label="会社予想">
            {fundamentals.companyForecastsAvailable ? '利用可' : <StatusTag>N/A</StatusTag>}
          </DetailRow>
        </dl>
      </DetailSection>
      <Constraints scope={scope} />
    </>
  )
}

export function UsDataCoverageStripView({
  scope,
  ticker,
  state,
  onRetry,
  placement = 'nav',
}: {
  scope: UsDataCoverageScope
  ticker?: string
  state: UsDataCoverageState
  onRetry?: () => void
  placement?: 'nav' | 'standalone'
}) {
  // nav: PageTitle の帯内で上罫線 / standalone: 見出しの直下で下罫線。どちらも全幅の hairline 1 本。
  const rule = placement === 'nav'
    ? 'order-last basis-full border-t pt-1.5'
    : 'border-b pb-1.5'
  return (
    <section
      aria-label="USデータの鮮度とカバレッジ"
      data-us-coverage-scope={scope}
      className={`w-full min-w-0 border-[var(--color-border-default)] text-[12px] ${rule}`}
    >
      <details className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-[4px] py-0.5 text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
          <span className="font-bold text-[var(--color-text-tertiary)] max-sm:hidden">データ基準</span>
          {state.status === 'ready' ? (
            <ClosedLine scope={scope} ticker={ticker} data={state.data} />
          ) : state.status === 'error' ? (
            <span className="font-semibold text-[var(--color-text-primary)]">データ状態を確認できません</span>
          ) : (
            <span role="status" aria-live="polite">データ状態を確認中…</span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)]">
            <span className="group-open:hidden">詳細</span>
            <span className="hidden group-open:inline">閉じる</span>
            <ChevronDown size={13} aria-hidden className="transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="grid gap-x-6 gap-y-3 pb-2 pt-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {state.status === 'ready' ? (
            <ReadyDetails scope={scope} data={state.data} />
          ) : (
            <>
              <DetailSection title="データ状態">
                {state.status === 'error' ? (
                  <>
                    <p className="m-0 leading-relaxed text-[var(--color-text-secondary)]">
                      US データ状態を取得できず、基準日・母集団・カバレッジを確認できません。画面のデータが欠けている、または適用外という意味ではありません。
                    </p>
                    {onRetry && (
                      <button type="button" className="btn self-start" data-size="sm" onClick={onRetry}>
                        再読み込み
                      </button>
                    )}
                  </>
                ) : (
                  <p className="m-0 text-[var(--color-text-secondary)]">基準日・母集団・カバレッジを確認中です。</p>
                )}
              </DetailSection>
              <Constraints scope={scope} />
            </>
          )}
          <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-tertiary)] sm:col-span-2 xl:col-span-4">
            {LEGEND.map(([term, meaning]) => (
              <span key={term}><strong className="font-mono font-bold text-[var(--color-text-secondary)]">{term}</strong> {meaning}</span>
            ))}
          </p>
        </div>
      </details>
    </section>
  )
}

export function UsDataCoverageStrip({
  scope,
  ticker,
  placement = 'nav',
}: {
  scope: UsDataCoverageScope
  ticker?: string
  placement?: 'nav' | 'standalone'
}) {
  // 同じ画面 (scope + ticker) の strip は 1 本の /api/us/status を共有する。
  const { state, retry } = useUsDataCoverage(`${scope}:${ticker ?? ''}`)
  return <UsDataCoverageStripView scope={scope} ticker={ticker} state={state} onRetry={retry} placement={placement} />
}
