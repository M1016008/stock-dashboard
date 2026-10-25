function topLevelKeywords(sql: string): string[] {
  const keywords: string[] = []
  let depth = 0
  let index = 0
  while (index < sql.length) {
    const character = sql[index]
    const next = sql[index + 1]
    if (character === '-' && next === '-') {
      index += 2
      while (index < sql.length && sql[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index = Math.min(sql.length, index + 2)
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const closing = character === '[' ? ']' : character
      index += 1
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (closing !== ']' && sql[index + 1] === closing) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (character === '(') {
      depth += 1
      index += 1
      continue
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (depth === 0 && /[A-Za-z_]/.test(character)) {
      const start = index
      index += 1
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1
      keywords.push(sql.slice(start, index).toUpperCase())
      continue
    }
    index += 1
  }
  return keywords
}

export function sqlStatementMayMutate(sql: string): boolean {
  const keywords = topLevelKeywords(sql)
  const first = keywords[0]
  if (!first) return true
  if (first === 'SELECT' || first === 'VALUES' || first === 'EXPLAIN') return false
  if (first === 'PRAGMA') {
    return /(?:=|\bjournal_mode\b|\bwal_checkpoint\b)/i.test(sql)
  }
  if (first === 'WITH') {
    const command = keywords.slice(1).find((keyword) =>
      keyword === 'SELECT'
      || keyword === 'VALUES'
      || keyword === 'INSERT'
      || keyword === 'UPDATE'
      || keyword === 'DELETE'
      || keyword === 'REPLACE'
    )
    return command !== 'SELECT' && command !== 'VALUES'
  }
  return true
}
