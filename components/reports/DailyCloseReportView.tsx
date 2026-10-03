'use client'

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { ReactNode } from 'react'
import { StageTag } from '@/components/ui/StageTag'
import type {
  ClassificationMomentum,
  DailyCloseReport,
  PeriodMetric,
  ReportTakeaway,
  ReportTickerRow,
  SectorRotationRow,
  StageSet,
  TriggerReportRow,
} from '@/lib/daily-close-report'
import styles from './daily-close-report.module.css'

const integer = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const money = new Intl.NumberFormat('ja-JP', { notation: 'compact', style: 'currency', currency: 'JPY', maximumFractionDigits: 1 })

function pct(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? 'N/A' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function tone(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? styles.neutral : value > 0 ? styles.positive : value < 0 ? styles.negative : styles.neutral
}

function Page({ report, number, title, kicker, children }: {
  report: DailyCloseReport
  number: number
  title: string
  kicker: string
  children: ReactNode
}) {
  const takeaway = report.takeaways[number]
  return (
    <section className={styles.page} data-page={number} aria-labelledby={`report-page-${number}`}>
      <header className={styles.pageHeader}>
        <div><span>{kicker}</span><h2 id={`report-page-${number}`}>{title}</h2></div>
        <div className={styles.pageMeta}><b>STOCKBOARD DAILY CLOSE</b><span>{report.reportDate}</span></div>
      </header>
      <Takeaway value={takeaway} />
      <div className={styles.pageBody}>{children}</div>
      <footer className={styles.pageFooter}>
        <span>DATA AS OF {report.priceDate} / GENERATED {new Date(report.generatedAt).toLocaleString('ja-JP')}</span>
        <span>{String(number).padStart(2, '0')} / 11</span>
      </footer>
    </section>
  )
}

function Takeaway({ value }: { value: ReportTakeaway }) {
  return <div className={styles.takeaway}><span>KEY TAKEAWAY</span><strong>{value.headline}</strong>{value.detail.map((line) => <small key={line}>{line}</small>)}</div>
}

function Delta({ value }: { value: number | null | undefined }) {
  if (value == null || !Number.isFinite(value) || value === 0) return <span className={styles.neutral}><Minus size={12} /> —</span>
  return <span className={tone(value)}>{value > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{value > 0 ? '+' : ''}{value.toFixed(2)}%</span>
}

function StatusStrip({ report }: { report: DailyCloseReport }) {
  const rows = [
    ['JP PRICE', report.dataStatus.jpPrice], ['JP DERIVED', report.dataStatus.jpDerived],
    ['TRIGGER', report.dataStatus.trigger], ['LARGE HOLDER', report.dataStatus.largeHolder],
  ] as const
  return <div className={styles.statusStrip}>{rows.map(([label, status]) => <div key={label}><span>{label}</span><b className={status.status === 'CURRENT' ? styles.statusCurrent : styles.statusDelayed}>{status.status}</b><small>{status.date ?? 'N/A'}</small></div>)}</div>
}

function BreadthBar({ advances, declines, unchanged }: { advances: number; declines: number; unchanged: number }) {
  const total = Math.max(1, advances + declines + unchanged)
  return <div className={styles.breadth} aria-label={`上昇${advances} 横ばい${unchanged} 下落${declines}`}>
    <div style={{ width: `${advances / total * 100}%` }} className={styles.breadthUp}>{integer.format(advances)}</div>
    <div style={{ width: `${unchanged / total * 100}%` }} className={styles.breadthFlat}>{integer.format(unchanged)}</div>
    <div style={{ width: `${declines / total * 100}%` }} className={styles.breadthDown}>{integer.format(declines)}</div>
  </div>
}

function StageStrip({ stages }: { stages: StageSet }) {
  const values: Array<[string, number | null]> = [['日A', stages.dayA], ['日B', stages.dayB], ['週A', stages.weekA], ['週B', stages.weekB], ['月A', stages.monthA], ['月B', stages.monthB]]
  return <div className={styles.stageStrip}>{values.map(([label, value]) => <span key={label}><small>{label}</small><StageTag stage={value} size="xs" /></span>)}</div>
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className={styles.na}>N/A</span>
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${32 - ((value - min) / span) * 28}`).join(' ')
  const up = values.at(-1)! >= values[0]
  return <svg className={styles.sparkline} viewBox="0 0 100 36" role="img" aria-label="24営業日価格推移"><polyline points={points} fill="none" stroke={up ? '#15803d' : '#b91c1c'} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
}

function HeatCell({ value, maxAbs }: { value: number | null; maxAbs: number }) {
  if (value == null) return <span className={styles.heatNa}>N/A</span>
  const alpha = Math.min(.88, .12 + Math.abs(value) / Math.max(.01, maxAbs) * .76)
  const color = value >= 0 ? `rgba(15,118,110,${alpha})` : `rgba(185,28,28,${alpha})`
  return <span className={styles.heatValue} style={{ backgroundColor: color, color: alpha > .5 ? '#fff' : '#0b1f33' }}>{pct(value, 1)}</span>
}

function RankingTable({ rows, metric, title }: { rows: ClassificationMomentum[]; metric: (row: ClassificationMomentum) => PeriodMetric; title: string }) {
  return <div className={styles.rankingBlock}><h3>{title}</h3><table><thead><tr><th>#</th><th>分類</th><th>平均</th><th>中央値</th><th>勝率</th><th>N</th></tr></thead><tbody>{rows.map((row, index) => { const value = metric(row); return <tr key={row.name}><td>{index + 1}</td><td>{row.name}{value.lowSample ? <em>LOW SAMPLE</em> : null}</td><td className={tone(value.meanReturn)}>{pct(value.meanReturn)}</td><td>{pct(value.medianReturn)}</td><td>{value.winRate == null ? 'N/A' : `${(value.winRate * 100).toFixed(0)}%`}</td><td>{value.eligibleCount}/{value.totalCount}</td></tr> })}</tbody></table></div>
}

function topBottom(rows: ClassificationMomentum[], metric: (row: ClassificationMomentum) => PeriodMetric) {
  const eligible = rows.filter((row) => metric(row).meanReturn != null)
  return { top: [...eligible].sort((a, b) => metric(b).meanReturn! - metric(a).meanReturn!).slice(0, 10), bottom: [...eligible].sort((a, b) => metric(a).meanReturn! - metric(b).meanReturn!).slice(0, 10) }
}

function BarList({ rows, value }: { rows: SectorRotationRow[]; value: (row: SectorRotationRow) => number | null }) {
  const max = Math.max(.01, ...rows.map((row) => Math.abs(value(row) ?? 0)))
  return <div className={styles.barList}>{rows.map((row) => { const number = value(row); return <div key={row.name}><span>{row.name}</span><div><i className={number != null && number < 0 ? styles.barNegative : styles.barPositive} style={{ width: `${Math.abs(number ?? 0) / max * 100}%` }} /></div><b className={tone(number)}>{pct(number)}</b></div> })}</div>
}

function TriggerTable({ rows }: { rows: TriggerReportRow[] }) {
  if (!rows.length) return <Empty label="該当銘柄なし" />
  return <div className={styles.tableScroll}><table><thead><tr><th>銘柄</th><th>Status</th><th>Score</th><th>Zone</th><th>日A</th><th>週A</th><th>売買代金</th></tr></thead><tbody>{rows.map((row) => <tr key={row.ticker}><td><b>{row.ticker}</b><small>{row.name}</small></td><td><span className={styles.triggerStatus}>{row.status}</span></td><td>{row.score.toFixed(0)}</td><td>{pct(row.zoneDistancePct)}</td><td><StageTag stage={row.stages.dayA} size="xs" /></td><td><StageTag stage={row.stages.weekA} size="xs" /></td><td>{row.averageTradingValue == null ? 'N/A' : money.format(row.averageTradingValue)}</td></tr>)}</tbody></table></div>
}

function TickerList({ rows, metric }: { rows: ReportTickerRow[]; metric: (row: ReportTickerRow) => string }) {
  if (!rows.length) return <Empty label="該当データなし" />
  return <ol className={styles.tickerList}>{rows.map((row) => <li key={row.ticker}><span><b>{row.ticker}</b><small>{row.name}</small></span><strong>{metric(row)}</strong><Delta value={row.dailyReturn} /></li>)}</ol>
}

function Empty({ label }: { label: string }) {
  return <div className={styles.empty}><Minus size={18} /><span>{label}</span></div>
}

function Scatter({ rows }: { rows: ClassificationMomentum[] }) {
  const eligible = rows.filter((row) => row.oneWeek.meanReturn != null && row.oneMonth.meanReturn != null)
  if (!eligible.length) return <Empty label="Scatter data unavailable" />
  const bound = Math.max(1, ...eligible.flatMap((row) => [Math.abs(row.oneWeek.meanReturn!), Math.abs(row.oneMonth.meanReturn!)])) * 1.15
  const x = (value: number) => 40 + (value + bound) / (bound * 2) * 520
  const y = (value: number) => 280 - (value + bound) / (bound * 2) * 240
  const highlights = new Set([...eligible].sort((a, b) => Math.abs(b.rankChange1MTo1W ?? 0) - Math.abs(a.rankChange1MTo1W ?? 0)).slice(0, 8).map((row) => row.name))
  return <svg className={styles.scatter} viewBox="0 0 600 320" role="img" aria-label="60分類 1か月対1週間モメンタム散布図">
    <line x1={x(0)} y1="30" x2={x(0)} y2="290" /><line x1="30" y1={y(0)} x2="575" y2={y(0)} />
    <text x="470" y="45">STRONG TREND</text><text x="45" y="45">NEW MOMENTUM</text><text x="45" y="275">WEAK TREND</text><text x="440" y="275">LOSING MOMENTUM</text>
    {eligible.map((row) => <g key={row.name}><circle cx={x(row.oneMonth.meanReturn!)} cy={y(row.oneWeek.meanReturn!)} r={highlights.has(row.name) ? 5 : 3} className={highlights.has(row.name) ? styles.scatterAccent : styles.scatterDot} />{highlights.has(row.name) ? <text x={x(row.oneMonth.meanReturn!) + 7} y={y(row.oneWeek.meanReturn!) - 5}>{row.name}</text> : null}</g>)}
    <text x="485" y="310">1M mean return →</text><text x="8" y="25">1W ↑</text>
  </svg>
}

function ReportTable({ children }: { children: ReactNode }) { return <div className={styles.tableScroll}><table>{children}</table></div> }

export function DailyCloseReportView({ report }: { report: DailyCloseReport }) {
  const oneWeek = topBottom(report.classifications60, (row) => row.oneWeek)
  const twoWeek = topBottom(report.classifications60, (row) => row.twoWeek)
  const oneMonth = topBottom(report.classifications60, (row) => row.oneMonth)
  const sectorTop = report.sectors33.slice(0, 5)
  const sectorBottom = [...report.sectors33].filter((row) => row.return1D != null).sort((a, b) => a.return1D! - b.return1D!).slice(0, 5)
  const heatMax = Math.max(1, ...report.classifications60.flatMap((row) => [row.oneWeek.meanReturn, row.twoWeek.meanReturn, row.oneMonth.meanReturn].filter((value): value is number => value != null).map(Math.abs)))
  const maxStageCount = Math.max(1, ...report.market.stageDistribution.map((item) => item.count))
  return <div className={styles.report}>
    <Page report={report} number={1} title="EXECUTIVE SUMMARY" kicker="MARKET AT A GLANCE">
      <StatusStrip report={report} />
      <div className={styles.kpiGrid}>{report.executive.kpis.map((kpi) => <div className={styles.kpi} key={kpi.label}><span>{kpi.label}</span><strong>{kpi.value}</strong><Delta value={kpi.change} /><small>{kpi.context}</small></div>)}</div>
      <div className={styles.keyPoints}><h3>TODAY&apos;S KEY POINTS</h3>{report.executive.keyPoints.map((point, index) => <div key={point}><b>{String(index + 1).padStart(2, '0')}</b><span>{point}</span></div>)}</div>
    </Page>

    <Page report={report} number={2} title="MARKET OVERVIEW" kicker="BREADTH & INTERNALS">
      <div className={styles.twoColumns}><div className={styles.panel}><h3>MARKET BREADTH</h3><BreadthBar advances={report.market.advances} declines={report.market.declines} unchanged={report.market.unchanged} /><div className={styles.breadthLegend}><span>上昇 {integer.format(report.market.advances)}</span><span>横ばい {integer.format(report.market.unchanged)}</span><span>下落 {integer.format(report.market.declines)}</span></div><h3>INDEX CLOSE</h3><div className={styles.indexList}>{report.market.indices.map((index) => <div key={index.code}><span>{index.label}<small>{index.note}</small></span><b>{index.value == null ? 'N/A' : index.value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}</b><Delta value={index.changePct} /></div>)}</div></div><div className={styles.panel}><h3>INTERNAL INDICATORS</h3><div className={styles.metricRows}><div><span>売買代金</span><b>{money.format(report.market.tradingValue)}</b></div><div><span>新高値</span><b>{integer.format(report.market.newHighs)}</b></div><div><span>新安値</span><b>{integer.format(report.market.newLows)}</b></div></div><h3>DAILY A STAGE DISTRIBUTION</h3><div className={styles.stageDistribution}>{report.market.stageDistribution.map((row) => <div key={row.stage}><StageTag stage={row.stage} size="sm" /><i style={{ height: `${Math.max(4, row.count / maxStageCount * 120)}px` }} /><b>{integer.format(row.count)}</b></div>)}</div></div></div>
    </Page>

    <Page report={report} number={3} title="33業種 ROTATION" kicker="SECTOR LEADERSHIP">
      <div className={styles.sectorLayout}><div className={styles.sectorHeat}>{report.sectors33.map((row) => <div key={row.name}><span>{row.name}</span><HeatCell value={row.return1D} maxAbs={Math.max(1, ...report.sectors33.map((item) => Math.abs(item.return1D ?? 0)))} /><small>#{row.currentRank ?? '—'} / 5D {pct(row.return5D, 1)}</small></div>)}</div><aside><h3>TOP 5</h3><BarList rows={sectorTop} value={(row) => row.return1D} /><h3>BOTTOM 5</h3><BarList rows={sectorBottom} value={(row) => row.return1D} /></aside></div>
    </Page>

    <Page report={report} number={4} title="四季報60細分類 OVERVIEW" kicker="MULTI-HORIZON MOMENTUM">
      <div className={styles.heatLegend}><span>60分類</span><span>1W / 2W / 1M mean return</span><span><i className={styles.legendNegative} /> NEGATIVE <i className={styles.legendPositive} /> POSITIVE</span></div>
      <div className={styles.classificationHeat}>{report.classifications60.map((row) => <div key={row.name}><strong>{row.name}</strong><span><HeatCell value={row.oneWeek.meanReturn} maxAbs={heatMax} /><HeatCell value={row.twoWeek.meanReturn} maxAbs={heatMax} /><HeatCell value={row.oneMonth.meanReturn} maxAbs={heatMax} /></span><small>{row.oneWeek.eligibleCount}/{row.oneWeek.totalCount}{row.oneWeek.lowSample ? ' · LOW SAMPLE' : ''}</small></div>)}</div>
    </Page>

    <Page report={report} number={5} title="60分類 1W / 2W MOMENTUM" kicker="SHORT-TERM LEADERS & LAGGARDS">
      <div className={styles.rankingColumns}><div><RankingTable title="1 WEEK · TOP 10" rows={oneWeek.top} metric={(row) => row.oneWeek} /><RankingTable title="1 WEEK · BOTTOM 10" rows={oneWeek.bottom} metric={(row) => row.oneWeek} /></div><div><RankingTable title="2 WEEKS · TOP 10" rows={twoWeek.top} metric={(row) => row.twoWeek} /><RankingTable title="2 WEEKS · BOTTOM 10" rows={twoWeek.bottom} metric={(row) => row.twoWeek} /></div></div>
    </Page>

    <Page report={report} number={6} title="60分類 1M & ACCELERATION" kicker="TREND VS RECENT MOMENTUM">
      <div className={styles.accelerationLayout}><div><RankingTable title="1 MONTH · TOP 10" rows={oneMonth.top} metric={(row) => row.oneMonth} /><RankingTable title="1 MONTH · BOTTOM 10" rows={oneMonth.bottom} metric={(row) => row.oneMonth} /></div><div><h3>MOMENTUM MAP</h3><Scatter rows={report.classifications60} /><div className={styles.rankMoves}>{[...report.classifications60].filter((row) => row.rankChange1MTo1W != null).sort((a, b) => Math.abs(b.rankChange1MTo1W!) - Math.abs(a.rankChange1MTo1W!)).slice(0, 5).map((row) => <span key={row.name}>{row.name}<b className={tone(row.rankChange1MTo1W)}>#{row.rank1M}→#{row.rank1W} ({row.rankChange1MTo1W! >= 0 ? '↑' : '↓'}{Math.abs(row.rankChange1MTo1W!)})</b></span>)}</div></div></div>
    </Page>

    <Page report={report} number={7} title="WATCHLIST 100" kicker="MY UNIVERSE">
      {report.watchlist.changed.length ? <ReportTable><thead><tr><th>銘柄</th><th>Price</th><th>Daily</th><th>変化</th><th>Trigger</th><th>Score</th><th>6 Stage</th><th>24D</th></tr></thead><tbody>{report.watchlist.changed.map((row) => <tr key={row.ticker}><td><b>{row.ticker}</b><small>{row.name}</small></td><td>{row.price?.toLocaleString() ?? 'N/A'}</td><td className={tone(row.dailyReturn)}>{pct(row.dailyReturn)}</td><td>{row.changeReasons.join(' / ')}</td><td>{Number.isFinite(row.zoneDistancePct) ? `${row.status} ${pct(row.zoneDistancePct)}` : 'N/A'}</td><td>{Number.isFinite(row.score) ? row.score.toFixed(0) : 'N/A'}</td><td><StageStrip stages={row.stages} /></td><td><Sparkline values={row.sparkline} /></td></tr>)}</tbody></ReportTable> : <div className={styles.largeEmpty}><h3>MY UNIVERSE</h3><p>{report.watchlist.total ? '本日のmeaningful changeはありません。' : 'このBrowserのWatchlistに日本株が登録されていません。'}</p><small>WatchlistはBrowser localStorageをSingle Sourceとしてread-only参照します。</small></div>}
    </Page>

    <Page report={report} number={8} title="TRIGGER DISCOVERY" kicker="CONDITION FIT & PRIORITY">
      <div className={styles.triggerKpis}>{(['NEW', 'RE_ENTRY', 'NEAR', 'IN_ZONE'] as const).map((key) => <div key={key}><span>{key}</span><strong>{report.trigger.currentCounts[key]}</strong><small>前回 {report.trigger.previousCounts[key]} / Δ {report.trigger.currentCounts[key] - report.trigger.previousCounts[key] >= 0 ? '+' : ''}{report.trigger.currentCounts[key] - report.trigger.previousCounts[key]}</small></div>)}</div>
      <div className={styles.twoColumns}><div className={styles.panel}><h3>NEW / RE_ENTRY</h3><TriggerTable rows={[...report.trigger.newRows, ...report.trigger.reentryRows].slice(0, 8)} /></div><div className={styles.panel}><h3>NEAR / IN_ZONE</h3><TriggerTable rows={[...report.trigger.nearRows, ...report.trigger.inZoneRows].slice(0, 8)} /></div></div>
    </Page>

    <Page report={report} number={9} title="STAGE & MA SETUP" kicker="TECHNICAL CHANGE MONITOR">
      <div className={styles.threeColumns}><div className={styles.panel}><h3>STAGE IMPROVING</h3>{report.setups.stageImproving.length ? <ol className={styles.setupList}>{report.setups.stageImproving.map((row) => <li key={row.ticker}><span><b>{row.ticker}</b><small>{row.name}</small></span><em>{row.changes.join(' / ')}</em><StageStrip stages={row.stages} /></li>)}</ol> : <Empty label="本日のStage改善なし" />}</div><div className={styles.panel}><h3>MA APPROACHING</h3><TriggerTable rows={report.setups.maApproaching.slice(0, 8)} /></div><div className={styles.panel}><h3>PRICE RANGE HIT</h3><Empty label="ユーザー価格レンジの永続化sourceなし" /></div></div>
    </Page>

    <Page report={report} number={10} title="UNUSUAL ACTIVITY" kicker="OUTLIER MONITOR">
      <div className={styles.quadrants}><div className={styles.panel}><h3>VOLUME SPIKE</h3><TickerList rows={report.unusual.volumeSpike} metric={(row) => row.volumeRatio == null ? 'N/A' : `${row.volumeRatio.toFixed(1)}x`} /></div><div className={styles.panel}><h3>TURNOVER SPIKE</h3><TickerList rows={report.unusual.turnoverSpike} metric={(row) => row.turnoverRatio == null ? 'N/A' : `${row.turnoverRatio.toFixed(1)}x`} /></div><div className={styles.panel}><h3>PRICE MOVE</h3><TickerList rows={report.unusual.priceMove} metric={(row) => pct(row.dailyReturn)} /></div><div className={styles.panel}><h3>TRIGGER SCORE MOVE</h3>{report.unusual.triggerScoreMove.length ? <ol className={styles.tickerList}>{report.unusual.triggerScoreMove.map((row) => <li key={row.ticker}><span><b>{row.ticker}</b><small>{row.name}</small></span><strong>{row.previousScore?.toFixed(0)}→{row.score.toFixed(0)}</strong><span className={tone(row.score - (row.previousScore ?? row.score))}>{row.score - (row.previousScore ?? row.score) >= 0 ? '+' : ''}{(row.score - (row.previousScore ?? row.score)).toFixed(0)}</span></li>)}</ol> : <Empty label="比較データなし" />}</div></div>
    </Page>

    <Page report={report} number={11} title="LARGE HOLDER & EVENTS" kicker="OWNERSHIP & CALENDAR">
      <div className={styles.twoColumns}><div className={styles.panel}><h3>LARGE HOLDER {report.events.largeHolder.status !== 'CURRENT' ? <span className={styles.delayed}><AlertTriangle size={13} /> DATA DELAYED</span> : null}</h3>{report.events.largeHolder.status === 'CURRENT' ? <ReportTable><thead><tr><th>種別</th><th>発行体 / 投資家</th><th>比率</th><th>推定時価保有額</th></tr></thead><tbody>{report.events.largeHolder.events.map((event) => <tr key={`${event.eventType}-${event.ticker}-${event.investor}-${event.obligationDate}`}><td>{event.eventType}</td><td><b>{event.ticker} {event.issuer}</b><small>{event.investor}</small></td><td>{event.holdingRatio == null ? 'N/A' : `${event.holdingRatio.toFixed(2)}%`}</td><td>{event.estimatedCurrentValue == null ? 'UNVALUED' : money.format(event.estimatedCurrentValue)}</td></tr>)}</tbody></ReportTable> : <Empty label="CURRENT certified snapshotを取得できないため通常表示を停止" />}</div><div className={styles.panel}><h3>EARNINGS / EVENTS · NEXT {Math.min(12, report.events.earnings.length)} OF {report.events.earnings.length}</h3>{report.events.earnings.length ? <ReportTable><thead><tr><th>日付</th><th>銘柄</th><th>残営業日</th><th>Trigger</th><th>Stage</th></tr></thead><tbody>{report.events.earnings.slice(0, 12).map((event) => <tr key={`${event.ticker}-${event.eventDate}`}><td>{event.eventDate}</td><td><b>{event.ticker}</b><small>{event.name}</small></td><td>{event.sessionsRemaining ?? 'N/A'}</td><td>{event.triggerStatus ?? '—'}</td><td><StageStrip stages={event.stages} /></td></tr>)}</tbody></ReportTable> : <Empty label="対象期間の決算イベントなし" />}</div></div>
      <div className={styles.disclaimer}>推定時価保有額は認定済み株数・投資口数を新鮮な未調整終値で換算した参考値であり、取得価額・投資額ではありません。所有と運用権限は法的性質が異なります。</div>
    </Page>

    <div className={styles.reportNotes}><b>DATA SOURCES</b> {report.sources.join(' · ')}<br /><b>KNOWN LIMITATIONS</b> {report.limitations.join(' ')}</div>
  </div>
}
