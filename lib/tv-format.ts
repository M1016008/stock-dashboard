// lib/tv-format.ts
// 銘柄コードを TradingView 形式（EXCHANGE:SYMBOL）に変換する。日本株 (TSE) 専用。

export type TvExchange = 'TSE'

/**
 * Yahoo Finance 形式の ticker から TradingView 表記を生成する。
 * - .T サフィックス付き: "TSE:7203"
 * - 4〜5桁の数字のみ: "TSE:7203"
 * - それ以外（不明形式）: ticker をそのまま返す
 */
export function toTvSymbol(ticker: string, _marketSegment?: string): string {
  if (ticker.endsWith('.T')) return `TSE:${ticker.slice(0, -2)}`
  if (/^\d{4,5}$/.test(ticker)) return `TSE:${ticker}`
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
