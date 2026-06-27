import { NIKKEI225_TICKERS, UNIVERSE_FILTER_PARAM } from './market-universe'

export type MarketMomentumGroupId =
  | 'all'
  | 'nikkei225'
  | 'prime'
  | 'standard'
  | 'growth'
  | 'other'
  | 'unclassified'

export type MarketMomentumRankId = 'initial' | 'continuation' | 'stall' | 'drop' | 'strong' | 'weak'

export type MarketMomentumGroupMeta = {
  id: MarketMomentumGroupId
  label: string
  shortLabel: string
  description: string
  marketSegment?: string
}

export const MARKET_MOMENTUM_GROUPS: Record<MarketMomentumGroupId, MarketMomentumGroupMeta> = {
  all: {
    id: 'all',
    label: '全市場',
    shortLabel: '全市場',
    description: 'PMS算出済みの日本株全体から、初動・強い勢い・弱含みを確認します。',
  },
  nikkei225: {
    id: 'nikkei225',
    label: '日経225',
    shortLabel: '日経225',
    description: '日経平均225採用銘柄の中で、初動・強い勢い・弱含みを確認します。',
  },
  prime: {
    id: 'prime',
    label: 'プライム',
    shortLabel: 'プライム',
    description: 'プライム市場の銘柄群で、モメンタム分布と銘柄ランキングを確認します。',
    marketSegment: 'プライム',
  },
  standard: {
    id: 'standard',
    label: 'スタンダード',
    shortLabel: 'スタンダード',
    description: 'スタンダード市場の銘柄群で、モメンタム分布と銘柄ランキングを確認します。',
    marketSegment: 'スタンダード',
  },
  growth: {
    id: 'growth',
    label: 'グロース',
    shortLabel: 'グロース',
    description: 'グロース市場の銘柄群で、モメンタム分布と銘柄ランキングを確認します。',
    marketSegment: 'グロース',
  },
  other: {
    id: 'other',
    label: 'その他',
    shortLabel: 'その他',
    description: 'その他区分の銘柄群で、モメンタム分布と銘柄ランキングを確認します。',
    marketSegment: 'その他',
  },
  unclassified: {
    id: 'unclassified',
    label: '未分類',
    shortLabel: '未分類',
    description: '市場区分が未分類の銘柄群を確認します。',
    marketSegment: '未分類',
  },
}

export const MARKET_MOMENTUM_GROUP_ORDER: MarketMomentumGroupId[] = [
  'all',
  'nikkei225',
  'prime',
  'standard',
  'growth',
  'other',
  'unclassified',
]

export function parseMarketMomentumGroup(value: unknown): MarketMomentumGroupId {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return 'all'
  const normalized = raw.trim().toLowerCase().replace(/[_\s-]+/g, '')
  if (normalized === 'all' || normalized === 'jp' || normalized === 'market') return 'all'
  if (normalized === 'nikkei225' || normalized === 'n225' || normalized === 'nikkei') return 'nikkei225'
  if (normalized === 'prime' || raw.includes('プライム')) return 'prime'
  if (normalized === 'standard' || raw.includes('スタンダード')) return 'standard'
  if (normalized === 'growth' || raw.includes('グロース')) return 'growth'
  if (normalized === 'other' || raw.includes('その他')) return 'other'
  if (normalized === 'unclassified' || raw.includes('未分類')) return 'unclassified'
  return 'all'
}

function appendDateParam(sp: URLSearchParams, date?: string | null) {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) sp.set('date', date)
}

export function marketMomentumHref(group: MarketMomentumGroupId, date?: string | null): string {
  const sp = new URLSearchParams({ group })
  appendDateParam(sp, date)
  return `/market-momentum?${sp.toString()}`
}

export function parseMarketMomentumRank(value: unknown): MarketMomentumRankId {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return 'initial'
  const normalized = raw.trim().toLowerCase().replace(/[_\s-]+/g, '')
  if (normalized === 'continuation' || normalized === 'continue' || normalized === 'strong' || normalized === 'pms' || raw.includes('継続') || raw.includes('強い')) return 'continuation'
  if (normalized === 'stall' || normalized === 'slowdown' || raw.includes('失速')) return 'stall'
  if (normalized === 'drop' || normalized === 'weak' || normalized === 'down' || raw.includes('下落') || raw.includes('弱い')) return 'drop'
  return 'initial'
}

export function marketMomentumRankingHref(group: MarketMomentumGroupId, rank: MarketMomentumRankId, date?: string | null): string {
  const sp = new URLSearchParams({ group, rank })
  appendDateParam(sp, date)
  return `/market-momentum?${sp.toString()}#stock-list`
}

export function marketMomentumHrefForSegment(label: string, code?: string | null, date?: string | null): string {
  if (code === 'nikkei225' || label.includes('日経225')) return marketMomentumHref('nikkei225', date)
  if (label.includes('プライム')) return marketMomentumHref('prime', date)
  if (label.includes('スタンダード')) return marketMomentumHref('standard', date)
  if (label.includes('グロース')) return marketMomentumHref('growth', date)
  if (label.includes('その他')) return marketMomentumHref('other', date)
  if (label.includes('未分類')) return marketMomentumHref('unclassified', date)
  return marketMomentumHref('all', date)
}

export function screenerHrefForMarketMomentumGroup(
  group: MarketMomentumGroupId,
  params: Record<string, string | number | null | undefined> = {},
): string {
  const sp = new URLSearchParams()
  if (group === 'nikkei225') {
    sp.set(UNIVERSE_FILTER_PARAM, 'nikkei225')
  } else {
    const segment = MARKET_MOMENTUM_GROUPS[group].marketSegment
    if (segment && segment !== '未分類') sp.set('segment', segment)
  }
  for (const [key, value] of Object.entries(params)) {
    if (value != null && String(value).trim() !== '') sp.set(key, String(value))
  }
  const query = sp.toString()
  return `/screener${query ? `?${query}` : ''}`
}

export function marketMomentumGroupSql(
  group: MarketMomentumGroupId,
  symbolColumn: string,
  marketSegmentExpression: string,
): { sql: string; params: string[] } {
  if (group === 'all') {
    return {
      sql: '1 = 1',
      params: [],
    }
  }
  if (group === 'nikkei225') {
    return {
      sql: `${symbolColumn} IN (${NIKKEI225_TICKERS.map(() => '?').join(', ')})`,
      params: [...NIKKEI225_TICKERS],
    }
  }
  const segment = MARKET_MOMENTUM_GROUPS[group].marketSegment ?? '未分類'
  return {
    sql: `${marketSegmentExpression} = ?`,
    params: [segment],
  }
}
