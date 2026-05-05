// lib/master/tickers.ts
// スクリーナー・HEXマップ等で対象とする銘柄マスタ
// 当面はハードコード。将来的に JQuants / 取引所マスタから自動取得予定。

export type JpMarketSegment = 'プライム' | 'スタンダード' | 'グロース'
export type UsMarketSegment = 'NYSE' | 'NASDAQ'
export type MarginType = '貸借' | '信用'

export interface MasterTicker {
  ticker: string
  name: string
  market: 'JP' | 'US'
  sectorLarge: string
  sectorSmall?: string
  /** 日本株: プライム/スタンダード/グロース、米国株: NYSE/NASDAQ */
  marketSegment: JpMarketSegment | UsMarketSegment
  /** 日本株のみ: 貸借銘柄 / 信用銘柄 */
  marginType?: MarginType
}

export function getSectorLarge(t: MasterTicker): string {
  return t.sectorLarge || 'その他'
}

/**
 * 日本株（東証プライム代表銘柄。プライム代表は概ね貸借銘柄）
 */
export const JP_TICKERS: MasterTicker[] = [
  // 自動車・輸送機
  { ticker: '7203.T', name: 'トヨタ自動車', market: 'JP', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7267.T', name: 'ホンダ', market: 'JP', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7201.T', name: '日産自動車', market: 'JP', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7269.T', name: 'スズキ', market: 'JP', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7270.T', name: 'SUBARU', market: 'JP', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7272.T', name: 'ヤマハ発動機', market: 'JP', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },

  // 電機・精密
  { ticker: '6758.T', name: 'ソニーグループ', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6501.T', name: '日立製作所', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6502.T', name: '東芝', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6701.T', name: 'NEC', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6702.T', name: '富士通', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6752.T', name: 'パナソニック', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6594.T', name: 'ニデック', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6981.T', name: '村田製作所', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6861.T', name: 'キーエンス', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6857.T', name: 'アドバンテスト', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8035.T', name: '東京エレクトロン', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7733.T', name: 'オリンパス', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7741.T', name: 'HOYA', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7751.T', name: 'キヤノン', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7974.T', name: '任天堂', market: 'JP', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },

  // 機械
  { ticker: '6273.T', name: 'SMC', market: 'JP', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6301.T', name: 'コマツ', market: 'JP', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6326.T', name: 'クボタ', market: 'JP', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6367.T', name: 'ダイキン工業', market: 'JP', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6954.T', name: 'ファナック', market: 'JP', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7011.T', name: '三菱重工業', market: 'JP', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },

  // 通信・ITサービス
  { ticker: '9432.T', name: 'NTT', market: 'JP', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9433.T', name: 'KDDI', market: 'JP', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9434.T', name: 'ソフトバンク', market: 'JP', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9613.T', name: 'NTTデータ', market: 'JP', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9984.T', name: 'ソフトバンクグループ', market: 'JP', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6098.T', name: 'リクルート', market: 'JP', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },

  // 銀行・金融
  { ticker: '8306.T', name: '三菱UFJ', market: 'JP', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8316.T', name: '三井住友FG', market: 'JP', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8411.T', name: 'みずほFG', market: 'JP', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8591.T', name: 'オリックス', market: 'JP', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8725.T', name: 'MS&AD', market: 'JP', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8766.T', name: '東京海上HD', market: 'JP', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },

  // 商社・小売
  { ticker: '8001.T', name: '伊藤忠商事', market: 'JP', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8031.T', name: '三井物産', market: 'JP', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8053.T', name: '住友商事', market: 'JP', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8058.T', name: '三菱商事', market: 'JP', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8267.T', name: 'イオン', market: 'JP', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },

  // 不動産・建設
  { ticker: '8801.T', name: '三井不動産', market: 'JP', sectorLarge: '不動産・建設', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8802.T', name: '三菱地所', market: 'JP', sectorLarge: '不動産・建設', marketSegment: 'プライム', marginType: '貸借' },

  // 運輸・物流
  { ticker: '9020.T', name: 'JR東日本', market: 'JP', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9021.T', name: 'JR西日本', market: 'JP', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9022.T', name: 'JR東海', market: 'JP', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9101.T', name: '日本郵船', market: 'JP', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9104.T', name: '商船三井', market: 'JP', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9201.T', name: 'JAL', market: 'JP', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9202.T', name: 'ANA', market: 'JP', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },

  // エネルギー・素材
  { ticker: '9501.T', name: '東京電力', market: 'JP', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9503.T', name: '関西電力', market: 'JP', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9531.T', name: '東京ガス', market: 'JP', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4063.T', name: '信越化学工業', market: 'JP', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '5108.T', name: 'ブリヂストン', market: 'JP', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '5401.T', name: '日本製鉄', market: 'JP', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },

  // 医薬品・ヘルスケア
  { ticker: '4502.T', name: '武田薬品', market: 'JP', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4503.T', name: 'アステラス製薬', market: 'JP', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4519.T', name: '中外製薬', market: 'JP', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4543.T', name: 'テルモ', market: 'JP', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4568.T', name: '第一三共', market: 'JP', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },

  // 食品・生活用品
  { ticker: '4452.T', name: '花王', market: 'JP', sectorLarge: '食品・生活用品', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4901.T', name: '富士フイルム', market: 'JP', sectorLarge: '食品・生活用品', marketSegment: 'プライム', marginType: '貸借' },

  // サービス・娯楽
  { ticker: '4661.T', name: 'オリエンタルランド', market: 'JP', sectorLarge: 'サービス・娯楽', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9735.T', name: 'セコム', market: 'JP', sectorLarge: 'サービス・娯楽', marketSegment: 'プライム', marginType: '貸借' },
]

/**
 * 米国株（S&P 500 主要銘柄）
 * 取引所: NASDAQ / NYSE
 */
export const US_TICKERS: MasterTicker[] = [
  // 情報技術
  { ticker: 'AAPL', name: 'Apple', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'MSFT', name: 'Microsoft', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'NVDA', name: 'NVIDIA', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'AVGO', name: 'Broadcom', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'ORCL', name: 'Oracle', market: 'US', sectorLarge: '情報技術', marketSegment: 'NYSE' },
  { ticker: 'ADBE', name: 'Adobe', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'CRM', name: 'Salesforce', market: 'US', sectorLarge: '情報技術', marketSegment: 'NYSE' },
  { ticker: 'CSCO', name: 'Cisco Systems', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'INTC', name: 'Intel', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'AMD', name: 'AMD', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'QCOM', name: 'Qualcomm', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'TXN', name: 'Texas Instruments', market: 'US', sectorLarge: '情報技術', marketSegment: 'NASDAQ' },
  { ticker: 'IBM', name: 'IBM', market: 'US', sectorLarge: '情報技術', marketSegment: 'NYSE' },

  // コミュニケーション
  { ticker: 'GOOGL', name: 'Alphabet', market: 'US', sectorLarge: 'コミュニケーション', marketSegment: 'NASDAQ' },
  { ticker: 'META', name: 'Meta Platforms', market: 'US', sectorLarge: 'コミュニケーション', marketSegment: 'NASDAQ' },
  { ticker: 'NFLX', name: 'Netflix', market: 'US', sectorLarge: 'コミュニケーション', marketSegment: 'NASDAQ' },
  { ticker: 'DIS', name: 'Walt Disney', market: 'US', sectorLarge: 'コミュニケーション', marketSegment: 'NYSE' },

  // 一般消費財
  { ticker: 'AMZN', name: 'Amazon', market: 'US', sectorLarge: '一般消費財', marketSegment: 'NASDAQ' },
  { ticker: 'TSLA', name: 'Tesla', market: 'US', sectorLarge: '一般消費財', marketSegment: 'NASDAQ' },
  { ticker: 'HD', name: 'Home Depot', market: 'US', sectorLarge: '一般消費財', marketSegment: 'NYSE' },
  { ticker: 'NKE', name: 'Nike', market: 'US', sectorLarge: '一般消費財', marketSegment: 'NYSE' },
  { ticker: 'MCD', name: "McDonald's", market: 'US', sectorLarge: '一般消費財', marketSegment: 'NYSE' },
  { ticker: 'SBUX', name: 'Starbucks', market: 'US', sectorLarge: '一般消費財', marketSegment: 'NASDAQ' },

  // 生活必需品
  { ticker: 'WMT', name: 'Walmart', market: 'US', sectorLarge: '生活必需品', marketSegment: 'NYSE' },
  { ticker: 'PG', name: 'Procter & Gamble', market: 'US', sectorLarge: '生活必需品', marketSegment: 'NYSE' },
  { ticker: 'KO', name: 'Coca-Cola', market: 'US', sectorLarge: '生活必需品', marketSegment: 'NYSE' },
  { ticker: 'PEP', name: 'PepsiCo', market: 'US', sectorLarge: '生活必需品', marketSegment: 'NASDAQ' },
  { ticker: 'COST', name: 'Costco', market: 'US', sectorLarge: '生活必需品', marketSegment: 'NASDAQ' },

  // ヘルスケア
  { ticker: 'UNH', name: 'UnitedHealth', market: 'US', sectorLarge: 'ヘルスケア', marketSegment: 'NYSE' },
  { ticker: 'LLY', name: 'Eli Lilly', market: 'US', sectorLarge: 'ヘルスケア', marketSegment: 'NYSE' },
  { ticker: 'ABBV', name: 'AbbVie', market: 'US', sectorLarge: 'ヘルスケア', marketSegment: 'NYSE' },
  { ticker: 'TMO', name: 'Thermo Fisher', market: 'US', sectorLarge: 'ヘルスケア', marketSegment: 'NYSE' },
  { ticker: 'MRK', name: 'Merck', market: 'US', sectorLarge: 'ヘルスケア', marketSegment: 'NYSE' },
  { ticker: 'ABT', name: 'Abbott', market: 'US', sectorLarge: 'ヘルスケア', marketSegment: 'NYSE' },

  // 金融
  { ticker: 'JPM', name: 'JPMorgan Chase', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'V', name: 'Visa', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'MA', name: 'Mastercard', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'BRK-B', name: 'Berkshire Hathaway', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'BAC', name: 'Bank of America', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'WFC', name: 'Wells Fargo', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'GS', name: 'Goldman Sachs', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'MS', name: 'Morgan Stanley', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'C', name: 'Citigroup', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'BLK', name: 'BlackRock', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },
  { ticker: 'AXP', name: 'American Express', market: 'US', sectorLarge: '金融', marketSegment: 'NYSE' },

  // エネルギー・資本財
  { ticker: 'XOM', name: 'Exxon Mobil', market: 'US', sectorLarge: 'エネルギー・資本財', marketSegment: 'NYSE' },
  { ticker: 'CVX', name: 'Chevron', market: 'US', sectorLarge: 'エネルギー・資本財', marketSegment: 'NYSE' },
  { ticker: 'BA', name: 'Boeing', market: 'US', sectorLarge: 'エネルギー・資本財', marketSegment: 'NYSE' },
  { ticker: 'CAT', name: 'Caterpillar', market: 'US', sectorLarge: 'エネルギー・資本財', marketSegment: 'NYSE' },
  { ticker: 'DE', name: 'Deere & Company', market: 'US', sectorLarge: 'エネルギー・資本財', marketSegment: 'NYSE' },
]

export const ALL_TICKERS: MasterTicker[] = [...JP_TICKERS, ...US_TICKERS]

export function getTickersByMarket(market: 'JP' | 'US' | 'ALL'): MasterTicker[] {
  if (market === 'JP') return JP_TICKERS
  if (market === 'US') return US_TICKERS
  return ALL_TICKERS
}

export function findTicker(ticker: string): MasterTicker | undefined {
  return ALL_TICKERS.find((t) => t.ticker === ticker)
}
