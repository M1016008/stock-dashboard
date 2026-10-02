import {
  LIST_LIMIT,
  MOMENTUM_STATE_LABEL,
  MOMENTUM_STATE_RULE,
  type MomentumMatrixModel,
} from '@/lib/daily-close-momentum-matrix'
import type { Page06Narrative } from '@/lib/daily-close-page06-narrative-content'
import { STATE_COLOR } from './layout'
import { MomentumMatrixChart } from './MomentumMatrixChart'
import { MomentumStateList } from './MomentumStateList'
import { HeadlineRow, NarrativePanel, narrativeSourceLabel, type Page06NarrativeSource } from './NarrativePanel'
import { PAGE06_CSS } from './styles'

// Page 06 Design Lab ページ構成 (静的描画専用。Production の DailyCloseReportView には接続しない)。
// 上段: タイトル / headline / 状態別KPI、中段: Matrix + 状態別リスト、下段: 事実・解釈・注意点 + 脚注。

export function Page06MomentumMatrix({ model, narrative, narrativeSource, generatedAt }: {
  model: MomentumMatrixModel
  narrative: Page06Narrative
  narrativeSource: Page06NarrativeSource
  generatedAt: string
}) {
  const kpis = [
    ...(['LEADER', 'EMERGING', 'FADING', 'RECOVERING'] as const).map((state) => ({
      key: state, label: MOMENTUM_STATE_LABEL[state], value: model.counts[state], color: STATE_COLOR[state], note: MOMENTUM_STATE_RULE[state],
    })),
    { key: 'NEUTRAL', label: MOMENTUM_STATE_LABEL.NEUTRAL, value: model.counts.NEUTRAL, color: STATE_COLOR.NEUTRAL, note: '上記以外' },
    { key: 'LOW', label: 'LOW SAMPLE', value: model.lowSampleCount, color: '#0b1f33', note: '内数・注目対象外' },
  ]
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Page 06 Design Lab</title>
        <style dangerouslySetInnerHTML={{ __html: PAGE06_CSS }} />
      </head>
      <body>
        <section className="page" data-page="6">
          <header className="pageHeader">
            <div>
              <span className="kicker">MOMENTUM SHIFT · 1M RANK × 1W RANK</span>
              <h1>60分類 MOMENTUM MATRIX</h1>
            </div>
            <div className="pageMeta">
              <b>STOCKBOARD DAILY CLOSE</b>
              <span>{model.reportDate}</span>
              <span className="labBadge">DESIGN LAB · 非Production</span>
            </div>
          </header>

          <HeadlineRow narrative={narrative} source={narrativeSource} />

          <div className="kpiStrip">
            {kpis.map((kpi) => (
              <div key={kpi.key} className="kpi">
                <span><i style={{ background: kpi.color }} />{kpi.label}</span>
                <b>{kpi.value}</b>
                <small>{kpi.note}</small>
              </div>
            ))}
          </div>

          <div className="body">
            <div className="matrixPanel">
              <MomentumMatrixChart model={model} />
              <p className="matrixLegend">
                <span><i className="dotSolid" />状態別（塗り）</span>
                <span><i className="dotLow" />LOW SAMPLE（破線○）</span>
                <span><i className="dotLabeled" />注目分類（名前 + Momentum Shift）</span>
              </p>
            </div>
            <MomentumStateList model={model} />
          </div>

          <NarrativePanel narrative={narrative} />

          <footer className="pageFooter">
            <p>
              Momentum Shift = 1M順位 − 1W順位（正 = 直近1Wで順位上昇）。順位は60分類の平均リターン順位で、リターンの加速度ではない。
              状態判定: 上位維持 {MOMENTUM_STATE_RULE.LEADER} / 急浮上 {MOMENTUM_STATE_RULE.EMERGING} / 高位失速 {MOMENTUM_STATE_RULE.FADING} / 下位改善 {MOMENTUM_STATE_RULE.RECOVERING}。
              LOW SAMPLE = 1Wまたは1Mの対象5銘柄未満。平均主導 = 1W平均&gt;0かつ（中央値≤0または勝率&lt;50%）。各状態の表示は上位{LIST_LIMIT}件（LOW SAMPLE除く）。
            </p>
            <div>
              <span>Narrative: {narrativeSourceLabel(narrativeSource)}</span>
              <span>DATA AS OF {model.reportDate} / GENERATED {generatedAt}</span>
              <span>06 / 11</span>
            </div>
          </footer>
        </section>
      </body>
    </html>
  )
}
