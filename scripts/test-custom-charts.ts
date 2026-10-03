import assert from 'node:assert/strict'
import {
  FormulaSyntaxError,
  collectAssetRefs,
  evaluateFormulaNode,
  formatFormula,
  parseFormula,
} from '@/lib/custom-charts/formula'

function evalFormula(formula: string, values: Record<string, number>): number {
  const ast = parseFormula(formula)
  return evaluateFormulaNode(ast, new Map(Object.entries(values)))
}

assert.equal(evalFormula('7203 * 100 + 6758 * 200', { 'JP:7203': 10, 'JP:6758': 20 }), 5_000)
assert.equal(evalFormula('(7203 + 6758 + 9984) / 3', { 'JP:7203': 9, 'JP:6758': 12, 'JP:9984': 15 }), 12)
assert.equal(evalFormula('7203 / 6758', { 'JP:7203': 30, 'JP:6758': 10 }), 3)
assert.equal(evalFormula('7203 ^ 2', { 'JP:7203': 11 }), 121)
assert.equal(evalFormula('（JP:7203 ＋ US:AAPL） ÷ 2', { 'JP:7203': 80, 'US:AAPL': 20 }), 50)

const ast = parseFormula('CMD:JP:1540 + US:GLD')
assert.deepEqual(collectAssetRefs(ast).map((ref) => ref.key), ['CMD:JP:1540', 'US:GLD'])
assert.equal(formatFormula(ast), '(CMD:JP:1540 + US:GLD)')

assert.throws(() => parseFormula('(7203 + 6758'), /閉じ括弧が不足/)
assert.throws(() => evalFormula('7203 / 0', { 'JP:7203': 1 }), /0で割ることはできません/)
assert.throws(() => parseFormula('100 + 200'), /銘柄が指定されていません/)
assert.throws(() => evalFormula('7203 + 6758', { 'JP:7203': 1 }), FormulaSyntaxError)

console.log('custom chart formula tests passed')
