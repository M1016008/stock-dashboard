import type { ReactNode } from 'react'
import {
  AlertTriangle, Archive, Bell, Bookmark, CalendarDays, ChevronLeft, ChevronRight, Copy, LoaderCircle,
  RefreshCw, Save, Search, SearchX, SlidersHorizontal, Star, X,
} from 'lucide-react'
import {
  LAB_CRITERIA_CHIPS, LAB_DEFAULT_CHIPS, LAB_MARKETS, LAB_META, LAB_SAVED_TRIGGERS, STAGE_AXES, STATUS_LABEL,
  buildLabRows, formatAmount, formatPercent,
  type LabRow, type LabState, type LabStatus,
} from './fixtures'
import { TDL_CSS } from './styles'

export interface TriggerDiscoveryCurrentLabProps {
  state: LabState
  /** 詳細条件ドロワー(デスクトップ=右ドロワー / iPad・Mobile=ボトムシート)を開いた状態で描画する。未指定は initial のみ開く */
  drawerOpen?: boolean
  /** Mobileで条件バーを展開した状態で描画する。未指定は initial / error のみ展開 */
  barOpen?: boolean
}

const ROWS = buildLabRows(100)

function Spark({ row }: { row: LabRow }) {
  const w = 112
  const h = 28
  const all = [...row.chart.close, ...row.chart.ma1, ...row.chart.ma2]
  const min = Math.min(...all)
  const max = Math.max(...all)
  const x = (i: number) => (i / (row.chart.close.length - 1)) * (w - 2) + 1
  const y = (v: number) => h - 2 - ((v - min) / (max - min || 1)) * (h - 4)
  const path = (values: number[]) => values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  return (
    <svg className="tdl-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${row.ticker} 終値とMA1・MA2の推移`}>
      <path d={path(row.chart.ma2)} fill="none" stroke="#e08a1e" strokeWidth="1.2" />
      <path d={path(row.chart.ma1)} fill="none" stroke="#2f8f6b" strokeWidth="1.2" />
      <path d={path(row.chart.close)} fill="none" stroke="#1d4f91" strokeWidth="1.5" />
    </svg>
  )
}

function Stages({ stages }: { stages: Array<number | null> }) {
  return (
    <span className="tdl-stages" role="group" aria-label={stages.map((s, i) => `${STAGE_AXES[i]} ${s ?? '不明'}`).join(' ')}>
      {stages.map((s, i) => <span key={i} className={`tdl-sg s${s ?? 0}`} title={`${STAGE_AXES[i]}: ${s ?? 'Unknown'}`}>{s ?? '—'}</span>)}
    </span>
  )
}

function StatusBadge({ status }: { status: LabStatus }) {
  return <span className={`tdl-st ${status}`}>{STATUS_LABEL[status]}</span>
}

function scoreTitle(row: LabRow): string {
  const b = row.breakdown
  return `Trigger条件への適合度 ${row.score}/100｜近さ ${b.proximity}/30 接近 ${b.approach}/25 MA上向き ${b.maTrend}/25 Stage構造 ${b.stageStructure}/20 流動性 ${b.liquidity}/10`
}

function Field({ id, label, value, suffix, type = 'text', cls = '', extra, error }: {
  id: string; label: string; value: string; suffix?: string; type?: 'text' | 'number' | 'date'; cls?: string; extra?: ReactNode; error?: boolean
}) {
  return (
    <div className={`tdl-field ${cls}`}>
      <div className="tdl-lab"><label htmlFor={id}>{label}</label>{extra}</div>
      <div className={`tdl-input${error ? ' err' : ''}`}>
        <input id={id} type={type} defaultValue={value} inputMode={type === 'number' ? 'numeric' : undefined} />
        {suffix && <span className="tdl-suf">{suffix}</span>}
      </div>
    </div>
  )
}

function Header() {
  return (
    <header className="tdl-head">
      <div>
        <div className="tdl-eyebrow">Trigger Discovery</div>
        <h1 className="tdl-title">条件トリガー</h1>
      </div>
      <nav className="tdl-modes" aria-label="Trigger Discoveryの検索モード">
        <button type="button" className="tdl-mode" aria-current="page">現在・単日時点</button>
        <button type="button" className="tdl-mode" disabled title="このDesign Labの対象外です">期間検証</button>
      </nav>
      <span className="tdl-latest"><CalendarDays size={14} aria-hidden /> 最新データ <b>{LAB_META.latestAsOf}</b></span>
    </header>
  )
}

function SavedBar({ state }: { state: LabState }) {
  const hasActive = state !== 'initial'
  return (
    <section className="tdl-saved" aria-label="保存済みTrigger">
      <span className="tdl-saved-label"><Bookmark size={15} aria-hidden /> 保存済みTrigger</span>
      <select className="tdl-select" aria-label="保存済みTrigger" defaultValue={hasActive ? 's1' : ''}>
        <option value="">選択してください</option>
        {LAB_SAVED_TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.name}｜{t.timeframe}</option>)}
      </select>
      <button type="button" className="tdl-btn">読み込む</button>
      {hasActive && (
        <span className="tdl-active">
          <span className="tdl-active-name">編集中: <b>押し目 20/25 月足</b></span>
          <span className="tdl-tag">月足</span>
          <span className="tdl-tag warn">変更あり</span>
        </span>
      )}
      <div className="tdl-saved-actions">
        {hasActive && <button type="button" className="tdl-btn tdl-hide-m" aria-label="変更を保存"><Save size={15} aria-hidden /><span>保存</span></button>}
        <button type="button" className="tdl-btn tdl-hide-m" aria-label="別名で保存"><Copy size={15} aria-hidden /><span>別名で保存</span></button>
        {hasActive && <button type="button" className="tdl-btn tdl-hide-m" aria-label="通知設定"><Bell size={15} aria-hidden /><span>通知</span></button>}
        {hasActive && <button type="button" className="tdl-btn tdl-icon" aria-label="保存済みTriggerをアーカイブ"><Archive size={16} aria-hidden /></button>}
      </div>
    </section>
  )
}

function ConditionBar({ state }: { state: LabState }) {
  const loading = state === 'loading'
  const isInitial = state === 'initial'
  const asOf = isInitial ? LAB_META.latestAsOf : LAB_META.requestedAsOf
  return (
    <section aria-label="Trigger条件" aria-busy={loading}>
      <div className="tdl-bar" role="group">
        <Field id="tdl-asof" label="基準日" value={asOf} type="date" cls="tdl-f-asof tdl-wide"
          extra={isInitial ? null : <a href="#latest" aria-label={`基準日を最新利用可能日${LAB_META.latestAsOf}へ戻す`}>最新へ</a>} />
        <div className="tdl-field tdl-f-tf">
          <div className="tdl-lab"><label htmlFor="tdl-tf">足種</label></div>
          <select id="tdl-tf" className="tdl-select" defaultValue="MONTHLY" aria-label="Triggerの足種"><option value="MONTHLY">月足</option><option value="BIWEEKLY">2週足</option></select>
        </div>
        <Field id="tdl-ma1" label="MA 1" value="20" suffix="か月" type="number" cls="tdl-f-ma1" />
        <Field id="tdl-ma2" label="MA 2" value="25" suffix="か月" type="number" cls="tdl-f-ma2" />
        <Field id="tdl-dist" label="Trigger距離" value="5" suffix="%以内" type="number" cls="tdl-f-dist" />
        <label htmlFor="tdl-drawer" className="tdl-btn tdl-f-detail" role="button" tabIndex={0} aria-label="詳細条件を開く">
          <SlidersHorizontal size={16} aria-hidden /> 詳細条件 <span className="tdl-badge">{isInitial ? 0 : 4}</span>
        </label>
        <button type="button" className="tdl-btn tdl-primary tdl-search tdl-f-go" disabled={loading} aria-label={loading ? '検索中' : 'Triggerを検索'}>
          {loading ? <LoaderCircle size={17} className="tdl-spin" aria-hidden /> : <Search size={17} aria-hidden />}
          {loading ? '検索中…' : 'Triggerを検索'}
        </button>
      </div>
      <p className="tdl-note">入力を変更しただけでは検索されません。基準日は保存されず、休日は直近の取引日に解決されます。</p>
    </section>
  )
}

function CompactLine({ state }: { state: LabState }) {
  const isInitial = state === 'initial'
  return (
    <div className="tdl-compact">
      <div className="tdl-compact-t">
        <div><b>{isInitial ? '保存済みTrigger未選択' : '押し目 20/25 月足'}</b>{!isInitial && <> <span className="tdl-tag warn">変更あり</span></>}</div>
        <div>基準日 {isInitial ? LAB_META.latestAsOf : LAB_META.requestedAsOf} ・ 月足 20/25 ・ 距離5%</div>
      </div>
      <label htmlFor="tdl-bar" className="tdl-btn" role="button" tabIndex={0}><SlidersHorizontal size={16} aria-hidden /> 条件を変更</label>
    </div>
  )
}

function Chips({ label = '適用条件', chips = LAB_CRITERIA_CHIPS }: { label?: string; chips?: Array<{ label: string; fixed?: boolean }> }) {
  return (
    <div className="tdl-chips" aria-label={label}>
      <span className="tdl-chips-label">{label}</span>
      {chips.map((chip) => chip.fixed
        ? <span key={chip.label} className="tdl-chip fixed" title="固定条件（変更不可）">{chip.label}</span>
        : <label key={chip.label} htmlFor="tdl-drawer" className="tdl-chip" role="button" tabIndex={0} title="詳細条件を開いて変更">{chip.label}</label>)}
    </div>
  )
}

function Funnel() {
  const m = LAB_META
  const n = (v: number) => v.toLocaleString('ja-JP')
  return (
    <>
      <div className="tdl-funnel" aria-label="評価内訳">
        <span>PIT Universe <b>{n(m.pitUniverseCount)}</b></span><span className="arrow">→</span>
        <span>Current Price <b>{n(m.currentPriceCount)}</b></span>
        <span className="stale">Stale accepted <b>+{n(m.staleAcceptedCount)}</b></span><span className="arrow">→</span>
        <span>Trigger evaluated <b>{n(m.triggerEvaluatedCount)}</b></span><span className="arrow">→</span>
        <span>Trigger matched <b>{n(m.triggerMatchedCount)}</b></span><span className="arrow">→</span>
        <span>Stage filter後 <b>{n(m.matchedCount)}</b></span>
        <span>表示 <b>{n(m.returnedCount)}</b></span>
      </div>
      <details className="tdl-funnel-d">
        <summary>評価内訳</summary>
        <p><span>PIT Universe {n(m.pitUniverseCount)}</span><span>Current Price {n(m.currentPriceCount)}</span><span>Stale accepted {n(m.staleAcceptedCount)}</span><span>Trigger evaluated {n(m.triggerEvaluatedCount)}</span><span>Trigger matched {n(m.triggerMatchedCount)}</span><span>Stage filter後 {n(m.matchedCount)}</span><span>Returned {n(m.returnedCount)}</span></p>
        <p>Trigger Scoreは条件への適合度です。</p>
      </details>
    </>
  )
}

function Resolve() {
  return (
    <span className="tdl-resolve" title="休日は直近の取引日に解決されます">
      指定日 <b>{LAB_META.requestedAsOfLabel}</b> → 評価日 <b>{LAB_META.resolvedAsOfLabel}</b>
    </span>
  )
}

function Summary({ state }: { state: LabState }) {
  const m = LAB_META
  if (state === 'results') {
    return (
      <section className="tdl-sum" aria-labelledby="tdl-res" data-compact-summary>
        <div className="tdl-sum-row">
          <h2 id="tdl-res" className="tdl-count" style={{ margin: 0 }}><span>候補</span><b>{m.matchedCount}</b><span>件</span></h2>
          <span className="tdl-kv"><i>評価日</i><b>{m.resolvedAsOf}</b></span>
          <span className="tdl-kv"><i>足種</i><b>{m.timeframe}</b></span>
          <span className="tdl-kv"><i>MA</i><b>{m.ma1}/{m.ma2}</b></span>
          <Resolve />
        </div>
        <Chips />
        <Funnel />
      </section>
    )
  }
  if (state === 'empty') {
    return (
      <section className="tdl-sum" aria-labelledby="tdl-res" data-compact-summary>
        <div className="tdl-sum-row">
          <h2 id="tdl-res" className="tdl-count" style={{ margin: 0 }}><span>候補</span><b>0</b><span>件</span></h2>
          <span className="tdl-kv"><i>評価日</i><b>{m.resolvedAsOf}</b></span>
          <span className="tdl-kv"><i>足種</i><b>{m.timeframe}</b></span>
          <span className="tdl-kv"><i>MA</i><b>{m.ma1}/{m.ma2}</b></span>
          <Resolve />
        </div>
        <Chips />
      </section>
    )
  }
  if (state === 'loading') {
    return (
      <section className="tdl-sum" aria-label="検索中の条件">
        <div className="tdl-sum-row">
          <h2 className="tdl-count" style={{ margin: 0 }}><span>候補</span><b style={{ color: 'var(--tx3)' }}>—</b><span>件</span></h2>
          <span className="tdl-kv"><i>基準日</i><b>{m.requestedAsOf}</b></span>
          <span className="tdl-kv"><i>足種</i><b>{m.timeframe}</b></span>
          <span className="tdl-kv"><i>MA</i><b>{m.ma1}/{m.ma2}</b></span>
        </div>
        <Chips label="検索条件" />
      </section>
    )
  }
  return (
    <section className="tdl-sum" aria-label="検索条件">
      <Chips label={state === 'error' ? '直前の条件' : '検索条件'} chips={state === 'initial' ? LAB_DEFAULT_CHIPS : LAB_CRITERIA_CHIPS} />
    </section>
  )
}

function SortHead({ label, pressed, right, dir }: { label: string; pressed?: boolean; right?: boolean; dir?: 'asc' | 'desc' }) {
  return (
    <button type="button" className="tdl-sortbtn" aria-pressed={pressed ? 'true' : 'false'} aria-label={`${label}で並べ替え${pressed ? `（現在${dir === 'asc' ? '昇順' : '降順'}）` : ''}`} style={right ? { flexDirection: 'row' } : undefined}>
      {label}<span className="ar" aria-hidden>{pressed ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </button>
  )
}

const KEY_JS = "document.addEventListener('keydown',function(e){var t=e.target;if(!t||t.tagName!=='LABEL'||t.getAttribute('role')!=='button')return;if(e.key==='Enter'||e.key===' '){e.preventDefault();t.click()}})"

function Toolbar({ disabled, withResults }: { disabled?: boolean; withResults?: boolean }) {
  const c = LAB_META.statusCounts
  const items: Array<[string, string, number]> = [['', 'すべて', c.ALL], ['APPROACHING', '接近中', c.APPROACHING], ['NEAR', '近接', c.NEAR], ['IN_ZONE', 'ゾーン内', c.IN_ZONE], ['BELOW_ZONE', '下方', c.BELOW_ZONE]]
  return (
    <div className="tdl-tools" role="toolbar" aria-label="結果フィルター">
      <div className="tdl-seg" role="group" aria-label="Status表示フィルター">
        {items.map(([key, label, count], i) => (
          <button key={key || 'all'} type="button" aria-pressed={i === 0 ? 'true' : 'false'} disabled={disabled} title={key || 'ALL'}>{label}{withResults && <small>{count}</small>}</button>
        ))}
      </div>
      <details className="tdl-pop">
        <summary className="tdl-btn" aria-label="Stageで絞り込む"><SlidersHorizontal size={15} aria-hidden /> Stage <span className="tdl-badge">2</span></summary>
        <div className="tdl-pop-body"><StageAxes /></div>
      </details>
      <label className="tdl-sort"><span className="tdl-sr">並べ替え</span>
        <select className="tdl-select" aria-label="並べ替え" defaultValue="triggerScore:desc" disabled={disabled}>
          <option value="triggerScore:desc">Score 高い順</option><option value="zoneDistance:asc">Zone距離 近い順</option><option value="averageTradingValue:desc">売買代金 大きい順</option><option value="ticker:asc">銘柄コード順</option>
        </select>
      </label>
      {withResults && <span className="tdl-hint" aria-hidden>↔ 表は横にスクロール</span>}
      <span className="tdl-sp" style={{ color: 'var(--tx3)', fontSize: 12 }}>Score 高い順</span>
    </div>
  )
}

function StageAxes({ none }: { none?: boolean }) {
  const selected: Record<number, number[]> = none ? {} : { 0: [3, 4], 2: [4, 5] }
  return (
    <div className="tdl-axes" role="group" aria-label="Stage絞り込み">
      {STAGE_AXES.map((axis, a) => (
        <div key={axis} className="tdl-axis">
          <span>{axis}</span>
          {[1, 2, 3, 4, 5, 6, 0].map((v) => <button key={v} type="button" aria-pressed={selected[a]?.includes(v) ? 'true' : 'false'} aria-label={`${axis} ${v === 0 ? 'Unknown' : `Stage ${v}`}`}>{v === 0 ? '—' : v}</button>)}
        </div>
      ))}
    </div>
  )
}

function Footer({ disabled }: { disabled?: boolean }) {
  const m = LAB_META
  return (
    <div className="tdl-foot">
      <span>{disabled ? '検索中…' : `${m.matchedCount}件中 1–${m.returnedCount}件`}</span>
      <label className="tdl-sp">表示 <select className="tdl-select" defaultValue="100" aria-label="表示件数" disabled={disabled}>{[25, 50, 100].map((n) => <option key={n} value={n}>{n}件</option>)}</select></label>
      <span className="tdl-pager">
        <button type="button" className="tdl-btn tdl-icon" disabled aria-label="前のページ"><ChevronLeft size={17} /></button>
        <span>1 / {m.totalPages}</span>
        <button type="button" className="tdl-btn tdl-icon" disabled={disabled} aria-label="次のページ"><ChevronRight size={17} /></button>
      </span>
    </div>
  )
}

function ResultTable() {
  return (
    <div className="tdl-scroll" tabIndex={0} aria-label="Trigger候補一覧" data-results-scroll>
      <table className="tdl-table" data-trigger-results-table>
        <thead>
          <tr>
            <th className="stk" style={{ width: 168, minWidth: 168 }} aria-sort="none"><SortHead label="銘柄" /></th>
            <th style={{ width: 96 }} aria-sort="none"><SortHead label="Status" /></th>
            <th className="r" style={{ width: 76 }} aria-sort="descending"><SortHead label="Score" pressed dir="desc" /></th>
            <th className="r" style={{ width: 92 }} aria-sort="none"><SortHead label="Zone距離" /></th>
            <th className="r" style={{ width: 82 }} aria-sort="none"><SortHead label="株価" /></th>
            <th className="r" style={{ width: 84 }} aria-sort="none"><SortHead label={`${LAB_META.ma1}M距離`} /></th>
            <th className="r" style={{ width: 84 }} aria-sort="none"><SortHead label={`${LAB_META.ma2}M距離`} /></th>
            <th className="gs" style={{ width: 128 }}>Mini Chart</th>
            <th style={{ width: 96 }}>市場</th>
            <th className="r gs" style={{ width: 112 }} aria-sort="none"><SortHead label="平均売買代金" /></th>
            <th className="r" style={{ width: 104 }} aria-sort="none"><SortHead label="平均出来高" /></th>
            <th className="gs" style={{ width: 188 }} aria-label="6 Stage（日A 日B 週A 週B 月A 月B）"><span className="tdl-stages hd" aria-hidden>{STAGE_AXES.map((a) => <span key={a}>{a}</span>)}</span></th>
            <th className="c gs" style={{ width: 52 }}><span className="tdl-sr">ウォッチ</span><Star size={14} aria-hidden /></th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.ticker} data-row>
              <td className="stk">
                <a className="tdl-stock" href={`#stock-${row.ticker}`}>
                  <b>{row.ticker}</b>
                  <span title={row.companyName}>{row.companyName}</span>
                </a>
              </td>
              <td><StatusBadge status={row.status} />{row.stale && <div><span className="tdl-stale" data-stale>STALE_ACCEPTED</span></div>}</td>
              <td className="r"><button type="button" className="tdl-score" aria-label={scoreTitle(row)} title={scoreTitle(row)}><b>{row.score}</b><i><s style={{ width: `${row.score}%` }} /></i></button></td>
              <td className={`r tdl-zone ${row.zoneDistancePct < 0 ? 'tdl-neg' : 'tdl-pos'}`}>{formatPercent(row.zoneDistancePct)}</td>
              <td className="r">{row.price.toLocaleString('ja-JP')}{row.stale && <div><span className="tdl-stale">{row.stale.priceDate}（{row.stale.sessions}営業日前）</span></div>}</td>
              <td className="r tdl-mute">{formatPercent(row.ma1DistancePct)}</td>
              <td className="r tdl-mute">{formatPercent(row.ma2DistancePct)}</td>
              <td className="gs"><Spark row={row} /></td>
              <td><span className="tdl-mkt">{row.market}</span></td>
              <td className="r tdl-mute gs">{formatAmount(row.averageTradingValue)}</td>
              <td className="r tdl-mute">{row.averageVolume.toLocaleString('ja-JP')}</td>
              <td className="gs"><Stages stages={row.stages} /></td>
              <td className="c gs"><button type="button" className={`tdl-star${row.watched ? ' on' : ''}`} aria-pressed={row.watched ? 'true' : 'false'} aria-label={`${row.ticker}をウォッチリスト${row.watched ? 'から外す' : 'に追加'}`}><Star size={17} fill={row.watched ? 'currentColor' : 'none'} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tdl-cards" data-result-cards>
        {ROWS.map((row) => (
          <article key={row.ticker} className="tdl-card">
            <div className="tdl-card-h">
              <a className="tdl-stock" href={`#stock-${row.ticker}`}><b>{row.ticker}</b><span>{row.companyName}</span></a>
              <StatusBadge status={row.status} />
              <button type="button" className={`tdl-star${row.watched ? ' on' : ''}`} aria-label={`${row.ticker}をウォッチリストに追加`}><Star size={18} fill={row.watched ? 'currentColor' : 'none'} /></button>
            </div>
            <div className="tdl-card-s">
              <div><i>Score</i><b>{row.score}</b></div>
              <div><i>Zone</i><b className={row.zoneDistancePct < 0 ? 'tdl-neg' : ''}>{formatPercent(row.zoneDistancePct)}</b></div>
              <div><i>株価</i><b>{row.price.toLocaleString('ja-JP')}</b></div>
              <div><i>{LAB_META.ma1}M</i><b className="tdl-mute">{formatPercent(row.ma1DistancePct)}</b></div>
              <div><i>{LAB_META.ma2}M</i><b className="tdl-mute">{formatPercent(row.ma2DistancePct)}</b></div>
            </div>
            <div className="tdl-card-f"><Stages stages={row.stages} /><Spark row={row} /></div>
            {row.stale && <span className="tdl-stale">STALE_ACCEPTED 価格 {row.stale.priceDate}（{row.stale.sessions}営業日前）</span>}
          </article>
        ))}
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="tdl-scroll" aria-hidden data-skeleton>
      {Array.from({ length: 14 }, (_, i) => <div key={i} className="tdl-skel">{Array.from({ length: 8 }, (_, k) => <s key={k} style={{ width: `${55 + ((i * 7 + k * 13) % 40)}%` }} />)}</div>)}
    </div>
  )
}

function InitialPanel() {
  return (
    <div className="tdl-state" data-state-panel="initial">
      <div className="tdl-panel">
        <div className="tdl-ico"><Search size={22} aria-hidden /></div>
        <div>
          <h2>条件を確認して検索を実行します</h2>
          <p>上向きの移動平均へ上から接近する銘柄を、基準日時点のデータだけで探索します。入力を変更しただけでは検索されません。</p>
        </div>
        <ol className="tdl-steps">
          <li><b>① 基準日・足種・MA</b>上部バーで指定。休日は直近の取引日に解決されます。</li>
          <li><b>② Universeを絞る</b>市場・株価・売買代金は「詳細条件」で指定します。</li>
          <li><b>③ Triggerを検索</b>最大100件を1画面で比較できます。</li>
        </ol>
        <div>
          <h3 className="tdl-h3">保存済みTriggerから始める</h3>
          <ul className="tdl-quick" style={{ marginTop: 8 }}>
            {LAB_SAVED_TRIGGERS.map((t) => (
              <li key={t.id}><Bookmark size={16} aria-hidden /><div><b>{t.name}</b><span>{t.timeframe} ・ {t.note}</span></div><button type="button" className="tdl-btn">読み込む</button></li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function EmptyPanel() {
  const m = LAB_META
  const rows: Array<[string, number, string]> = [
    ['PIT Universe', m.pitUniverseCount, ''], ['価格あり', m.currentPriceCount + m.staleAcceptedCount, '（うちStale accepted 63）'],
    ['Trigger evaluated', m.triggerEvaluatedCount, ''], ['Trigger matched', 31, ''], ['Stage filter後', 0, ''],
  ]
  return (
    <div className="tdl-state" data-state-panel="empty">
      <div className="tdl-panel">
        <div className="tdl-ico warn"><SearchX size={22} aria-hidden /></div>
        <div>
          <h2>この条件に一致するTrigger候補はありません</h2>
          <p>Trigger条件には31件が一致しましたが、Stage条件（日A・週A）で0件になりました。</p>
        </div>
        <div className="tdl-drop" aria-label="評価内訳">
          {rows.map(([label, value, note]) => (
            <div key={label} className="tdl-drop-row"><span title={note || undefined}>{label}{note ? ' *' : ''}</span><i><s style={{ width: `${Math.max(1, (value / m.pitUniverseCount) * 100)}%` }} /></i><b>{value.toLocaleString('ja-JP')}</b></div>
          ))}
        </div>
        <p style={{ fontSize: 12, marginTop: -8 }}>* 価格あり = Current Price 3,811 + Stale accepted 63（STALE_ACCEPTED）</p>
        <div>
          <h3 className="tdl-h3">条件をゆるめる</h3>
          <ul className="tdl-suggest" style={{ marginTop: 8 }}>
            <li><div><b>Stage条件を解除</b>　31件が表示されます</div><button type="button" className="tdl-btn">解除して再検索</button></li>
            <li><div><b>Trigger距離を 5% → 8%</b>　に広げる</div><label htmlFor="tdl-drawer" className="tdl-btn" role="button" tabIndex={0}>条件を編集</label></li>
          </ul>
        </div>
      </div>
    </div>
  )
}

function ErrorPanel() {
  return (
    <div className="tdl-state" data-state-panel="error">
      <div className="tdl-panel">
        <div role="alert" className="tdl-alert">
          <AlertTriangle size={22} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
          <div>
            <b>検索に失敗しました</b>
            <p>サーバーの応答がタイムアウトしました。入力した条件は保持されています。</p>
            <p style={{ marginTop: 4 }}><code>HTTP 504 ・ trigger-discovery-search-v1 ・ 12.0秒</code></p>
          </div>
        </div>
        <div className="tdl-actions">
          <button type="button" className="tdl-btn tdl-primary"><RefreshCw size={16} aria-hidden /> もう一度検索</button>
          <label htmlFor="tdl-drawer" className="tdl-btn" role="button" tabIndex={0}><SlidersHorizontal size={16} aria-hidden /> 条件を確認</label>
        </div>
        <p style={{ fontSize: 13 }}>改善しない場合は、市場やStage条件で対象を絞るか、時間をおいて再実行してください。入力値の誤りは該当する項目の下に表示されます。</p>
      </div>
    </div>
  )
}

function Drawer({ state }: { state: LabState }) {
  const d = state === 'initial' // 初期状態は既定値(絞り込みなし)
  return (
    <aside className="tdl-drawer" aria-label="詳細条件" role="dialog">
      <span className="tdl-grab" aria-hidden />
      <div className="tdl-dh">
        <SlidersHorizontal size={18} aria-hidden /><h2>詳細条件</h2>
        <label htmlFor="tdl-drawer" className="tdl-btn tdl-icon" role="button" tabIndex={0} aria-label="閉じる"><X size={18} aria-hidden /></label>
      </div>
      <div className="tdl-db">
        <section className="tdl-sec">
          <h3>Trigger詳細 <small>MA方向・接近方向は固定</small></h3>
          <div className="tdl-g2">
            <Field id="tdl-near" label="Near距離" value="2" suffix="%以内" type="number" />
            <Field id="tdl-below" label="最大下抜け幅" value="3" suffix="%" type="number" />
          </div>
          <label className="tdl-sw"><input type="checkbox" defaultChecked={!d} /><div><b>Zone下抜けも候補に含める</b><span>Zone下限を少し下回った銘柄（BELOW_ZONE）も表示します。</span></div></label>
          <label className="tdl-sw"><input type="checkbox" /><div><b>MA間隔拡大</b><span>既定OFF・Trigger Scoreへの加点なし。ONで比較区間数と最低拡大区間比率を指定。</span></div></label>
        </section>
        <section className="tdl-sec">
          <h3>Universe <small>市場は未選択ですべて</small></h3>
          <div className="tdl-mk">
            {LAB_MARKETS.map((mk) => <label key={mk.label} className={mk.selected && !d ? 'on' : ''}><input type="checkbox" defaultChecked={mk.selected && !d} />{mk.label}<small>{mk.count.toLocaleString('ja-JP')}</small></label>)}
          </div>
          <div className="tdl-g2">
            <Field id="tdl-pmin" label="株価 下限" value="" suffix="円" />
            <Field id="tdl-pmax" label="株価 上限" value="" suffix="円" />
            <Field id="tdl-tmin" label="平均売買代金 下限" value={d ? '' : '100,000,000'} suffix="円" />
            <Field id="tdl-tmax" label="平均売買代金 上限" value="" suffix="円" />
            <Field id="tdl-vmin" label="平均出来高 下限" value="" suffix="株" />
            <Field id="tdl-vmax" label="平均出来高 上限" value="" suffix="株" />
          </div>
          <div className="tdl-g2"><Field id="tdl-liq" label="平均期間" value="20" suffix="営業日" type="number" /></div>
        </section>
        <section className="tdl-sec">
          <h3>Stage <small>日A・日B・週A・週B・月A・月B</small></h3>
          <StageAxes none={d} />
          <button type="button" className="tdl-btn tdl-ghost" style={{ justifySelf: 'start' }}>選択をクリア</button>
        </section>
      </div>
      <div className="tdl-df">
        <button type="button" className="tdl-btn"><Bookmark size={15} aria-hidden /> 条件を保存</button>
        <label htmlFor="tdl-drawer" className="tdl-btn tdl-primary" role="button" tabIndex={0}><Search size={16} aria-hidden /> 適用して検索</label>
      </div>
      {state === 'initial' && <span className="tdl-sr">初期状態</span>}
    </aside>
  )
}

export function TriggerDiscoveryCurrentLab({ state, drawerOpen, barOpen }: TriggerDiscoveryCurrentLabProps) {
  const openDrawer = drawerOpen ?? false
  const openBar = barOpen ?? (state === 'initial' || state === 'error')
  const hasTable = state === 'results'
  return (
    <div className="tdl" data-lab-state={state} data-design-lab="trigger-discovery-current">
      <style dangerouslySetInnerHTML={{ __html: TDL_CSS }} />
      <script dangerouslySetInnerHTML={{ __html: KEY_JS }} />
      <input id="tdl-drawer" className="tdl-toggle" type="checkbox" tabIndex={-1} aria-hidden="true" defaultChecked={openDrawer} />
      <input id="tdl-bar" className="tdl-toggle" type="checkbox" tabIndex={-1} aria-hidden="true" defaultChecked={openBar} />
      <div className="tdl-top">
        <Header />
        <CompactLine state={state} />
        <SavedBar state={state} />
        <ConditionBar state={state} />
      </div>
      <main className="tdl-main" aria-busy={state === 'loading'}>
        <Summary state={state} />
        {state === 'loading' && <div className="tdl-loadline" role="status"><LoaderCircle size={17} className="tdl-spin" aria-hidden /> 基準日 {LAB_META.requestedAsOf} の評価日を解決し、{LAB_META.pitUniverseCount.toLocaleString('ja-JP')}銘柄を評価しています…</div>}
        {(state === 'results' || state === 'loading' || state === 'empty') && <Toolbar disabled={state !== 'results'} withResults={state === 'results'} />}
        {state === 'initial' && <InitialPanel />}
        {hasTable && <ResultTable />}
        {state === 'loading' && <Skeleton />}
        {state === 'empty' && <EmptyPanel />}
        {state === 'error' && <ErrorPanel />}
        {(hasTable || state === 'loading') && <Footer disabled={state === 'loading'} />}
      </main>
      <label htmlFor="tdl-drawer" className="tdl-scrim" aria-hidden />
      <Drawer state={state} />
    </div>
  )
}
