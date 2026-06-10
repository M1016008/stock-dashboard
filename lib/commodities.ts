export type CommodityMarket = 'JP' | 'US'
export type CommodityMarketSlug = 'jp' | 'us'

export type CommodityGroupId =
  | 'precious_metals'
  | 'energy'
  | 'industrial_metals'
  | 'agriculture'
  | 'broad'
  | 'leveraged_inverse'
  | 'related_equity'

export type CommodityProductType =
  | 'spot'
  | 'futures'
  | 'basket'
  | 'etn'
  | 'leveraged'
  | 'inverse'
  | 'equity_theme'

export interface CommodityInstrument {
  market: CommodityMarket
  marketSlug: CommodityMarketSlug
  ticker: string
  name: string
  shortName: string
  group: CommodityGroupId
  commodity: string
  productType: CommodityProductType
  currency: 'JPY' | 'USD'
  leveragedInverse: boolean
  inverse: boolean
  relatedTheme: boolean
  sourceUrl?: string
  description: string
}

export const COMMODITY_GROUPS: readonly { id: CommodityGroupId; label: string; description: string }[] = [
  { id: 'precious_metals', label: '貴金属', description: '金・銀・プラチナ・パラジウムの現物/先物連動型です。' },
  { id: 'energy', label: 'エネルギー', description: '原油、天然ガス、ガソリンなどエネルギー商品のETF/ETNです。' },
  { id: 'industrial_metals', label: '産業金属', description: '銅、アルミ、ニッケルなど景気感応度の高い金属です。' },
  { id: 'agriculture', label: '農産物', description: '穀物、小麦、とうもろこし、大豆、砂糖などです。' },
  { id: 'broad', label: '総合商品', description: '複数の商品を束ねたバスケット型です。' },
  { id: 'leveraged_inverse', label: 'レバ・インバース', description: '短期売買向けのレバレッジ/インバース型です。' },
  { id: 'related_equity', label: '関連株テーマ', description: '商品そのものではなく、関連企業株に投資するテーマETFです。' },
] as const

export const COMMODITY_PRODUCT_LABELS: Record<CommodityProductType, string> = {
  spot: '現物型',
  futures: '先物型',
  basket: 'バスケット',
  etn: 'ETN',
  leveraged: 'レバ',
  inverse: 'インバース',
  equity_theme: '関連株テーマ',
}

export const COMMODITY_REFERENCE_LINKS = {
  jpxEtf: 'https://www.jpx.co.jp/equities/products/etfs/issues/01.html',
  jpxEtn: 'https://www.jpx.co.jp/equities/products/etns/issues/01.html',
  spdr: 'https://www.ssga.com/us/en/intermediary/etfs',
  ishares: 'https://www.ishares.com/us',
  invesco: 'https://www.invesco.com/us/financial-products/etfs',
  uscf: 'https://www.uscfinvestments.com/',
  teucrium: 'https://www.teucrium.com/',
  proshares: 'https://www.proshares.com/',
}

function jp(
  ticker: string,
  shortName: string,
  group: CommodityGroupId,
  commodity: string,
  productType: CommodityProductType,
  description: string,
  sourceUrl = COMMODITY_REFERENCE_LINKS.jpxEtf,
): CommodityInstrument {
  return {
    market: 'JP',
    marketSlug: 'jp',
    ticker,
    name: shortName,
    shortName,
    group,
    commodity,
    productType,
    currency: 'JPY',
    leveragedInverse: productType === 'leveraged' || productType === 'inverse',
    inverse: productType === 'inverse',
    relatedTheme: productType === 'equity_theme',
    sourceUrl,
    description,
  }
}

function us(
  ticker: string,
  name: string,
  shortName: string,
  group: CommodityGroupId,
  commodity: string,
  productType: CommodityProductType,
  description: string,
  sourceUrl?: string,
): CommodityInstrument {
  return {
    market: 'US',
    marketSlug: 'us',
    ticker,
    name,
    shortName,
    group,
    commodity,
    productType,
    currency: 'USD',
    leveragedInverse: productType === 'leveraged' || productType === 'inverse',
    inverse: productType === 'inverse',
    relatedTheme: productType === 'equity_theme',
    sourceUrl,
    description,
  }
}

export const COMMODITY_INSTRUMENTS: readonly CommodityInstrument[] = [
  jp('1328', '金価格連動型上場投信', 'precious_metals', '金', 'spot', '金価格に連動する国内上場ETFです。'),
  jp('1540', '純金上場信託', 'precious_metals', '金', 'spot', '国内で金現物価格のトレンドを確認する中核ETFです。'),
  jp('1541', '純プラチナ上場信託', 'precious_metals', 'プラチナ', 'spot', 'プラチナ価格のトレンドを確認します。'),
  jp('1542', '純銀上場信託', 'precious_metals', '銀', 'spot', '銀価格のトレンドを確認します。'),
  jp('1543', '純パラジウム上場信託', 'precious_metals', 'パラジウム', 'spot', 'パラジウム価格のトレンドを確認します。'),
  jp('1672', 'WisdomTree 金上場投資信託', 'precious_metals', '金', 'spot', '海外商品連動型の金ETFです。'),
  jp('1673', 'WisdomTree 銀上場投資信託', 'precious_metals', '銀', 'spot', '海外商品連動型の銀ETFです。'),
  jp('1674', 'WisdomTree 白金上場投資信託', 'precious_metals', 'プラチナ', 'spot', '海外商品連動型の白金ETFです。'),
  jp('1675', 'WisdomTree パラジウム上場投資信託', 'precious_metals', 'パラジウム', 'spot', '海外商品連動型のパラジウムETFです。'),
  jp('1676', 'WisdomTree 貴金属バスケット', 'precious_metals', '貴金属バスケット', 'basket', '貴金属を束ねたバスケット型です。'),
  jp('569A', 'iShares プラチナ ETF', 'precious_metals', 'プラチナ', 'spot', '東証上場のプラチナETFです。'),

  jp('1671', 'WTI原油価格連動型上場投信', 'energy', 'WTI原油', 'futures', 'WTI原油価格に連動する国内上場ETFです。'),
  jp('1685', 'WisdomTree エネルギー上場投資信託', 'energy', 'エネルギー', 'basket', 'エネルギー商品バスケットです。'),
  jp('1689', 'WisdomTree 天然ガス上場投資信託', 'energy', '天然ガス', 'futures', '天然ガス価格のトレンドを確認します。'),
  jp('1690', 'WisdomTree WTI原油上場投資信託', 'energy', 'WTI原油', 'futures', 'WTI原油の別上場商品です。'),
  jp('1691', 'WisdomTree ガソリン上場投資信託', 'energy', 'ガソリン', 'futures', 'ガソリン価格のトレンドを確認します。'),
  jp('1699', 'NEXT FUNDS NOMURA原油インデックス', 'energy', '原油', 'futures', 'NOMURA原油指数に連動する国内上場ETFです。'),

  jp('1686', 'WisdomTree 産業用金属上場投資信託', 'industrial_metals', '産業金属', 'basket', '産業金属バスケットのトレンドを確認します。'),
  jp('1692', 'WisdomTree アルミニウム上場投資信託', 'industrial_metals', 'アルミニウム', 'futures', 'アルミ価格のトレンドを確認します。'),
  jp('1693', 'WisdomTree 銅上場投資信託', 'industrial_metals', '銅', 'futures', '銅価格のトレンドを確認します。'),
  jp('1694', 'WisdomTree ニッケル上場投資信託', 'industrial_metals', 'ニッケル', 'futures', 'ニッケル価格のトレンドを確認します。'),

  jp('1687', 'WisdomTree 農産物上場投資信託', 'agriculture', '農産物', 'basket', '農産物バスケットのトレンドを確認します。'),
  jp('1688', 'WisdomTree 穀物上場投資信託', 'agriculture', '穀物', 'basket', '穀物バスケットのトレンドを確認します。'),
  jp('1695', 'WisdomTree 小麦上場投資信託', 'agriculture', '小麦', 'futures', '小麦価格のトレンドを確認します。'),
  jp('1696', 'WisdomTree とうもろこし上場投資信託', 'agriculture', 'とうもろこし', 'futures', 'とうもろこし価格のトレンドを確認します。'),
  jp('1697', 'WisdomTree 大豆上場投資信託', 'agriculture', '大豆', 'futures', '大豆価格のトレンドを確認します。'),

  jp('1684', 'WisdomTree 総合商品上場投資信託', 'broad', '総合商品', 'basket', '複数商品を束ねた総合商品バスケットです。'),

  jp('2036', '金先物ダブル・ブル ETN', 'leveraged_inverse', '金', 'leveraged', '金先物のレバレッジ型ETNです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.jpxEtn),
  jp('2037', '金先物ベア ETN', 'leveraged_inverse', '金', 'inverse', '金先物のインバース型ETNです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.jpxEtn),
  jp('2038', 'ドバイ原油先物ダブル・ブル ETN', 'leveraged_inverse', 'ドバイ原油', 'leveraged', '原油先物のレバレッジ型ETNです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.jpxEtn),
  jp('2039', 'ドバイ原油先物ベア ETN', 'leveraged_inverse', 'ドバイ原油', 'inverse', '原油先物のインバース型ETNです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.jpxEtn),

  jp('579A', 'Global X 銀ビジネス ETF', 'related_equity', '銀関連株', 'equity_theme', '銀そのものではなく銀関連企業株に投資するテーマETFです。'),
  jp('580A', 'Global X 銅ビジネス ETF', 'related_equity', '銅関連株', 'equity_theme', '銅そのものではなく銅関連企業株に投資するテーマETFです。'),
  jp('2646', 'Global X メタルビジネス-日本株式 ETF', 'related_equity', '金属関連株', 'equity_theme', '金属関連企業株に投資するテーマETFです。'),

  us('GLD', 'SPDR Gold Shares', 'SPDR Gold', 'precious_metals', '金', 'spot', '米国上場の代表的な金ETFです。', COMMODITY_REFERENCE_LINKS.spdr),
  us('IAU', 'iShares Gold Trust', 'iShares Gold', 'precious_metals', '金', 'spot', '金現物価格の低コスト代表ETFです。', COMMODITY_REFERENCE_LINKS.ishares),
  us('SLV', 'iShares Silver Trust', 'iShares Silver', 'precious_metals', '銀', 'spot', '銀価格の米国上場代表ETFです。', COMMODITY_REFERENCE_LINKS.ishares),
  us('SIVR', 'abrdn Physical Silver Shares ETF', 'abrdn Silver', 'precious_metals', '銀', 'spot', '銀現物連動型ETFです。'),
  us('PPLT', 'abrdn Physical Platinum Shares ETF', 'abrdn Platinum', 'precious_metals', 'プラチナ', 'spot', 'プラチナ現物連動型ETFです。'),
  us('PALL', 'abrdn Physical Palladium Shares ETF', 'abrdn Palladium', 'precious_metals', 'パラジウム', 'spot', 'パラジウム現物連動型ETFです。'),

  us('USO', 'United States Oil Fund', 'US Oil', 'energy', 'WTI原油', 'futures', 'WTI原油先物に連動する米国上場ETFです。', COMMODITY_REFERENCE_LINKS.uscf),
  us('BNO', 'United States Brent Oil Fund', 'Brent Oil', 'energy', 'ブレント原油', 'futures', 'ブレント原油先物に連動するETFです。', COMMODITY_REFERENCE_LINKS.uscf),
  us('DBO', 'Invesco DB Oil Fund', 'DB Oil', 'energy', '原油', 'futures', '原油先物ベースの商品ETFです。', COMMODITY_REFERENCE_LINKS.invesco),
  us('UNG', 'United States Natural Gas Fund', 'US Natural Gas', 'energy', '天然ガス', 'futures', '天然ガス先物に連動するETFです。', COMMODITY_REFERENCE_LINKS.uscf),
  us('DBE', 'Invesco DB Energy Fund', 'DB Energy', 'energy', 'エネルギー', 'basket', 'エネルギー商品バスケットです。', COMMODITY_REFERENCE_LINKS.invesco),

  us('CPER', 'United States Copper Index Fund', 'US Copper', 'industrial_metals', '銅', 'futures', '銅先物に連動するETFです。', COMMODITY_REFERENCE_LINKS.uscf),
  us('DBB', 'Invesco DB Base Metals Fund', 'DB Base Metals', 'industrial_metals', '産業金属', 'basket', '産業金属バスケットです。', COMMODITY_REFERENCE_LINKS.invesco),

  us('DBA', 'Invesco DB Agriculture Fund', 'DB Agriculture', 'agriculture', '農産物', 'basket', '農産物バスケットです。', COMMODITY_REFERENCE_LINKS.invesco),
  us('CORN', 'Teucrium Corn Fund', 'Corn', 'agriculture', 'とうもろこし', 'futures', 'とうもろこし先物に連動するETFです。', COMMODITY_REFERENCE_LINKS.teucrium),
  us('WEAT', 'Teucrium Wheat Fund', 'Wheat', 'agriculture', '小麦', 'futures', '小麦先物に連動するETFです。', COMMODITY_REFERENCE_LINKS.teucrium),
  us('SOYB', 'Teucrium Soybean Fund', 'Soybean', 'agriculture', '大豆', 'futures', '大豆先物に連動するETFです。', COMMODITY_REFERENCE_LINKS.teucrium),
  us('CANE', 'Teucrium Sugar Fund', 'Sugar', 'agriculture', '砂糖', 'futures', '砂糖先物に連動するETFです。', COMMODITY_REFERENCE_LINKS.teucrium),

  us('DBC', 'Invesco DB Commodity Index Tracking Fund', 'DB Commodity', 'broad', '総合商品', 'basket', '総合商品指数に連動する代表ETFです。', COMMODITY_REFERENCE_LINKS.invesco),
  us('GSG', 'iShares S&P GSCI Commodity-Indexed Trust', 'iShares GSCI', 'broad', '総合商品', 'basket', 'S&P GSCI商品指数に連動するETFです。', COMMODITY_REFERENCE_LINKS.ishares),

  us('UCO', 'ProShares Ultra Bloomberg Crude Oil', 'Ultra Crude Oil', 'leveraged_inverse', '原油', 'leveraged', '原油のレバレッジ型ETFです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.proshares),
  us('SCO', 'ProShares UltraShort Bloomberg Crude Oil', 'UltraShort Crude Oil', 'leveraged_inverse', '原油', 'inverse', '原油のインバース型ETFです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.proshares),
  us('BOIL', 'ProShares Ultra Bloomberg Natural Gas', 'Ultra Natural Gas', 'leveraged_inverse', '天然ガス', 'leveraged', '天然ガスのレバレッジ型ETFです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.proshares),
  us('KOLD', 'ProShares UltraShort Bloomberg Natural Gas', 'UltraShort Natural Gas', 'leveraged_inverse', '天然ガス', 'inverse', '天然ガスのインバース型ETFです。短期売買向けとして別枠表示します。', COMMODITY_REFERENCE_LINKS.proshares),
] as const

export const CORE_COMMODITY_INSTRUMENTS = COMMODITY_INSTRUMENTS.filter(
  (item) => !item.leveragedInverse && !item.relatedTheme,
)

export const LEVERAGED_COMMODITY_INSTRUMENTS = COMMODITY_INSTRUMENTS.filter((item) => item.leveragedInverse)

export const RELATED_COMMODITY_INSTRUMENTS = COMMODITY_INSTRUMENTS.filter((item) => item.relatedTheme)

export function commodityGroupLabel(group: CommodityGroupId): string {
  return COMMODITY_GROUPS.find((item) => item.id === group)?.label ?? group
}

export function normalizeCommodityMarketSlug(value: string | null | undefined): CommodityMarketSlug | null {
  const v = value?.trim().toLowerCase()
  if (v === 'jp' || v === 'us') return v
  return null
}

export function normalizeCommodityTicker(ticker: string): string {
  return decodeURIComponent(ticker).trim().toUpperCase().replace(/\.T$/i, '')
}

export function getCommodityInstrument(
  marketSlug: string | null | undefined,
  ticker: string,
): CommodityInstrument | undefined {
  const slug = normalizeCommodityMarketSlug(marketSlug)
  const normalized = normalizeCommodityTicker(ticker)
  if (!slug) return undefined
  return COMMODITY_INSTRUMENTS.find((item) => item.marketSlug === slug && item.ticker === normalized)
}
