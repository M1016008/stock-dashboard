import type { CustomAssetRef, FormulaNode } from '@/lib/custom-charts/types'

type Token =
  | { type: 'number'; value: number; raw: string }
  | { type: 'asset'; value: string; raw: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '^' }
  | { type: 'paren'; value: '(' | ')' }

const OPERATOR_MAP: Record<string, string> = {
  '＋': '+',
  '－': '-',
  'ー': '-',
  '−': '-',
  '×': '*',
  '＊': '*',
  '÷': '/',
  '／': '/',
  '（': '(',
  '）': ')',
}

export class FormulaSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormulaSyntaxError'
  }
}

export function normalizeFormula(input: string): string {
  return input
    .split('')
    .map((char) => OPERATOR_MAP[char] ?? char)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenizeFormula(input: string): Token[] {
  const normalized = normalizeFormula(input)
  const tokens: Token[] = []
  let i = 0

  while (i < normalized.length) {
    const char = normalized[i]
    if (/\s/.test(char)) {
      i += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char })
      i += 1
      continue
    }
    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^') {
      tokens.push({ type: 'op', value: char })
      i += 1
      continue
    }
    if (/[0-9]/.test(char)) {
      let j = i
      while (j < normalized.length && /[0-9A-Za-z.:_-]/.test(normalized[j])) j += 1
      const raw = normalized.slice(i, j)
      if (isAssetLike(raw)) {
        tokens.push({ type: 'asset', value: raw.toUpperCase(), raw })
      } else {
        const value = Number(raw)
        if (!Number.isFinite(value)) throw new FormulaSyntaxError(`数値「${raw}」を読み取れません。`)
        tokens.push({ type: 'number', value, raw })
      }
      i = j
      continue
    }
    if (/[A-Za-z]/.test(char)) {
      let j = i
      while (j < normalized.length && /[0-9A-Za-z.:_-]/.test(normalized[j])) j += 1
      const raw = normalized.slice(i, j)
      tokens.push({ type: 'asset', value: raw.toUpperCase(), raw })
      i = j
      continue
    }
    throw new FormulaSyntaxError(`使用できない文字「${char}」があります。`)
  }

  return tokens
}

function isAssetLike(raw: string): boolean {
  const upper = raw.toUpperCase()
  if (/^(JP|US):[A-Z0-9._-]+$/.test(upper)) return true
  if (/^CMD:(JP|US):[A-Z0-9._-]+$/.test(upper)) return true
  if (/^\d{4}$/.test(upper)) return true
  if (/^\d{3}[A-Z]$/.test(upper)) return true
  return false
}

export function parseFormula(input: string): FormulaNode {
  const tokens = tokenizeFormula(input)
  if (tokens.length === 0) throw new FormulaSyntaxError('数式が入力されていません。')
  const parser = new Parser(tokens)
  const node = parser.parseExpression()
  if (!parser.done()) {
    const token = parser.peek()
    throw new FormulaSyntaxError(token?.type === 'paren' && token.value === ')' ? '開き括弧が不足しています。' : '数式の途中に余分な入力があります。')
  }
  if (collectAssetRefs(node).length === 0) throw new FormulaSyntaxError('銘柄が指定されていません。')
  return node
}

class Parser {
  private index = 0

  constructor(private readonly tokens: Token[]) {}

  done(): boolean {
    return this.index >= this.tokens.length
  }

  peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private take(): Token {
    const token = this.tokens[this.index]
    if (!token) throw new FormulaSyntaxError('数式が途中で終わっています。')
    this.index += 1
    return token
  }

  parseExpression(): FormulaNode {
    return this.parseAddSub()
  }

  private parseAddSub(): FormulaNode {
    let node = this.parseMulDiv()
    while (this.peek()?.type === 'op' && (this.peek()?.value === '+' || this.peek()?.value === '-')) {
      const op = this.take() as Extract<Token, { type: 'op' }>
      const right = this.parseMulDiv()
      node = { type: 'binary', op: op.value, left: node, right }
    }
    return node
  }

  private parseMulDiv(): FormulaNode {
    let node = this.parsePower()
    while (this.peek()?.type === 'op' && (this.peek()?.value === '*' || this.peek()?.value === '/')) {
      const op = this.take() as Extract<Token, { type: 'op' }>
      const right = this.parsePower()
      node = { type: 'binary', op: op.value, left: node, right }
    }
    return node
  }

  private parsePower(): FormulaNode {
    const left = this.parseUnary()
    if (this.peek()?.type === 'op' && this.peek()?.value === '^') {
      this.take()
      const right = this.parsePower()
      return { type: 'binary', op: '^', left, right }
    }
    return left
  }

  private parseUnary(): FormulaNode {
    if (this.peek()?.type === 'op' && this.peek()?.value === '-') {
      this.take()
      return { type: 'unary', op: '-', expr: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): FormulaNode {
    const token = this.take()
    if (token.type === 'number') return { type: 'number', value: token.value }
    if (token.type === 'asset') return { type: 'asset', symbol: token.value }
    if (token.type === 'paren' && token.value === '(') {
      const node = this.parseExpression()
      const close = this.peek()
      if (!close) throw new FormulaSyntaxError('閉じ括弧が不足しています。')
      this.take()
      if (close.type !== 'paren' || close.value !== ')') throw new FormulaSyntaxError('閉じ括弧が不足しています。')
      return node
    }
    if (token.type === 'paren' && token.value === ')') throw new FormulaSyntaxError('開き括弧が不足しています。')
    throw new FormulaSyntaxError('銘柄、数値、または括弧を入力してください。')
  }
}

export function normalizeAssetRef(symbol: string): CustomAssetRef {
  const raw = symbol.trim().toUpperCase().replace(/\.T$/i, '')
  const cmd = raw.match(/^CMD:(JP|US):([A-Z0-9._-]+)$/)
  if (cmd) {
    const market = cmd[1] as 'JP' | 'US'
    const ticker = cmd[2]
    return { kind: 'CMD', market, ticker, key: `CMD:${market}:${ticker}`, input: symbol }
  }
  const explicit = raw.match(/^(JP|US):([A-Z0-9._-]+)$/)
  if (explicit) {
    const kind = explicit[1] as 'JP' | 'US'
    const ticker = explicit[2].replace(/\.T$/i, '')
    return { kind, ticker, key: `${kind}:${ticker}`, input: symbol }
  }
  if (/^(?:\d{4}|\d{3}[A-Z])$/.test(raw)) return { kind: 'JP', ticker: raw, key: `JP:${raw}`, input: symbol }
  return { kind: 'US', ticker: raw, key: `US:${raw}`, input: symbol }
}

export function collectAssetRefs(node: FormulaNode): CustomAssetRef[] {
  const map = new Map<string, CustomAssetRef>()
  const visit = (current: FormulaNode) => {
    if (current.type === 'asset') {
      const ref = normalizeAssetRef(current.symbol)
      map.set(ref.key, ref)
      return
    }
    if (current.type === 'unary') visit(current.expr)
    if (current.type === 'binary') {
      visit(current.left)
      visit(current.right)
    }
  }
  visit(node)
  return Array.from(map.values())
}

export function evaluateFormulaNode(node: FormulaNode, values: Map<string, number>): number {
  if (node.type === 'number') return node.value
  if (node.type === 'asset') {
    const key = normalizeAssetRef(node.symbol).key
    const value = values.get(key)
    if (value == null || !Number.isFinite(value)) throw new FormulaSyntaxError('価格データが不足しています。')
    return value
  }
  if (node.type === 'unary') return -evaluateFormulaNode(node.expr, values)
  const left = evaluateFormulaNode(node.left, values)
  const right = evaluateFormulaNode(node.right, values)
  if (node.op === '+') return left + right
  if (node.op === '-') return left - right
  if (node.op === '*') return left * right
  if (node.op === '/') {
    if (right === 0) throw new FormulaSyntaxError('0で割ることはできません。')
    return left / right
  }
  return left ** right
}

export function formatFormula(node: FormulaNode): string {
  if (node.type === 'number') return String(node.value)
  if (node.type === 'asset') return normalizeAssetRef(node.symbol).key
  if (node.type === 'unary') return `-${formatFormula(node.expr)}`
  return `(${formatFormula(node.left)} ${node.op} ${formatFormula(node.right)})`
}
