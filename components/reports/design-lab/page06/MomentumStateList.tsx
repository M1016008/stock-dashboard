import {
  MOMENTUM_STATE_LABEL,
  MOMENTUM_STATE_RULE,
  SPOTLIGHT_ORDER,
  formatPct,
  formatShift,
  formatWinRate,
  type MomentumMatrixModel,
  type MomentumPoint,
  type SpotlightState,
} from '@/lib/daily-close-momentum-matrix'
import { STATE_COLOR } from './layout'

// 右側: 状態別リスト (各状態上位 LIST_LIMIT 件、LOW SAMPLE 除く) と LOW SAMPLE 一覧。
// 列: 分類 / 1M→1W / Shift / 1W平均 / 中央値 / 勝率。列幅は layout.ts の LIST_COLUMNS_MM。

function Flags({ point }: { point: MomentumPoint }) {
  return (
    <>
      {point.lowSample ? <span className="flag flagLow">LOW SAMPLE</span> : null}
      {point.meanDriven ? <span className="flag flagMean">平均主導</span> : null}
    </>
  )
}

function StateBlock({ model, state }: { model: MomentumMatrixModel; state: SpotlightState }) {
  const rows = model.lists[state]
  const others = model.counts[state] - rows.length
  return (
    <section className="stateBlock">
      <header>
        <i style={{ background: STATE_COLOR[state] }} />
        <b>{MOMENTUM_STATE_LABEL[state]}</b>
        <span>{model.counts[state]}分類</span>
        <small>{MOMENTUM_STATE_RULE[state]}</small>
      </header>
      {rows.length ? (
        <table>
          <tbody>
            {rows.map((point) => (
              <tr key={point.name}>
                <td className="nameCell"><b>{point.name}</b><Flags point={point} /></td>
                <td className="rankCell">#{point.rank1M}<em>→</em>#{point.rank1W}</td>
                <td className="shiftCell" style={{ color: STATE_COLOR[state] }}>{formatShift(point.momentumShift)}</td>
                <td className="meanCell">{formatPct(point.oneWeek.mean)}</td>
                <td className="medianCell">{formatPct(point.oneWeek.median)}</td>
                <td className="winCell">{formatWinRate(point.oneWeek.winRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="emptyRow">該当なし（LOW SAMPLE除く）</p>}
      {others > 0 ? <p className="moreRow">ほか{others}分類（LOW SAMPLE含む）</p> : null}
    </section>
  )
}

export function MomentumStateList({ model }: { model: MomentumMatrixModel }) {
  return (
    <aside className="listPanel">
      <div className="listHead">
        <span>分類</span><span>1M→1W</span><span>Shift</span><span>1W平均</span><span>中央値</span><span>勝率</span>
      </div>
      {SPOTLIGHT_ORDER.map((state) => <StateBlock key={state} model={model} state={state} />)}
      <section className="lowSampleBlock">
        <b>LOW SAMPLE {model.lowSampleCount}分類（Matrix上は破線○・注目対象外）</b>
        <span>{model.lowSampleNames.length ? model.lowSampleNames.join('・') : 'なし'}</span>
      </section>
    </aside>
  )
}
