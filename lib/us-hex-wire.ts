// lib/us-hex-wire.ts
//
// US Stage Screener (/api/us/hex) 専用の columnar wire format。
// 行ごとに約 40 個のキー名と sector / industry / exchange 文字列を繰り返す JSON 行配列の代わりに、
// 列ごとの配列 + 文字列辞書で送る。数値は JSON の最短往復表現のままなので値は bit 単位で同一、
// null は null のまま (0 へ変換しない)。旧 compact=1 / 既定レスポンスはサーバ側でそのまま維持する。
//
// 列の順序・型・名前はこのファイルの US_HEX_WIRE_COLUMNS が唯一の定義。変更する場合は
// US_HEX_WIRE_VERSION を上げること (古いクライアントは version 不一致で fail closed する)。

export const US_HEX_WIRE_FORMAT = 'us-hex-columnar'
export const US_HEX_WIRE_VERSION = 2
/** クライアントが明示的に要求するクエリパラメータ。未指定なら旧レスポンス。 */
export const US_HEX_WIRE_PARAM = 'wire'
export const US_HEX_WIRE_REQUEST = `${US_HEX_WIRE_FORMAT}.v${US_HEX_WIRE_VERSION}`

export const US_HEX_DATA_STATUSES = ['ready', 'partial_stage', 'snapshot_pending', 'price_pending'] as const
export type UsHexDataStatus = (typeof US_HEX_DATA_STATUSES)[number]
export const US_HEX_TIMEFRAMES = ['daily', 'weekly', 'monthly'] as const
export type UsHexTimeframe = (typeof US_HEX_TIMEFRAMES)[number]

export type UsHexSmaAngles = {
  sma5: number | null
  sma25: number | null
  sma75: number | null
  sma300: number | null
}

/** compact=1 の行と同じ形。decode 結果はこの型で、HexMap にそのまま渡せる。 */
export type UsHexWireRow = {
  code: string
  name: string
  sector_large: string
  sector_small: string | null
  market_segment: string | null
  margin_type: string | null
  market_cap: number | null
  price: number | null
  daily_change: number | null
  weekly_change: number | null
  monthly_change: number | null
  months3_change: number | null
  months6_change: number | null
  ytd_change: number | null
  data_status: UsHexDataStatus
  stage: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  sma_angles: UsHexSmaAngles
  prev_sma_angles: UsHexSmaAngles
  physical_momentum_score: number | null
}

// text: 非 null 文字列 / dict: 非 null 辞書 index / dict?: null 可の辞書 index
// num: 非 null 有限数 / num?: null 可の有限数
type ColumnKind = 'text' | 'dict' | 'dict?' | 'num' | 'num?'

export const US_HEX_WIRE_COLUMNS = [
  ['code', 'text'],
  ['name', 'text'],
  ['sector_large', 'dict'],
  ['sector_small', 'dict?'],
  ['market_segment', 'dict?'],
  ['margin_type', 'dict?'],
  ['market_cap', 'num?'],
  ['price', 'num?'],
  ['daily_change', 'num?'],
  ['weekly_change', 'num?'],
  ['monthly_change', 'num?'],
  ['months3_change', 'num?'],
  ['months6_change', 'num?'],
  ['ytd_change', 'num?'],
  ['data_status', 'dict'],
  ['stage', 'num?'],
  ['daily_a_stage', 'num?'],
  ['daily_b_stage', 'num?'],
  ['weekly_a_stage', 'num?'],
  ['weekly_b_stage', 'num?'],
  ['monthly_a_stage', 'num?'],
  ['monthly_b_stage', 'num?'],
  ['sma_angles.sma5', 'num?'],
  ['sma_angles.sma25', 'num?'],
  ['sma_angles.sma75', 'num?'],
  ['sma_angles.sma300', 'num?'],
  ['prev_sma_angles.sma5', 'num?'],
  ['prev_sma_angles.sma25', 'num?'],
  ['prev_sma_angles.sma75', 'num?'],
  ['prev_sma_angles.sma300', 'num?'],
  ['physical_momentum_score', 'num?'],
] as const satisfies readonly (readonly [string, ColumnKind])[]

export type UsHexWireColumnName = (typeof US_HEX_WIRE_COLUMNS)[number][0]
type DictColumnName = Extract<(typeof US_HEX_WIRE_COLUMNS)[number], readonly [string, 'dict' | 'dict?']>[0]
type WireCell = string | number | null

export const US_HEX_WIRE_COLUMN_NAMES: readonly UsHexWireColumnName[] = US_HEX_WIRE_COLUMNS.map(([name]) => name)

export type UsHexUniverse = {
  activeAll: number
  productionActive: number
  stocks: number
  etfs: number
  mutualFunds: number
  testSymbols: number
  excludedArtifacts: number
}

export type UsHexCoverage = {
  prices: number
  snapshots: number
  dailyAStage: number
  dailyStage: number
  weeklyStage: number
  monthlyStage: number
}

export type UsHexAttributeBasis = {
  membership: 'CURRENT_UNIVERSE' | 'SNAPSHOT_DATE'
  profiles: 'CURRENT_REFERENCE' | 'UNAVAILABLE'
  classifications: 'CURRENT_REFERENCE' | 'UNAVAILABLE'
  shares: 'CURRENT_REFERENCE' | 'UNAVAILABLE'
}

const UNIVERSE_KEYS = ['activeAll', 'productionActive', 'stocks', 'etfs', 'mutualFunds', 'testSymbols', 'excludedArtifacts'] as const satisfies readonly (keyof UsHexUniverse)[]
const COVERAGE_KEYS = ['prices', 'snapshots', 'dailyAStage', 'dailyStage', 'weeklyStage', 'monthlyStage'] as const satisfies readonly (keyof UsHexCoverage)[]

/** レスポンス本体のうち行データ部分。メタデータ (count/date/...) は呼び出し側が並べる。 */
export type UsHexColumnarBody = {
  wire: { format: typeof US_HEX_WIRE_FORMAT; version: typeof US_HEX_WIRE_VERSION; columns: UsHexWireColumnName[] }
  dictionaries: Record<DictColumnName, string[]>
  columns: WireCell[][]
}

const COLUMN_GETTERS: Record<UsHexWireColumnName, (row: UsHexWireRow) => WireCell> = {
  code: (r) => r.code,
  name: (r) => r.name,
  sector_large: (r) => r.sector_large,
  sector_small: (r) => r.sector_small,
  market_segment: (r) => r.market_segment,
  margin_type: (r) => r.margin_type,
  market_cap: (r) => r.market_cap,
  price: (r) => r.price,
  daily_change: (r) => r.daily_change,
  weekly_change: (r) => r.weekly_change,
  monthly_change: (r) => r.monthly_change,
  months3_change: (r) => r.months3_change,
  months6_change: (r) => r.months6_change,
  ytd_change: (r) => r.ytd_change,
  data_status: (r) => r.data_status,
  stage: (r) => r.stage,
  daily_a_stage: (r) => r.daily_a_stage,
  daily_b_stage: (r) => r.daily_b_stage,
  weekly_a_stage: (r) => r.weekly_a_stage,
  weekly_b_stage: (r) => r.weekly_b_stage,
  monthly_a_stage: (r) => r.monthly_a_stage,
  monthly_b_stage: (r) => r.monthly_b_stage,
  'sma_angles.sma5': (r) => r.sma_angles.sma5,
  'sma_angles.sma25': (r) => r.sma_angles.sma25,
  'sma_angles.sma75': (r) => r.sma_angles.sma75,
  'sma_angles.sma300': (r) => r.sma_angles.sma300,
  'prev_sma_angles.sma5': (r) => r.prev_sma_angles.sma5,
  'prev_sma_angles.sma25': (r) => r.prev_sma_angles.sma25,
  'prev_sma_angles.sma75': (r) => r.prev_sma_angles.sma75,
  'prev_sma_angles.sma300': (r) => r.prev_sma_angles.sma300,
  physical_momentum_score: (r) => r.physical_momentum_score,
}

export class UsHexWireError extends Error {
  constructor(message: string) {
    super(`US HEX wire format error: ${message}`)
    this.name = 'UsHexWireError'
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** サーバ側: compact 行を columnar body へ変換する。辞書は行順の初出順で決定的。 */
export function encodeUsHexColumnar(rows: readonly UsHexWireRow[]): UsHexColumnarBody {
  const dictionaries = {} as Record<DictColumnName, string[]>
  const columns = US_HEX_WIRE_COLUMNS.map(([name, kind]) => {
    const get = COLUMN_GETTERS[name]
    if (kind !== 'dict' && kind !== 'dict?') return rows.map(get)
    const values: string[] = []
    const index = new Map<string, number>()
    dictionaries[name as DictColumnName] = values
    return rows.map((row) => {
      const value = get(row)
      if (value == null) {
        if (kind === 'dict') throw new UsHexWireError(`${name} must not be null`)
        return null
      }
      if (typeof value !== 'string') throw new UsHexWireError(`${name} must be a string`)
      let position = index.get(value)
      if (position == null) {
        position = values.length
        values.push(value)
        index.set(value, position)
      }
      return position
    })
  })
  return {
    wire: { format: US_HEX_WIRE_FORMAT, version: US_HEX_WIRE_VERSION, columns: [...US_HEX_WIRE_COLUMN_NAMES] },
    dictionaries,
    columns,
  }
}

export type UsHexDecodedResponse = {
  rows: UsHexWireRow[]
  count: number
  date: string | null
  timeframe: UsHexTimeframe
  source: 'tiingo'
  universe: UsHexUniverse | null
  coverage: UsHexCoverage | null
  cache: 'hit' | 'miss' | null
  notice: string | null
  attributeBasis: UsHexAttributeBasis | null
}

function decodeAttributeBasis(value: unknown): UsHexAttributeBasis | null {
  if (value === undefined) return null
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsHexWireError('attributeBasis must be an object')
  }
  const basis = value as Record<string, unknown>
  if (basis.membership !== 'CURRENT_UNIVERSE' && basis.membership !== 'SNAPSHOT_DATE') {
    throw new UsHexWireError('attributeBasis.membership is invalid')
  }
  if (basis.profiles !== 'CURRENT_REFERENCE' && basis.profiles !== 'UNAVAILABLE') {
    throw new UsHexWireError('attributeBasis.profiles is invalid')
  }
  if (basis.classifications !== 'CURRENT_REFERENCE' && basis.classifications !== 'UNAVAILABLE') {
    throw new UsHexWireError('attributeBasis.classifications is invalid')
  }
  if (basis.shares !== 'CURRENT_REFERENCE' && basis.shares !== 'UNAVAILABLE') {
    throw new UsHexWireError('attributeBasis.shares is invalid')
  }
  return basis as UsHexAttributeBasis
}

function decodeCounts<K extends string>(value: unknown, keys: readonly K[], label: string): Record<K, number> | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new UsHexWireError(`${label} must be an object`)
  const record = value as Record<string, unknown>
  const out = {} as Record<K, number>
  for (const key of keys) {
    if (!isFiniteNumber(record[key])) throw new UsHexWireError(`${label}.${key} must be a finite number`)
    out[key] = record[key] as number
  }
  return out
}

/**
 * クライアント側: columnar レスポンスを検証して compact 行へ戻す。
 * version / 列順 / 列長 / 型 / 辞書 index のどれかが想定外なら例外を投げる (fail closed)。
 */
export function decodeUsHexColumnar(payload: unknown): UsHexDecodedResponse {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) throw new UsHexWireError('payload must be an object')
  const body = payload as Record<string, unknown>
  if (body.success !== true) throw new UsHexWireError('success flag is missing')

  const wire = body.wire as Record<string, unknown> | null | undefined
  if (wire == null || typeof wire !== 'object') throw new UsHexWireError('wire header is missing')
  if (wire.format !== US_HEX_WIRE_FORMAT) throw new UsHexWireError(`unsupported format ${String(wire.format)}`)
  if (wire.version !== US_HEX_WIRE_VERSION) throw new UsHexWireError(`unsupported version ${String(wire.version)}`)
  const wireColumns = wire.columns
  if (
    !Array.isArray(wireColumns)
    || wireColumns.length !== US_HEX_WIRE_COLUMN_NAMES.length
    || wireColumns.some((name, i) => name !== US_HEX_WIRE_COLUMN_NAMES[i])
  ) {
    throw new UsHexWireError('column schema mismatch')
  }

  const count = body.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new UsHexWireError('count must be a non-negative integer')
  const date = body.date
  if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new UsHexWireError('date is invalid')
  const timeframe = body.timeframe
  if (!US_HEX_TIMEFRAMES.includes(timeframe as UsHexTimeframe)) throw new UsHexWireError('timeframe is invalid')
  if (body.source !== 'tiingo') throw new UsHexWireError('source is invalid')
  const cache = body.cache === undefined ? null : body.cache
  if (cache !== null && cache !== 'hit' && cache !== 'miss') throw new UsHexWireError('cache is invalid')
  const notice = body.notice === undefined ? null : body.notice
  if (notice !== null && typeof notice !== 'string') throw new UsHexWireError('notice is invalid')
  const universe = decodeCounts(body.universe, UNIVERSE_KEYS, 'universe')
  const coverage = decodeCounts(body.coverage, COVERAGE_KEYS, 'coverage')
  const attributeBasis = decodeAttributeBasis(body.attributeBasis)

  const columns = body.columns
  if (!Array.isArray(columns) || columns.length !== US_HEX_WIRE_COLUMNS.length) throw new UsHexWireError('columns length mismatch')
  const dictionaries = body.dictionaries
  if (dictionaries == null || typeof dictionaries !== 'object' || Array.isArray(dictionaries)) throw new UsHexWireError('dictionaries are missing')

  const decoded = new Map<UsHexWireColumnName, WireCell[]>()
  US_HEX_WIRE_COLUMNS.forEach(([name, kind], position) => {
    const column = columns[position]
    if (!Array.isArray(column) || column.length !== count) throw new UsHexWireError(`${name} length mismatch`)
    const nullable = kind === 'dict?' || kind === 'num?'
    if (kind === 'dict' || kind === 'dict?') {
      const dictionary = (dictionaries as Record<string, unknown>)[name]
      if (!Array.isArray(dictionary) || dictionary.some((value) => typeof value !== 'string')) {
        throw new UsHexWireError(`${name} dictionary is invalid`)
      }
      if (name === 'data_status' && dictionary.some((value) => !US_HEX_DATA_STATUSES.includes(value))) {
        throw new UsHexWireError('data_status dictionary has an unknown value')
      }
      decoded.set(name, column.map((cell: unknown) => {
        if (cell === null && nullable) return null
        if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= dictionary.length) {
          throw new UsHexWireError(`${name} has an invalid dictionary index`)
        }
        return dictionary[cell] as string
      }))
      return
    }
    for (const cell of column as unknown[]) {
      if (cell === null && nullable) continue
      if (kind === 'text' ? typeof cell !== 'string' : !isFiniteNumber(cell)) {
        throw new UsHexWireError(`${name} has an invalid value`)
      }
    }
    decoded.set(name, column as WireCell[])
  })

  const text = (name: UsHexWireColumnName) => decoded.get(name) as string[]
  const nullableText = (name: UsHexWireColumnName) => decoded.get(name) as (string | null)[]
  const nullableNum = (name: UsHexWireColumnName) => decoded.get(name) as (number | null)[]

  const code = text('code')
  const name = text('name')
  const sectorLarge = text('sector_large')
  const sectorSmall = nullableText('sector_small')
  const marketSegment = nullableText('market_segment')
  const marginType = nullableText('margin_type')
  const marketCap = nullableNum('market_cap')
  const price = nullableNum('price')
  const dailyChange = nullableNum('daily_change')
  const weeklyChange = nullableNum('weekly_change')
  const monthlyChange = nullableNum('monthly_change')
  const months3Change = nullableNum('months3_change')
  const months6Change = nullableNum('months6_change')
  const ytdChange = nullableNum('ytd_change')
  const dataStatus = text('data_status') as UsHexDataStatus[]
  const stage = nullableNum('stage')
  const dailyA = nullableNum('daily_a_stage')
  const dailyB = nullableNum('daily_b_stage')
  const weeklyA = nullableNum('weekly_a_stage')
  const weeklyB = nullableNum('weekly_b_stage')
  const monthlyA = nullableNum('monthly_a_stage')
  const monthlyB = nullableNum('monthly_b_stage')
  const sma5 = nullableNum('sma_angles.sma5')
  const sma25 = nullableNum('sma_angles.sma25')
  const sma75 = nullableNum('sma_angles.sma75')
  const sma300 = nullableNum('sma_angles.sma300')
  const prevSma5 = nullableNum('prev_sma_angles.sma5')
  const prevSma25 = nullableNum('prev_sma_angles.sma25')
  const prevSma75 = nullableNum('prev_sma_angles.sma75')
  const prevSma300 = nullableNum('prev_sma_angles.sma300')
  const pms = nullableNum('physical_momentum_score')

  const rows: UsHexWireRow[] = new Array(count)
  for (let i = 0; i < count; i += 1) {
    rows[i] = {
      code: code[i],
      name: name[i],
      sector_large: sectorLarge[i],
      sector_small: sectorSmall[i],
      market_segment: marketSegment[i],
      margin_type: marginType[i],
      market_cap: marketCap[i],
      price: price[i],
      daily_change: dailyChange[i],
      weekly_change: weeklyChange[i],
      monthly_change: monthlyChange[i],
      months3_change: months3Change[i],
      months6_change: months6Change[i],
      ytd_change: ytdChange[i],
      data_status: dataStatus[i],
      stage: stage[i],
      daily_a_stage: dailyA[i],
      daily_b_stage: dailyB[i],
      weekly_a_stage: weeklyA[i],
      weekly_b_stage: weeklyB[i],
      monthly_a_stage: monthlyA[i],
      monthly_b_stage: monthlyB[i],
      sma_angles: { sma5: sma5[i], sma25: sma25[i], sma75: sma75[i], sma300: sma300[i] },
      prev_sma_angles: { sma5: prevSma5[i], sma25: prevSma25[i], sma75: prevSma75[i], sma300: prevSma300[i] },
      physical_momentum_score: pms[i],
    }
  }

  return {
    rows,
    count,
    date: date as string | null,
    timeframe: timeframe as UsHexTimeframe,
    source: 'tiingo',
    universe: universe as UsHexUniverse | null,
    coverage: coverage as UsHexCoverage | null,
    cache: cache as 'hit' | 'miss' | null,
    notice: notice as string | null,
    attributeBasis,
  }
}
