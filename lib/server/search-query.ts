export function escapeSqlLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
