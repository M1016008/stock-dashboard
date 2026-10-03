import { BODY, COLORS, FONT_FAMILY, FONT_PT, LIST_COLUMNS_MM, MATRIX_FONT, PAGE } from './layout'

// Page 06 Design Lab の CSS。数値は layout.ts の定数から生成する。

const listColumns = `1fr ${LIST_COLUMNS_MM.rank}mm ${LIST_COLUMNS_MM.shift}mm ${LIST_COLUMNS_MM.mean}mm ${LIST_COLUMNS_MM.median}mm ${LIST_COLUMNS_MM.winRate}mm`

export const PAGE06_CSS = `
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: ${COLORS.screenBg}; color: ${COLORS.ink}; }
body { font-family: ${FONT_FAMILY}; font-variant-numeric: tabular-nums; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: ${PAGE.widthMm}mm; height: ${PAGE.heightMm}mm; margin: 0 auto; background: #fff; padding: ${PAGE.paddingTopMm}mm ${PAGE.paddingXMm}mm ${PAGE.paddingBottomMm}mm; display: grid; grid-template-rows: auto auto auto 1fr auto auto; gap: ${PAGE.rowGapMm}mm; overflow: hidden; }
@media screen and (min-width: ${PAGE.viewportWidthPx + 40}px) { .page { margin: 8mm auto; box-shadow: 0 2px 14px rgba(11,31,51,.18); } }
.pageHeader { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid ${COLORS.ink}; padding-bottom: 1.6mm; }
.kicker { display: block; font-size: ${FONT_PT.kicker}pt; letter-spacing: .12em; color: ${COLORS.accent}; font-weight: 700; }
h1 { margin: .4mm 0 0; font-size: ${FONT_PT.title}pt; letter-spacing: .02em; }
.pageMeta { display: flex; flex-direction: column; align-items: flex-end; font-size: ${FONT_PT.meta}pt; color: ${COLORS.muted}; gap: .4mm; }
.pageMeta b { color: ${COLORS.ink}; letter-spacing: .08em; }
.labBadge { border: 1px solid ${COLORS.labBadge}; color: ${COLORS.labBadge}; padding: 0 1.4mm; border-radius: 1mm; font-weight: 700; }
.headlineRow { display: flex; align-items: center; gap: 3mm; }
.headlineRow strong { font-size: ${FONT_PT.headline}pt; line-height: 1.25; }
.sourceBadge { font-size: ${FONT_PT.sourceBadge}pt; letter-spacing: .1em; color: ${COLORS.muted}; border: 1px solid ${COLORS.line}; padding: .3mm 1.4mm; border-radius: 1mm; white-space: nowrap; }
.kpiStrip { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2mm; }
.kpi { border: 1px solid ${COLORS.line}; border-radius: 1.2mm; padding: 1.2mm 2mm; display: grid; grid-template-columns: 1fr auto; align-items: baseline; }
.kpi span { font-size: ${FONT_PT.kpiLabel}pt; font-weight: 700; display: flex; align-items: center; gap: 1.2mm; }
.kpi span i { width: 2.4mm; height: 2.4mm; border-radius: 50%; display: inline-block; }
.kpi b { font-size: ${FONT_PT.kpiValue}pt; grid-row: span 2; align-self: center; }
.kpi small { font-size: ${FONT_PT.kpiNote}pt; color: ${COLORS.muted}; }
.body { display: grid; grid-template-columns: ${BODY.matrixFr}fr ${BODY.listFr}fr; gap: ${BODY.columnGapMm}mm; min-height: 0; }
.matrixPanel { min-height: 0; display: flex; flex-direction: column; }
.matrix { width: 100%; height: auto; max-height: 100%; display: block; }
.plotFrame { fill: ${COLORS.plotBg}; stroke: ${COLORS.line}; }
.zoneLabel { font-size: ${MATRIX_FONT.zone}px; font-weight: 700; }
.tick { stroke: ${COLORS.tick}; stroke-width: .8; }
.tickLabel { font-size: ${MATRIX_FONT.tick}px; fill: ${COLORS.muted}; }
.axisTitle { font-size: ${MATRIX_FONT.axis}px; fill: ${COLORS.muted}; font-weight: 700; }
.diagonal { stroke: ${COLORS.tick}; stroke-width: .9; stroke-dasharray: 4 3; }
.diagonalLabel { font-size: ${MATRIX_FONT.diagonal}px; fill: #7b8a97; }
.pointLabel { font-size: ${MATRIX_FONT.point}px; font-weight: 700; fill: ${COLORS.ink}; paint-order: stroke; stroke: #ffffff; stroke-width: 3px; stroke-linejoin: round; }
.pointShift { font-weight: 400; fill: ${COLORS.muted}; }
.leader { stroke: #7b8a97; stroke-width: .7; }
.matrixLegend { display: flex; gap: 4mm; margin: .6mm 0 0; font-size: ${FONT_PT.legend}pt; color: ${COLORS.muted}; }
.matrixLegend span { display: flex; align-items: center; gap: 1.2mm; }
.matrixLegend i { width: 2.6mm; height: 2.6mm; border-radius: 50%; display: inline-block; }
.dotSolid { background: #1d4ed8; }
.dotLow { border: 1px dashed #1d4ed8; background: #fff; }
.dotLabeled { background: ${COLORS.accent}; outline: 1px solid ${COLORS.ink}; }
.listPanel { min-height: 0; display: flex; flex-direction: column; gap: 1.6mm; font-size: ${FONT_PT.list}pt; }
.listHead { display: grid; grid-template-columns: ${listColumns}; gap: 1mm; font-size: ${FONT_PT.listHead}pt; color: ${COLORS.muted}; letter-spacing: .04em; border-bottom: 1px solid ${COLORS.line}; padding-bottom: .6mm; }
.listHead span:not(:first-child) { text-align: right; }
.stateBlock header { display: flex; align-items: baseline; gap: 1.4mm; border-bottom: 1px solid ${COLORS.line}; padding-bottom: .4mm; }
.stateBlock header i { width: 2.4mm; height: 2.4mm; border-radius: .5mm; display: inline-block; align-self: center; }
.stateBlock header b { font-size: ${FONT_PT.stateName}pt; }
.stateBlock header span { font-size: ${FONT_PT.list}pt; font-weight: 700; }
.stateBlock header small { margin-left: auto; font-size: 6.2pt; color: ${COLORS.muted}; }
.stateBlock table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.stateBlock td { padding: .55mm 0; border-bottom: 1px dotted #e3e9ee; vertical-align: middle; }
.nameCell { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.nameCell b { font-weight: 700; margin-right: 1mm; }
.rankCell { width: ${LIST_COLUMNS_MM.rank}mm; text-align: right; color: ${COLORS.muted}; }
.rankCell em { font-style: normal; margin: 0 .4mm; }
.shiftCell { width: ${LIST_COLUMNS_MM.shift}mm; text-align: right; font-weight: 700; }
.meanCell { width: ${LIST_COLUMNS_MM.mean}mm; text-align: right; }
.medianCell { width: ${LIST_COLUMNS_MM.median}mm; text-align: right; }
.winCell { width: ${LIST_COLUMNS_MM.winRate}mm; text-align: right; }
.flag { font-size: ${FONT_PT.flag}pt; font-weight: 700; border-radius: .6mm; padding: 0 .8mm; margin-right: .6mm; vertical-align: 1px; }
.flagLow { border: 1px dashed ${COLORS.ink}; }
.flagMean { background: ${COLORS.flagMeanBg}; color: ${COLORS.flagMeanText}; }
.emptyRow, .moreRow { margin: .5mm 0 0; font-size: 6.6pt; color: ${COLORS.muted}; }
.lowSampleBlock { margin-top: auto; border: 1px dashed ${COLORS.tick}; border-radius: 1mm; padding: 1mm 1.6mm; display: flex; flex-direction: column; gap: .3mm; font-size: 6.8pt; }
.lowSampleBlock span { color: ${COLORS.muted}; }
.narrative { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; border-top: 1.5px solid ${COLORS.ink}; padding-top: 1.6mm; }
.narrative div { display: flex; flex-direction: column; gap: .6mm; }
.narrative span { font-size: ${FONT_PT.narrativeLabel}pt; font-weight: 700; letter-spacing: .14em; color: ${COLORS.accent}; }
.narrative p { margin: 0; font-size: ${FONT_PT.narrative}pt; line-height: 1.45; }
.pageFooter { border-top: 1px solid ${COLORS.line}; padding-top: 1mm; font-size: ${FONT_PT.footer}pt; color: ${COLORS.muted}; display: flex; flex-direction: column; gap: .5mm; }
.pageFooter p { margin: 0; line-height: 1.35; }
.pageFooter div { display: flex; justify-content: space-between; }
`.trim()
