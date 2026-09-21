// A transaction is supplementary class evidence, never a current holding balance.
export function recentTransactionTypesFromText(block: string): string[] {
  return [...new Set([...block.matchAll(
    /(?:20\d{2}年\d{1,2}月\d{1,2}日|20\d{2}-\d{2}-\d{2})\s*(普通株式|優先株式|投資口|株券)\s+[\d,]+/g,
  )].map((match) => match[1]))]
}
