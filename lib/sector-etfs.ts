export type SectorEtfCategory = 'topix17' | 'theme' | 'support'
export type SectorEtfProvider = 'nextfunds' | 'globalx' | 'blackrock' | 'maxis' | 'amova'

export interface SectorEtfCatalogItem {
  ticker: string
  shortName: string
  displayName: string
  category: SectorEtfCategory
  group: string
  theme: string
  provider: SectorEtfProvider
  sourceUrl: string
  holdingsUrl?: string
  description?: string
}

const JPX_ETF_LIST_URL = 'https://www.jpx.co.jp/english/equities/products/etfs/issues/01.html'
const JPX_TOPIX17_URL = 'https://www.jpx.co.jp/english/equities/products/etfs/issues/01-03.html'
const BLACKROCK_2522_HOLDINGS_URL =
  'https://www.blackrock.com/jp/individual-en/en/products/306039/fund/1480664184455.ajax?fileType=csv&fileName=2522_holdings&dataType=fund'

function nextFundsLineupUrl(ticker: string): string {
  return `https://nextfunds.jp/en/lineup/${ticker}/`
}

function nextFundsHoldingsUrl(ticker: string): string {
  return `https://www.nomura-am.co.jp/fund/monthly_holdings/${ticker}_brd_data.xlsx`
}

function globalXLineupUrl(ticker: string): string {
  return `https://globalxetfs.co.jp/funds/${ticker}/`
}

function globalXHoldingsUrl(ticker: string): string {
  return `https://www.solactive.com/downloads/etfservices/tse-pcf/single/${ticker}.csv`
}

function topix17(
  ticker: string,
  theme: string,
  description: string,
): SectorEtfCatalogItem {
  return {
    ticker,
    shortName: theme,
    displayName: `NEXT FUNDS ${theme}(TOPIX-17) ETF`,
    category: 'topix17',
    group: 'TOPIX-17代表ETF',
    theme,
    provider: 'nextfunds',
    sourceUrl: nextFundsLineupUrl(ticker),
    holdingsUrl: nextFundsHoldingsUrl(ticker),
    description,
  }
}

function globalX(
  ticker: string,
  shortName: string,
  group: string,
  theme: string,
  description: string,
): SectorEtfCatalogItem {
  return {
    ticker,
    shortName,
    displayName: `Global X ${shortName} ETF`,
    category: 'theme',
    group,
    theme,
    provider: 'globalx',
    sourceUrl: globalXLineupUrl(ticker),
    holdingsUrl: globalXHoldingsUrl(ticker),
    description,
  }
}

function nextFundsTheme(
  ticker: string,
  shortName: string,
  group: string,
  theme: string,
  description: string,
): SectorEtfCatalogItem {
  return {
    ticker,
    shortName,
    displayName: `NEXT FUNDS ${shortName}`,
    category: 'theme',
    group,
    theme,
    provider: 'nextfunds',
    sourceUrl: nextFundsLineupUrl(ticker),
    holdingsUrl: nextFundsHoldingsUrl(ticker),
    description,
  }
}

export const SECTOR_ETF_CATALOG: readonly SectorEtfCatalogItem[] = [
  topix17('1617', '食品', '食品・飲料など生活必需品の業界トレンドを確認します。'),
  topix17('1618', 'エネルギー資源', '石油・鉱業など資源関連の業界トレンドを確認します。'),
  topix17('1619', '建設・資材', '建設、ガラス、土石、金属製品などの業界トレンドを確認します。'),
  topix17('1620', '素材・化学', '繊維、化学、紙・パルプなど素材関連の業界トレンドを確認します。'),
  topix17('1621', '医薬品', '医薬品セクターの資金流入・流出を確認します。'),
  topix17('1622', '自動車・輸送機', '自動車、輸送用機器などの業界トレンドを確認します。'),
  topix17('1623', '鉄鋼・非鉄', '鉄鋼、非鉄金属など素材市況感応度の高い業界を確認します。'),
  topix17('1624', '機械', '機械、設備投資関連の業界トレンドを確認します。'),
  topix17('1625', '電機・精密', '電気機器、精密機器などハイテク製造業のトレンドを確認します。'),
  topix17('1626', '情報通信・サービスその他', '情報通信、サービス、その他製品などの広い成長領域を確認します。'),
  topix17('1627', '電力・ガス', 'ディフェンシブ色の強い公益セクターを確認します。'),
  topix17('1628', '運輸・物流', '陸運、海運、空運、倉庫など物流関連のトレンドを確認します。'),
  topix17('1629', '商社・卸売', '商社、卸売などグローバル景気に連動しやすい業界を確認します。'),
  topix17('1630', '小売', '小売、消費関連の業界トレンドを確認します。'),
  topix17('1631', '銀行', '銀行セクターの金利感応度と資金流入を確認します。'),
  topix17('1632', '金融(除く銀行)', '証券、保険、その他金融などのトレンドを確認します。'),
  topix17('1633', '不動産', '不動産セクターの金利・需給感応度を確認します。'),
  nextFundsTheme('200A', '日経半導体株指数', '半導体', '国内半導体', '国内半導体株の広いトレンドを確認します。'),
  {
    ticker: '221A',
    shortName: 'MAXIS日経半導体',
    displayName: 'MAXIS日経半導体株上場投信',
    category: 'theme',
    group: '半導体',
    theme: '国内半導体',
    provider: 'maxis',
    sourceUrl: JPX_ETF_LIST_URL,
    description: '日経半導体株指数連動の国内上場ETFです。',
  },
  globalX('2243', '半導体', '半導体', '国内半導体', '国内半導体関連銘柄のテーマトレンドを確認します。'),
  globalX('2644', '半導体関連-日本株式', '半導体', '国内半導体', '半導体製造装置を含む国内関連銘柄を確認します。'),
  globalX('282A', '半導体・トップ10-日本株式', '半導体', '国内半導体', '半導体テーマの主力集中型ETFを確認します。'),
  nextFundsTheme('346A', 'S&P500半導体・半導体製造装置35%キャップ指数', '半導体', '海外半導体', '東証上場ETFで海外半導体テーマを確認します。'),
  globalX('223A', 'AI&ビッグデータ', 'AI・ロボ・テック', 'AI/ビッグデータ', 'AIとビッグデータ関連のテーマトレンドを確認します。'),
  globalX('2638', 'ロボティクス&AI-日本株式', 'AI・ロボ・テック', '国内AI/ロボ', '国内ロボティクス・AI関連銘柄のトレンドを確認します。'),
  globalX('2854', 'テック・トップ20-日本株式', 'AI・ロボ・テック', '国内テック', '国内テック主力銘柄の集中型トレンドを確認します。'),
  {
    ticker: '2522',
    shortName: 'iShares オートメーション&ロボット',
    displayName: 'iShares Automation & Robot ETF',
    category: 'theme',
    group: 'AI・ロボ・テック',
    theme: 'グローバルロボ',
    provider: 'blackrock',
    sourceUrl: 'https://www.blackrock.com/jp/individual-en/en/products/306039/',
    holdingsUrl: BLACKROCK_2522_HOLDINGS_URL,
    description: '東証上場ETFでグローバルな自動化・ロボティクスを確認します。',
  },
  {
    ticker: '408A',
    shortName: 'iShares AI グローバル・イノベーション',
    displayName: 'iShares AI Global Innovation Active ETF',
    category: 'theme',
    group: 'AI・ロボ・テック',
    theme: 'グローバルAI',
    provider: 'blackrock',
    sourceUrl: JPX_ETF_LIST_URL,
    description: '東証上場のAI関連アクティブETFです。',
  },
  {
    ticker: '552A',
    shortName: 'MAXIS米国AIインフラ',
    displayName: 'MAXIS米国AIインフラ株上場投信',
    category: 'theme',
    group: 'AI・ロボ・テック',
    theme: '米国AIインフラ',
    provider: 'maxis',
    sourceUrl: JPX_ETF_LIST_URL,
    description: '東証上場ETFで米国AIインフラ関連を確認します。',
  },
  globalX('2637', 'クリーンテック-日本株式', 'クリーンテック・インフラ', '国内クリーンテック', '国内クリーンテック関連銘柄を確認します。'),
  globalX('2847', '新成長インフラ-日本株式', 'クリーンテック・インフラ', '国内インフラ', '次世代インフラ関連のテーマトレンドを確認します。'),
  globalX('2848', 'MSCI気候変動対応-日本株式', 'クリーンテック・インフラ', '気候変動対応', '国内の気候変動対応テーマを確認します。'),
  nextFundsTheme('294A', 'MSCIジャパン気候変動指数(セレクト)', 'クリーンテック・インフラ', '気候変動対応', '気候変動対応銘柄の広いトレンドを確認します。'),
  {
    ticker: '2250',
    shortName: 'iShares MSCIジャパン気候変動アクション',
    displayName: 'iShares MSCI Japan Climate Action ETF',
    category: 'theme',
    group: 'クリーンテック・インフラ',
    theme: '気候変動対応',
    provider: 'blackrock',
    sourceUrl: JPX_ETF_LIST_URL,
    description: '東証上場ETFで気候変動アクションテーマを確認します。',
  },
  globalX('2639', 'バイオ&メドテック-日本株式', 'バイオ・医療', '国内バイオ/メドテック', '国内バイオ・医療機器関連のトレンドを確認します。'),
  globalX('2640', 'ゲーム&アニメ-日本株式', 'ゲーム・消費テーマ', '国内ゲーム/アニメ', 'ゲーム、アニメなどコンテンツ関連のトレンドを確認します。'),
  globalX('2645', 'レジャー&エンターテインメント-日本株式', 'ゲーム・消費テーマ', '国内レジャー', 'レジャー、エンタメ関連のテーマトレンドを確認します。'),
  globalX('2646', 'メタルビジネス-日本株式', 'メタル・素材', '国内メタル', '金属・素材関連のテーマトレンドを確認します。'),
  globalX('2836', 'フィンテック-日本株式', '金融・フィンテック', '国内フィンテック', 'フィンテック関連のテーマトレンドを確認します。'),
  globalX('315A', '銀行 高配当-日本株式', '金融・フィンテック', '国内銀行高配当', '銀行セクターの高配当テーマを確認します。'),
  {
    ticker: '540A',
    shortName: '日経銀行株トップ10',
    displayName: '上場インデックスファンド日経銀行株トップ10',
    category: 'theme',
    group: '金融・フィンテック',
    theme: '国内銀行',
    provider: 'amova',
    sourceUrl: JPX_ETF_LIST_URL,
    description: '銀行株トップ10のトレンドを確認します。',
  },
  globalX('466A', '防衛テック', '防衛・安全保障', 'グローバル防衛テック', '東証上場ETFで防衛テックテーマを確認します。'),
  {
    ticker: '513A',
    shortName: '防衛テック-日本株式',
    displayName: 'Global X 防衛テック-日本株式 ETF',
    category: 'theme',
    group: '防衛・安全保障',
    theme: '国内防衛テック',
    provider: 'globalx',
    sourceUrl: globalXLineupUrl('513A'),
    description: '国内防衛テック関連のテーマトレンドを確認します。',
  },
  nextFundsTheme('1343', '東証REIT指数', 'REIT・不動産', '国内REIT', '東証REIT指数で不動産ファンド市場のトレンドを確認します。'),
] as const

export const TOPIX17_ETF_TICKERS = SECTOR_ETF_CATALOG
  .filter((item) => item.category === 'topix17')
  .map((item) => item.ticker)

export const SECTOR_ETF_TICKERS = SECTOR_ETF_CATALOG.map((item) => item.ticker)

export function getSectorEtfByTicker(ticker: string): SectorEtfCatalogItem | undefined {
  const normalized = ticker.trim().toUpperCase().replace(/\.T$/i, '')
  return SECTOR_ETF_CATALOG.find((item) => item.ticker === normalized)
}

export function getSectorEtfSourceGuide(provider: SectorEtfProvider): string {
  if (provider === 'nextfunds') return 'NEXT FUNDS公式 組入銘柄情報'
  if (provider === 'globalx') return 'Global X公式ページ経由 PCF CSV'
  if (provider === 'blackrock') return 'BlackRock/iShares公式 Holdings'
  if (provider === 'maxis') return 'MAXIS/JPX公式情報'
  return '運用会社/JPX公式情報'
}

export const SECTOR_ETF_REFERENCE_LINKS = {
  jpxList: JPX_ETF_LIST_URL,
  jpxTopix17: JPX_TOPIX17_URL,
}
