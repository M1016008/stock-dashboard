import Link from 'next/link'
import { execAll, execGet } from '@/lib/db/client'
import { NIKKEI225_TICKERS, type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import {
  marketMomentumHrefForSegment,
  marketMomentumRankingHref,
  type MarketMomentumGroupId,
} from '@/lib/market-momentum-groups'
import { StageTag } from '@/components/ui/StageTag'

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

type MomentumGroupRow = {
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

type MomentumRankingRow = {
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

function ratio(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part == null || total == null || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null
  return (part / total) * 100
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value.toFixed(1)}%`
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(2)
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtCount(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString('ja-JP')
}

function breadthTone(value: number | null | undefined, goodAbove = 50): 'up' | 'down' | 'neutral' {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  if (value >= goodAbove) return 'up'
  if (value <= 100 - goodAbove) return 'down'
  return 'neutral'
}

function tileToneClass(tone: 'up' | 'down' | 'neutral' | 'warning'): string {
  if (tone === 'up') return 'border-[rgba(185,28,28,0.22)] bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  if (tone === 'down') return 'border-[rgba(30,64,175,0.22)] bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  if (tone === 'warning') return 'border-[rgba(217,119,6,0.24)] bg-[#fff7ed] text-[#b45309]'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-primary)]'
}

function marketReading(row: MomentumSummaryRow | undefined): { label: string; tone: 'up' | 'down' | 'neutral' | 'warning'; note: string } {
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

function groupReading(row: MomentumGroupRow): { label: string; tone: 'up' | 'down' | 'neutral' | 'warning' } {
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

function heatmapStyle(value: number | null | undefined): React.CSSProperties {
  if (value == null || !Number.isFinite(value)) {
    return {
      background: 'var(--color-surface-subtle)',
      borderColor: 'var(--color-border-soft)',
      color: 'var(--color-text-secondary)',
    }
  }
  const distance = Math.min(1, Math.abs(value - 50) / 35)
  const alpha = 0.06 + distance * 0.22
  if (value >= 50) {
    return {
      background: `rgba(220,38,38,${alpha})`,
      borderColor: 'rgba(220,38,38,0.24)',
      color: 'var(--color-price-up)',
    }
  }
  return {
    background: `rgba(37,99,235,${alpha})`,
    borderColor: 'rgba(37,99,235,0.24)',
    color: 'var(--color-price-down)',
  }
}

function buildSectorsHref(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null && String(value).trim() !== '') sp.set(key, String(value))
  }
  const query = sp.toString()
  return `/sectors${query ? `?${query}` : ''}#sector-stocks`
}

function groupFromUniverse(universe: UniverseFilterValue): MarketMomentumGroupId {
  return universe === 'nikkei225' ? 'nikkei225' : 'all'
}

export async function PhysicalMomentumMarket({
  date = null,
  universe = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
}) {
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
  const pmsPlusRatio = ratio(row?.positivePms ?? 0, count)
  const strongRatio = ratio(row?.strongPms ?? 0, count)
  const weakRatio = ratio(row?.weakPms ?? 0, count)
  const forcePlusRatio = ratio(row?.positivePfs ?? 0, count)
  const energyHighRatio = ratio(row?.highPes ?? 0, count)
  const reading = marketReading(row)
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
  const rankingGroup = groupFromUniverse(universe)

  return (
    <section className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">市場別モメンタム分布</h2>
          <p className="mt-1 max-w-[760px] text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            日経225・プライム・スタンダード・グロース、業種ごとに個別銘柄のPMS分布を確認します。ETFチャートを見る前に、どの市場・業種で初動が広がっているかを掴むための地図です。
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link href="/sector-etfs" className="rounded-full border border-[var(--color-border-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
            業界ETF分析
          </Link>
          <Link href="/commodities" className="rounded-full border border-[var(--color-border-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
            コモディティ
          </Link>
          <Link href="/sectors" className="rounded-full border border-[var(--color-border-soft)] px-2.5 py-1 text-[11px] font-bold text-[var(--color-brand-800)] hover:bg-[var(--color-surface-subtle)]">
            業種分析
          </Link>
          <span className="font-mono text-[11px] font-bold text-[var(--color-text-tertiary)]">
            {row?.date ?? '---'} / {count.toLocaleString()}銘柄
          </span>
        </div>
      </div>

      <div className={`mb-3 rounded-[8px] border px-3 py-2 ${tileToneClass(reading.tone)}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12px] font-bold">全体判定: {reading.label}</div>
          <div className="font-mono text-[10px] font-bold opacity-80">{count.toLocaleString()}銘柄の分布で判定</div>
        </div>
        <p className="mt-1 text-[11px] font-semibold leading-relaxed opacity-85">{reading.note}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <MomentumRatioTile
          label="プラス銘柄比率"
          value={pmsPlusRatio}
          count={row?.positivePms ?? 0}
          total={count}
          tone={breadthTone(pmsPlusRatio, 52)}
          help="PMSが0を上回る銘柄の割合"
        />
        <MomentumRatioTile
          label="強い勢い"
          value={strongRatio}
          count={row?.strongPms ?? 0}
          total={count}
          tone="up"
          help="PMSが+1以上の上位側銘柄"
        />
        <MomentumRatioTile
          label="弱い勢い"
          value={weakRatio}
          count={row?.weakPms ?? 0}
          total={count}
          tone="down"
          help="PMSが-1以下の下位側銘柄"
        />
        <MomentumRatioTile
          label="初動プラス"
          value={forcePlusRatio}
          count={row?.positivePfs ?? 0}
          total={count}
          tone={breadthTone(forcePlusRatio, 55)}
          help="PFSが0を上回り、押し出す力がプラスの銘柄"
        />
        <MomentumRatioTile
          label="熱量上位"
          value={energyHighRatio}
          count={row?.highPes ?? 0}
          total={count}
          tone="warning"
          help="PESが+1以上で値動きの熱量が高い銘柄"
        />
      </div>

      <div className="mt-4 border-t border-[var(--color-border-soft)] pt-4">
        <SectionLabel
          title="初動 / 継続 / 失速 / 下落警戒ランキング"
          description="初動はPFS、継続はPMS、失速はPMSが残る中でのPFS悪化、下落警戒はPMS/PFSの弱さで分けます。"
        />
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
          <MomentumRankingPanel
            title="初動"
            badge="PFS順"
            rows={initialRows}
            scoreKey="pfs"
            scoreLabel="PFS"
            href={marketMomentumRankingHref(rankingGroup, 'initial', date)}
            tone="warning"
          />
          <MomentumRankingPanel
            title="継続"
            badge="PMS順"
            rows={continuationRows}
            scoreKey="pms"
            scoreLabel="PMS"
            href={marketMomentumRankingHref(rankingGroup, 'continuation', date)}
            tone="up"
          />
          <MomentumRankingPanel
            title="失速"
            badge="PFS悪化"
            rows={stallRows}
            scoreKey="pfs"
            scoreLabel="PFS"
            href={marketMomentumRankingHref(rankingGroup, 'stall', date)}
            tone="down"
          />
          <MomentumRankingPanel
            title="下落警戒"
            badge="PMS逆順"
            rows={dropRows}
            scoreKey="pms"
            scoreLabel="PMS"
            href={marketMomentumRankingHref(rankingGroup, 'drop', date)}
            tone="down"
          />
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--color-border-soft)] pt-4">
        <SectionLabel
          title="市場区分別"
          description="日経225、プライム、スタンダード、グロースで勢いの広がりを分けて確認します。"
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {sortedSegments.map((segment) => (
            <MarketSegmentTile key={segment.label} row={segment} date={date} />
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--color-border-soft)] pt-4">
        <SectionLabel
          title="17業種ヒートマップ"
          description="色はPMSプラス比率。赤系は勢いが広がり、青系は弱含みです。各業種をクリックすると構成銘柄一覧へ移動します。"
        />
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
          {sortedSectors.map((sector) => (
            <SectorMomentumTile key={`${sector.code ?? 'x'}-${sector.label}`} row={sector} universe={universe} />
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--color-border-soft)] pt-4">
        <SectionLabel
          title="ETF・テーマで確認"
          description="分布で強い場所を見つけたら、ETFやテーマチャートで実際の価格トレンドと一致しているか確認します。"
        />
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          <ThemeBridgeCard
            href="/sector-etfs"
            title="TOPIX-17 業界ETF"
            badge="業界ETF"
            body="業種ETFのチャート、6ステージ、構成銘柄の寄与を確認します。"
          />
          <ThemeBridgeCard
            href="/sector-etfs#themes"
            title="国内テーマETF"
            badge="テーマ"
            body="半導体、AI、バイオ、防衛などのテーマETFで値動きの裏取りをします。"
          />
          <ThemeBridgeCard
            href="/commodities"
            title="コモディティETF"
            badge="商品"
            body="金、原油、天然ガス、農産物など、商品連動ETF/ETNの地合いを確認します。"
          />
          <ThemeBridgeCard
            href="/sectors"
            title="業種銘柄一覧"
            badge="銘柄分布"
            body="業種ごとの構成銘柄、貸借区分、出来高、ステージ、PMSを掘り下げます。"
          />
        </div>
      </div>
    </section>
  )
}

function scoreTextColor(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function MomentumRankingPanel({
  title,
  badge,
  rows,
  scoreKey,
  scoreLabel,
  href,
  tone,
}: {
  title: string
  badge: string
  rows: MomentumRankingRow[]
  scoreKey: 'pms' | 'pfs' | 'pes'
  scoreLabel: string
  href: string
  tone: 'up' | 'down' | 'warning'
}) {
  return (
    <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
      <div className={`flex items-center justify-between gap-2 border-b px-3 py-2 ${tileToneClass(tone)}`}>
        <div>
          <div className="text-[12px] font-bold">{title}</div>
          <div className="mt-0.5 text-[10px] font-semibold opacity-75">{badge}</div>
        </div>
        <Link href={href} prefetch={false} className="rounded-full border border-current/25 bg-white/60 px-2 py-1 text-[10px] font-bold hover:bg-white">
          全件
        </Link>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)] bg-white">
        {rows.map((row, index) => (
          <div key={`${title}-${row.ticker}`} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
            <div className="font-mono text-[12px] font-bold text-[var(--color-text-tertiary)]">{index + 1}</div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Link href={`/stock/${encodeURIComponent(row.ticker)}`} prefetch={false} className="font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline">
                  {row.ticker}
                </Link>
                <span className="truncate text-[11px] font-bold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                <span>{row.marketSegment ?? '市場未分類'}</span>
                <span>{row.sector17Name ?? '業種未分類'}</span>
              </div>
              <StageMiniStrip row={row} />
            </div>
            <div className="text-right">
              <div className={`font-mono text-[14px] font-bold ${scoreTextColor(row[scoreKey])}`}>{fmtScore(row[scoreKey])}</div>
              <div className="mt-0.5 text-[10px] font-bold text-[var(--color-text-tertiary)]">{scoreLabel}</div>
              <div className={`mt-0.5 font-mono text-[10px] font-bold ${scoreTextColor(row.changePct)}`}>{fmtPct(row.changePct)}</div>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">ランキング対象がありません</div>
        )}
      </div>
    </div>
  )
}

function StageMiniStrip({ row }: { row: MomentumRankingRow }) {
  const stages = [
    { label: '日A', value: row.dailyAStage },
    { label: '日B', value: row.dailyBStage },
    { label: '週A', value: row.weeklyAStage },
    { label: '週B', value: row.weeklyBStage },
    { label: '月A', value: row.monthlyAStage },
    { label: '月B', value: row.monthlyBStage },
  ]
  return (
    <div className="mt-1.5 flex w-full max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {stages.map((item) => (
        <span
          key={item.label}
          className="inline-flex shrink-0"
          title={`${item.label}: ${item.value ?? '未算出'}`}
          aria-label={`${item.label}: ${item.value ?? '未算出'}`}
        >
          <StageTag stage={item.value} size="xs" />
        </span>
      ))}
    </div>
  )
}

function SectionLabel({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-[13px] font-bold text-[var(--color-brand-900)]">{title}</h3>
      <p className="max-w-[760px] text-[10px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">{description}</p>
    </div>
  )
}

function MarketSegmentTile({ row, date }: { row: MomentumGroupRow; date?: string | null }) {
  const pmsPlus = ratio(row.positivePms, row.count)
  const pfsPlus = ratio(row.positivePfs, row.count)
  const reading = groupReading(row)
  const width = pmsPlus == null || !Number.isFinite(pmsPlus) ? 0 : Math.max(0, Math.min(100, pmsPlus))
  const href = marketMomentumHrefForSegment(row.label, row.code, date)
  return (
    <Link
      href={href}
      prefetch={false}
      className={`block rounded-[8px] border px-3 py-2 transition hover:translate-y-[-1px] hover:shadow-sm ${tileToneClass(reading.tone)}`}
      aria-label={`${row.label}の銘柄別モメンタムを見る`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-bold">{row.label}</div>
        <div className="rounded-full border border-current/25 px-2 py-0.5 text-[10px] font-bold opacity-80">{reading.label}</div>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold opacity-70">PMSプラス</div>
          <div className="font-mono text-[24px] font-bold leading-none">{fmtRatio(pmsPlus)}</div>
        </div>
        <div className="text-right text-[10px] font-bold opacity-75">
          <div>PMS算出 {fmtCount(row.count)}銘柄</div>
          <div>初動+ {fmtRatio(pfsPlus)}</div>
        </div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/75">
        <span className="block h-full rounded-full bg-current opacity-65" style={{ width: `${width}%` }} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-bold opacity-75">
        <span>強い {fmtCount(row.strongPms)}</span>
        <span>弱い {fmtCount(row.weakPms)}</span>
      </div>
      <div className="mt-2 text-[9px] font-bold opacity-70">クリックで銘柄一覧</div>
    </Link>
  )
}

function SectorMomentumTile({ row, universe }: { row: MomentumGroupRow; universe: UniverseFilterValue }) {
  const pmsPlus = ratio(row.positivePms, row.count)
  const pfsPlus = ratio(row.positivePfs, row.count)
  const href = buildSectorsHref({
    sectorType: '17',
    sectorName: row.label,
    sectorPeriod: 'today',
    sectorSort: 'pms',
    sectorDir: 'desc',
    universe: universe ?? null,
  })
  return (
    <Link
      href={href}
      className="rounded-[8px] border px-2.5 py-2 transition hover:translate-y-[-1px] hover:shadow-sm"
      style={heatmapStyle(pmsPlus)}
      prefetch={false}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] font-bold text-[var(--color-text-primary)]">{row.label}</div>
        <div className="shrink-0 font-mono text-[10px] font-bold opacity-70">{fmtCount(row.count)}</div>
      </div>
      <div className="mt-1 font-mono text-[18px] font-bold">{fmtRatio(pmsPlus)}</div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] font-bold opacity-75">
        <span>初動 {fmtRatio(pfsPlus)}</span>
        <span>強{fmtCount(row.strongPms)} / 弱{fmtCount(row.weakPms)}</span>
      </div>
    </Link>
  )
}

function ThemeBridgeCard({ href, title, badge, body }: { href: string; title: string; badge: string; body: string }) {
  return (
    <Link
      href={href}
      className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 transition hover:border-[var(--color-brand-700)] hover:bg-white"
      prefetch={false}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-bold text-[var(--color-brand-900)]">{title}</div>
        <span className="rounded-full border border-[var(--color-border-soft)] bg-white px-2 py-0.5 text-[9px] font-bold text-[var(--color-text-tertiary)]">{badge}</span>
      </div>
      <p className="mt-2 text-[10px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{body}</p>
    </Link>
  )
}

function MomentumRatioTile({
  label,
  value,
  count,
  total,
  tone,
  help,
}: {
  label: string
  value: number | null
  count: number
  total: number
  tone: 'up' | 'down' | 'neutral' | 'warning'
  help: string
}) {
  const width = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className={`rounded-[8px] border px-3 py-2 ${tileToneClass(tone)}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold opacity-75">{label}</div>
        <div className="font-mono text-[10px] font-bold opacity-70">{count.toLocaleString()} / {total.toLocaleString()}</div>
      </div>
      <div className="mt-1 font-mono text-[20px] font-bold">{fmtRatio(value)}</div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/75">
        <span className="block h-full rounded-full bg-current opacity-65" style={{ width: `${width}%` }} />
      </div>
      <p className="mt-2 text-[10px] font-semibold leading-relaxed opacity-75">{help}</p>
    </div>
  )
}
