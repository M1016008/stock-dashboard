// lib/tv-format.ts
// 銘柄コードを TradingView 形式（EXCHANGE:SYMBOL）に変換する。

export type TvExchange = 'TSE' | 'NASDAQ' | 'NYSE'

/**
 * Yahoo Finance 形式の ticker と marketSegment から TradingView 表記を生成する。
 * - 日本株（.T サフィックス）: "TSE:7203"
 * - 米国株 NASDAQ: "NASDAQ:AAPL"
 * - 米国株 NYSE: "NYSE:JPM"
 * - それ以外: ticker をそのまま返す。
 */
export function toTvSymbol(ticker: string, marketSegment?: string): string {
  if (ticker.endsWith('.T')) {
    return `TSE:${ticker.slice(0, -2)}`
  }
  if (marketSegment === 'NASDAQ') return `NASDAQ:${ticker}`
  if (marketSegment === 'NYSE') return `NYSE:${ticker}`
  return ticker
}

/**
 * TradingView ウォッチリストインポート形式（.txt）の本文を生成する。
 * 1 行 1 銘柄。先頭行に `###セクション名` を付けるとセクション分けされる。
 */
export function buildTvWatchlistText(
  symbols: string[],
  sectionName?: string,
): string {
  const lines: string[] = []
  if (sectionName) lines.push(`###${sectionName}`)
  for (const s of symbols) lines.push(s)
  return lines.join('\n') + '\n'
}
