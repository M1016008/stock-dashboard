const US_TEST_SYMBOL_PATTERN = /^(?:(?:A|C|M|N|P)TEST(?:[-.]?[A-Z0-9]+)?|Z[A-Z]ZZT|ZVZZC)$/i
const US_NON_INVESTABLE_ARTIFACT_PATTERN = /^(?:-P-H|\d{6,})$/i

export function isUsTestSymbol(ticker: string | null | undefined): boolean {
  return US_TEST_SYMBOL_PATTERN.test(ticker?.trim() ?? '')
}

export function isUsInvestableSymbol(ticker: string | null | undefined): boolean {
  const value = ticker?.trim() ?? ''
  return /^[A-Z0-9][A-Z0-9.-]*$/i.test(value)
    && !US_TEST_SYMBOL_PATTERN.test(value)
    && !US_NON_INVESTABLE_ARTIFACT_PATTERN.test(value)
}

export function usTestSymbolExclusionSql(column: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) {
    throw new Error(`Unsafe US ticker SQL column: ${column}`)
  }
  const upper = `UPPER(${column})`
  return `NOT (
    ${upper} GLOB 'ATEST*'
    OR ${upper} GLOB 'CTEST*'
    OR ${upper} GLOB 'MTEST*'
    OR ${upper} GLOB 'NTEST*'
    OR ${upper} GLOB 'PTEST*'
    OR (${upper} GLOB 'Z?ZZT' AND LENGTH(${column}) = 5)
    OR ${upper} = 'ZVZZC'
  )`
}

export function usInvestableSymbolSql(column: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) {
    throw new Error(`Unsafe US ticker SQL column: ${column}`)
  }
  const upper = `UPPER(${column})`
  return `(
    ${usTestSymbolExclusionSql(column)}
    AND ${upper} GLOB '[A-Z0-9]*'
    AND ${upper} NOT GLOB '*[^A-Z0-9.-]*'
    AND NOT (${upper} NOT GLOB '*[^0-9]*' AND LENGTH(${column}) >= 6)
  )`
}
