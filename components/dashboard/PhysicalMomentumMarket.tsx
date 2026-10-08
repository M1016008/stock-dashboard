import Link from 'next/link'
import { cache } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { execAll, execGet } from '@/lib/db/client'
import { NIKKEI225_TICKERS, type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import {
  marketMomentumRankingHref,
  type MarketMomentumGroupId,
} from '@/lib/market-momentum-groups'
import { StageTag } from '@/components/ui/StageTag'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import {
  GroupLabel,
  MeterBar,
  TONE_TEXT,
  type DashboardTone,
  signedTextClass,
} from '@/components/dashboard/DashboardPrimitives'

type MomentumSummaryRow = {
  date: string | null
  count: number
  positivePms: number
  negativePms: number
  strongPms: number
  weakPms: number
  positivePfs: number
  highPes: number
}

export type MomentumGroupRow = {
  label: string
  code: string | null
  count: number
  positivePms: number
  negativePms: number
  strongPms: number
  weakPms: number
  positivePfs: number
  highPes: number
}

export type MomentumRankingRow = {
  ticker: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  price: number | null
  changePct: number | null
  pms: number | null
  pfs: number | null
  pes: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
}

export function ratio(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part == null || total == null || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null
  return (part / total) * 100
}

export function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value.toFixed(1)}%`
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(2)
}

export function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function fmtCount(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString('ja-JP')
}

export function breadthTone(value: number | null | undefined, goodAbove = 50): 'up' | 'down' | 'neutral' {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  if (value >= goodAbove) return 'up'
  if (value <= 100 - goodAbove) return 'down'
  return 'neutral'
}

function marketReading(row: MomentumSummaryRow | undefined): { label: string; tone: DashboardTone; note: string } {
  const total = Number(row?.count ?? 0)
  const pmsPlus = ratio(row?.positivePms ?? 0, total)
  const forcePlus = ratio(row?.positivePfs ?? 0, total)
  const strong = ratio(row?.strongPms ?? 0, total)
  const weak = ratio(row?.weakPms ?? 0, total)
  if (total <= 0) return { label: 'データ不足', tone: 'neutral', note: 'PMSデータを確認できません。' }
  if ((forcePlus ?? 0) >= 60 && (pmsPlus ?? 0) >= 48) {
    return { label: '初動の力が広がり', tone: 'up', note: 'PFSプラス銘柄が多く、短期の押し出す力は市場内に広がっています。' }
  }
  if ((weak ?? 0) > (strong ?? 0) && (pmsPlus ?? 0) < 45) {
    return { label: '弱含み優勢', tone: 'down', note: 'PMSマイナス側の銘柄が多く、買い候補は個別選別を強めたい局面です。' }
  }
  if ((strong ?? 0) >= 3 && (forcePlus ?? 0) >= 55) {
    return { label: '局所的な強さ', tone: 'warning', note: '強い銘柄はありますが、市場全体へ広く波及しているかを確認します。' }
  }
  return { label: '中立', tone: 'neutral', note: 'PMS分布は市場平均付近です。業種ETFや個別ステージと併せて確認します。' }
}

export function groupReading(row: MomentumGroupRow): { label: string; tone: DashboardTone } {
  const pmsPlus = ratio(row.positivePms, row.count) ?? 0
  const forcePlus = ratio(row.positivePfs, row.count) ?? 0
  const strong = ratio(row.strongPms, row.count) ?? 0
  const weak = ratio(row.weakPms, row.count) ?? 0
  if (pmsPlus >= 58 && forcePlus >= 58) return { label: '強い', tone: 'up' }
  if (pmsPlus <= 38 || weak > strong + 2) return { label: '弱い', tone: 'down' }
  if (forcePlus >= 62 && pmsPlus >= 45) return { label: '初動あり', tone: 'warning' }
  return { label: '中立', tone: 'neutral' }
}

function segmentOrder(label: string): number {
  if (label.includes('日経225')) return 0
  if (label.includes('プライム')) return 1
  if (label.includes('スタンダード')) return 2
  if (label.includes('グロース')) return 3
  if (label.includes('その他')) return 4
  return 9
}

/** 既存ヒートマップの色規則 (PMSプラス比率 50% を境に赤/青) をバーの色に流用する */
function heatTone(value: number | null | undefined): DashboardTone {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  return value >= 50 ? 'up' : 'down'
}

function buildSectorsHref(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null && String(value).trim() !== '') sp.set(key, String(value))
  }
  const query = sp.toString()
  return `/sectors${query ? `?${query}` : ''}#sector-stocks`
}

function sectorsHeatmapHref(taxonomy: '33' | 'major', universe: UniverseFilterValue): string {
  const sp = new URLSearchParams({ heatmapTaxonomy: taxonomy })
  if (universe) sp.set('universe', universe)
  return `/sectors?${sp.toString()}#sector-heatmaps`
}

export function stockDetailHref(ticker: string, date?: string | null): string {
  const base = `/stock/${encodeURIComponent(ticker)}`
  return date ? `${base}?date=${encodeURIComponent(date)}` : base
}

function groupFromUniverse(universe: UniverseFilterValue): MarketMomentumGroupId {
  return universe === 'nikkei225' ? 'nikkei225' : 'all'
}

/**
 * 市場モメンタムの集計を 1 リクエスト内で 1 回だけ実行する。
 * Hero (市場の状態) と市場マップの両方が同じ結果を使うため React cache で共有する。
 * SQL・並び順・判定は従来の PhysicalMomentumMarket から変更していない。
 */
export const loadMomentumMarket = cache(async (date: string | null, universe: UniverseFilterValue) => {
  const universeSql = universeSqlCondition('pm.symbol', universe)
  const dateParams = date ? [date] : []
  const nikkei225Placeholders = NIKKEI225_TICKERS.map(() => '?').join(', ')
  const commonLatest = `
    WITH latest AS (
      SELECT MAX(date) AS date
      FROM physical_momentum_metrics
      WHERE market = 'JP'
        ${date ? 'AND date <= ?' : ''}
    )
  `
  const aggregateSelect = `
    COUNT(*) AS count,
    SUM(CASE WHEN pm.physical_momentum_score > 0 THEN 1 ELSE 0 END) AS positivePms,
    SUM(CASE WHEN pm.physical_momentum_score < 0 THEN 1 ELSE 0 END) AS negativePms,
    SUM(CASE WHEN pm.physical_momentum_score >= 1 THEN 1 ELSE 0 END) AS strongPms,
    SUM(CASE WHEN pm.physical_momentum_score <= -1 THEN 1 ELSE 0 END) AS weakPms,
    SUM(CASE WHEN pm.physical_force_score > 0 THEN 1 ELSE 0 END) AS positivePfs,
    SUM(CASE WHEN pm.physical_energy_score >= 1 THEN 1 ELSE 0 END) AS highPes
  `
  const rankingSelect = `
    SELECT
      pm.symbol AS ticker,
      tu.name AS name,
      tu.market_segment AS marketSegment,
      tu.sector17_name AS sector17Name,
      cur.close AS price,
      CASE WHEN prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close END AS changePct,
      pm.physical_momentum_score AS pms,
      pm.physical_force_score AS pfs,
      pm.physical_energy_score AS pes,
      ds.daily_a_stage AS dailyAStage,
      ds.daily_b_stage AS dailyBStage,
      ds.weekly_a_stage AS weeklyAStage,
      ds.weekly_b_stage AS weeklyBStage,
      ds.monthly_a_stage AS monthlyAStage,
      ds.monthly_b_stage AS monthlyBStage
    FROM latest
    JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
    LEFT JOIN ticker_universe tu ON tu.ticker = pm.symbol
    LEFT JOIN ohlcv_daily cur ON cur.ticker = pm.symbol AND cur.date = latest.date
    LEFT JOIN ohlcv_daily prev ON prev.ticker = pm.symbol AND prev.date = (
      SELECT MAX(date) FROM ohlcv_daily WHERE ticker = pm.symbol AND date < latest.date
    )
    LEFT JOIN daily_snapshots ds ON ds.ticker = pm.symbol AND ds.date = latest.date
    WHERE pm.physical_momentum_score IS NOT NULL
      ${universeSql.sql ? `AND ${universeSql.sql}` : ''}
  `
  const [row, nikkei225Row, segmentRows, sectorRows, initialRows, continuationRows, stallRows, dropRows] = await Promise.all([
    execGet<MomentumSummaryRow>(
      `
        ${commonLatest}
        SELECT
          latest.date AS date,
          ${aggregateSelect}
        FROM latest
        LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
        WHERE pm.physical_momentum_score IS NOT NULL
          ${universeSql.sql ? `AND ${universeSql.sql}` : ''}
      `,
      [...dateParams, ...universeSql.params],
    ),
    execGet<MomentumGroupRow>(
      `
        ${commonLatest}
        SELECT
          '日経225' AS label,
          'nikkei225' AS code,
          ${aggregateSelect}
        FROM latest
        JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
        WHERE pm.physical_momentum_score IS NOT NULL
          AND pm.symbol IN (${nikkei225Placeholders})
          ${universeSql.sql ? `AND ${universeSql.sql}` : ''}
      `,
      [...dateParams, ...NIKKEI225_TICKERS, ...universeSql.params],
    ),
    execAll<MomentumGroupRow>(
      `
        ${commonLatest}
        SELECT
          COALESCE(NULLIF(tu.market_segment, ''), '未分類') AS label,
          NULL AS code,
          ${aggregateSelect}
        FROM latest
        JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
        LEFT JOIN ticker_universe tu ON tu.ticker = pm.symbol
        WHERE pm.physical_momentum_score IS NOT NULL
          ${universeSql.sql ? `AND ${universeSql.sql}` : ''}
        GROUP BY label
      `,
      [...dateParams, ...universeSql.params],
    ),
    execAll<MomentumGroupRow>(
      `
        ${commonLatest}
        SELECT
          COALESCE(NULLIF(tu.sector17_name, ''), '未分類') AS label,
          tu.sector17_code AS code,
          ${aggregateSelect}
        FROM latest
        JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.date = latest.date
        LEFT JOIN ticker_universe tu ON tu.ticker = pm.symbol
        WHERE pm.physical_momentum_score IS NOT NULL
          ${universeSql.sql ? `AND ${universeSql.sql}` : ''}
        GROUP BY label, code
        HAVING count >= 10
        ORDER BY 100.0 * positivePms / count DESC
      `,
      [...dateParams, ...universeSql.params],
    ),
    execAll<MomentumRankingRow>(
      `
        ${commonLatest}
        ${rankingSelect}
        ORDER BY pm.physical_force_score DESC, pm.physical_momentum_score DESC, pm.symbol
        LIMIT 8
      `,
      [...dateParams, ...universeSql.params],
    ),
    execAll<MomentumRankingRow>(
      `
        ${commonLatest}
        ${rankingSelect}
        ORDER BY pm.physical_momentum_score DESC, pm.physical_force_score DESC, pm.symbol
        LIMIT 8
      `,
      [...dateParams, ...universeSql.params],
    ),
    execAll<MomentumRankingRow>(
      `
        ${commonLatest}
        ${rankingSelect}
          AND pm.physical_momentum_score > 0
          AND pm.physical_force_score < 0
        ORDER BY pm.physical_force_score ASC, pm.physical_momentum_score DESC, pm.symbol
        LIMIT 8
      `,
      [...dateParams, ...universeSql.params],
    ),
    execAll<MomentumRankingRow>(
      `
        ${commonLatest}
        ${rankingSelect}
        ORDER BY pm.physical_momentum_score ASC, pm.physical_force_score ASC, pm.symbol
        LIMIT 8
      `,
      [...dateParams, ...universeSql.params],
    ),
  ])

  const count = Number(row?.count ?? 0)
  const segmentGroups =
    nikkei225Row && Number(nikkei225Row.count ?? 0) > 0 ? [nikkei225Row, ...segmentRows] : segmentRows
  const sortedSegments = [...segmentGroups].sort((a, b) => {
    const order = segmentOrder(a.label) - segmentOrder(b.label)
    return order !== 0 ? order : b.count - a.count
  })
  const sortedSectors = [...sectorRows].sort((a, b) => {
    const ar = ratio(a.positivePms, a.count) ?? -1
    const br = ratio(b.positivePms, b.count) ?? -1
    return br - ar
  })

  return {
    date: row?.date ?? null,
    count,
    positivePms: Number(row?.positivePms ?? 0),
    strongPms: Number(row?.strongPms ?? 0),
    weakPms: Number(row?.weakPms ?? 0),
    positivePfs: Number(row?.positivePfs ?? 0),
    highPes: Number(row?.highPes ?? 0),
    pmsPlusRatio: ratio(row?.positivePms ?? 0, count),
    strongRatio: ratio(row?.strongPms ?? 0, count),
    weakRatio: ratio(row?.weakPms ?? 0, count),
    forcePlusRatio: ratio(row?.positivePfs ?? 0, count),
    energyHighRatio: ratio(row?.highPes ?? 0, count),
    reading: marketReading(row),
    sortedSegments,
    sortedSectors,
    initialRows,
    continuationRows,
    stallRows,
    dropRows,
  }
})

export type MomentumMarketData = Awaited<ReturnType<typeof loadMomentumMarket>>

/**
 * 市場マップ: 4 つの勢いレーン (初動/継続/失速/下落警戒) と 17業種の PMS 分布。
 * 全体判定・ブレッドス・市場区分は Dashboard 冒頭の「市場の状態」に移した。
 */
export async function PhysicalMomentumMarket({
  date = null,
  universe = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
}) {
  const data = await loadMomentumMarket(date ?? null, universe ?? null)
  const rankingGroup = groupFromUniverse(universe ?? null)
  const half = Math.ceil(data.sortedSectors.length / 2)
  const sectorColumns = [data.sortedSectors.slice(0, half), data.sortedSectors.slice(half)]

  return (
    // 列は minmax(0,1fr) で固定する。暗黙の auto 列だと子の min-content (nowrap の注記など) で
    // 列幅が画面幅を超え、390px で横スクロールが出るため
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
        <span className="tabular-nums">
          PMS基準日 <span className="font-mono font-bold text-[var(--color-text-primary)]">{data.date ?? '---'}</span>
          <span className="mx-2 text-[var(--color-border-default)]">|</span>
          {data.count.toLocaleString('ja-JP')}銘柄
        </span>
        <nav aria-label="関連する分析ページ" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
          {[
            { href: '/sectors', label: '業種分析' },
            { href: sectorsHeatmapHref('33', universe ?? null), label: '33業種' },
            { href: sectorsHeatmapHref('major', universe ?? null), label: '四季報60分類' },
            { href: '/sector-etfs', label: '業界ETF' },
            { href: '/sector-etfs#themes', label: 'テーマETF' },
            { href: '/commodities', label: 'コモディティ' },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              className="inline-flex items-center gap-0.5 font-bold text-[var(--color-brand-700)] hover:text-[var(--color-brand-900)] hover:underline"
            >
              {item.label}
              <ArrowUpRight size={11} aria-hidden="true" />
            </Link>
          ))}
        </nav>
      </div>

      <div className="min-w-0">
        <GroupLabel
          meta="初動=PFS順 / 継続=PMS順 / 失速=PMSプラスかつPFSマイナス / 下落警戒=PMS逆順"
          className="mb-2"
        >
          勢いの4レーン
        </GroupLabel>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-y-5 md:grid-cols-2 md:gap-x-6 xl:grid-cols-4">
          <MomentumLane
            title="初動"
            basis="PFS順"
            rows={data.initialRows}
            scoreKey="pfs"
            scoreLabel="PFS"
            href={marketMomentumRankingHref(rankingGroup, 'initial', date)}
            tone="warning"
            analysisDate={date}
          />
          <MomentumLane
            title="継続"
            basis="PMS順"
            rows={data.continuationRows}
            scoreKey="pms"
            scoreLabel="PMS"
            href={marketMomentumRankingHref(rankingGroup, 'continuation', date)}
            tone="up"
            analysisDate={date}
          />
          <MomentumLane
            title="失速"
            basis="PFS悪化"
            rows={data.stallRows}
            scoreKey="pfs"
            scoreLabel="PFS"
            href={marketMomentumRankingHref(rankingGroup, 'stall', date)}
            tone="down"
            analysisDate={date}
          />
          <MomentumLane
            title="下落警戒"
            basis="PMS逆順"
            rows={data.dropRows}
            scoreKey="pms"
            scoreLabel="PMS"
            href={marketMomentumRankingHref(rankingGroup, 'drop', date)}
            tone="down"
            analysisDate={date}
          />
        </div>
      </div>

      <div className="min-w-0">
        <GroupLabel
          meta="PMSプラス比率の高い順。縦線は50%。行を押すと業種の構成銘柄へ"
          className="mb-2"
        >
          17業種のPMS分布
        </GroupLabel>
        {data.sortedSectors.length === 0 ? (
          <p className="border-y border-[var(--color-border-soft)] py-5 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">
            業種別に集計できる銘柄がありません
          </p>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 lg:grid-cols-2">
            {sectorColumns.map((rows, columnIndex) => (
              <div key={columnIndex} className="min-w-0">
                <div className={`${columnIndex === 1 ? 'hidden lg:grid' : 'grid'} grid-cols-[minmax(0,8rem)_minmax(0,1fr)_3.5rem_3.75rem_4.75rem] items-end gap-x-3 border-y border-[var(--color-border-default)] py-1.5 text-[10px] font-bold text-[var(--color-text-tertiary)] max-sm:grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_3.5rem_3.75rem]`}>
                  <span>業種 <span className="font-semibold">(銘柄数)</span></span>
                  <span>PMSプラス</span>
                  <span className="text-right">比率</span>
                  <span className="text-right">初動+</span>
                  <span className="text-right max-sm:hidden">強 / 弱</span>
                </div>
                <ol className="divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border-soft)]">
                  {rows.map((sector, index) => (
                    <SectorRow
                      key={`${sector.code ?? 'x'}-${sector.label}`}
                      row={sector}
                      rank={columnIndex * half + index + 1}
                      universe={universe ?? null}
                    />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MomentumLane({
  title,
  basis,
  rows,
  scoreKey,
  scoreLabel,
  href,
  tone,
  analysisDate,
}: {
  title: string
  basis: string
  rows: MomentumRankingRow[]
  scoreKey: 'pms' | 'pfs' | 'pes'
  scoreLabel: string
  href: string
  tone: DashboardTone
  analysisDate?: string | null
}) {
  return (
    <section className="min-w-0">
      <header className="flex min-w-0 items-baseline justify-between gap-2 border-t-2 border-[var(--color-brand-900)] py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h4 className={`text-[13px] font-bold ${TONE_TEXT[tone]}`}>{title}</h4>
          <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{basis}</span>
        </div>
        <Link
          href={href}
          prefetch={false}
          className="inline-flex items-center gap-0.5 text-[10px] font-bold text-[var(--color-brand-700)] hover:underline"
          aria-label={`${title}ランキングを全件表示`}
        >
          全件
          <ArrowUpRight size={11} aria-hidden="true" />
        </Link>
      </header>
      <ol>
        {rows.map((row, index) => (
          <li
            key={`${title}-${row.ticker}`}
            className={`grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 border-t border-[var(--color-border-soft)] py-1.5 ${index >= 5 ? 'max-md:hidden' : ''}`}
          >
            <span className="pt-px text-right font-mono text-[10px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <Link
                  href={stockDetailHref(row.ticker, analysisDate)}
                  prefetch={false}
                  className="shrink-0 font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline"
                >
                  {row.ticker}
                </Link>
                <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
                <StockPreviewTrigger ticker={row.ticker} analysisDate={analysisDate} context="home" />
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <StageSix row={row} />
                <span className="min-w-0 truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                  {row.sector17Name ?? '業種未分類'}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className={`font-mono text-[13px] font-bold tabular-nums ${signedTextClass(row[scoreKey])}`}>
                <span className="mr-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]">{scoreLabel}</span>
                {fmtScore(row[scoreKey])}
              </div>
              <div className={`font-mono text-[10px] font-bold tabular-nums ${signedTextClass(row.changePct)}`}>{fmtPct(row.changePct)}</div>
            </div>
          </li>
        ))}
        {rows.length > 5 && (
          <li className="border-t border-[var(--color-border-soft)] py-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)] md:hidden">
            6位以降は「全件」で確認できます
          </li>
        )}
        {rows.length === 0 && (
          <li className="border-t border-[var(--color-border-soft)] py-4 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            ランキング対象がありません
          </li>
        )}
      </ol>
    </section>
  )
}

/** 6ステージ (日A 日B 週A 週B 月A 月B) を並びだけで示す。順序はヘッダー凡例と共通 */
function StageSix({ row }: { row: MomentumRankingRow }) {
  const stages = [
    { label: '日A', value: row.dailyAStage },
    { label: '日B', value: row.dailyBStage },
    { label: '週A', value: row.weeklyAStage },
    { label: '週B', value: row.weeklyBStage },
    { label: '月A', value: row.monthlyAStage },
    { label: '月B', value: row.monthlyBStage },
  ]
  return (
    <span className="inline-flex shrink-0 items-center gap-px" aria-label={stages.map((s) => `${s.label} ${s.value ?? '未算出'}`).join(' / ')}>
      {stages.map((item, index) => (
        <span key={item.label} className={`inline-flex ${index === 2 || index === 4 ? 'ml-1' : ''}`} title={`${item.label}: ${item.value ?? '未算出'}`}>
          <StageTag stage={item.value} size="xs" />
        </span>
      ))}
    </span>
  )
}

function SectorRow({ row, rank, universe }: { row: MomentumGroupRow; rank: number; universe: UniverseFilterValue }) {
  const pmsPlus = ratio(row.positivePms, row.count)
  const pfsPlus = ratio(row.positivePfs, row.count)
  const tone = heatTone(pmsPlus)
  const href = buildSectorsHref({
    sectorType: '17',
    sectorName: row.label,
    sectorPeriod: 'today',
    sectorSort: 'pms',
    sectorDir: 'desc',
    universe: universe ?? null,
  })
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_3.5rem_3.75rem_4.75rem] items-center gap-x-3 py-[7px] transition-colors hover:bg-[var(--color-surface-subtle)] max-sm:grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_3.5rem_3.75rem]"
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="w-4 shrink-0 text-right font-mono text-[9px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{rank}</span>
          <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{row.label}</span>
          <span className="shrink-0 font-mono text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{fmtCount(row.count)}</span>
        </span>
        <MeterBar value={pmsPlus} tone={tone} midTick />
        <span className={`text-right font-mono text-[12px] font-bold tabular-nums ${TONE_TEXT[tone]}`}>{fmtRatio(pmsPlus)}</span>
        <span className="text-right font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-secondary)]">{fmtRatio(pfsPlus)}</span>
        <span className="text-right font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)] max-sm:hidden">
          <span className={TONE_TEXT.up}>{fmtCount(row.strongPms)}</span>
          <span className="mx-0.5">/</span>
          <span className={TONE_TEXT.down}>{fmtCount(row.weakPms)}</span>
        </span>
      </Link>
    </li>
  )
}
