// lib/master/tickers.ts
// スクリーナー・HEXマップ等で対象とする日本株マスタ（JPX 上場銘柄）。
// 当面はハードコード。日々のデータはアップロードした業種マスタ (sector_master) と
// CSV 取込結果 (tv_daily_snapshots) で上書きされる。

export type JpMarketSegment = 'プライム' | 'スタンダード' | 'グロース'
export type MarginType = '貸借' | '信用'

export interface MasterTicker {
  ticker: string
  name: string
  sectorLarge: string
  sectorSmall?: string
  /** 東証区分: プライム / スタンダード / グロース */
  marketSegment: JpMarketSegment
  /** 貸借銘柄 / 信用銘柄 */
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
  { ticker: '7203.T', name: 'トヨタ自動車', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7267.T', name: 'ホンダ', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7201.T', name: '日産自動車', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7269.T', name: 'スズキ', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7270.T', name: 'SUBARU', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7272.T', name: 'ヤマハ発動機', sectorLarge: '自動車・輸送機', marketSegment: 'プライム', marginType: '貸借' },

  // 電機・精密
  { ticker: '6758.T', name: 'ソニーグループ', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6501.T', name: '日立製作所', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6502.T', name: '東芝', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6701.T', name: 'NEC', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6702.T', name: '富士通', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6752.T', name: 'パナソニック', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6594.T', name: 'ニデック', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6981.T', name: '村田製作所', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6861.T', name: 'キーエンス', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6857.T', name: 'アドバンテスト', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8035.T', name: '東京エレクトロン', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7733.T', name: 'オリンパス', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7741.T', name: 'HOYA', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7751.T', name: 'キヤノン', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7974.T', name: '任天堂', sectorLarge: '電機・精密', marketSegment: 'プライム', marginType: '貸借' },

  // 機械
  { ticker: '6273.T', name: 'SMC', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6301.T', name: 'コマツ', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6326.T', name: 'クボタ', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6367.T', name: 'ダイキン工業', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6954.T', name: 'ファナック', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '7011.T', name: '三菱重工業', sectorLarge: '機械', marketSegment: 'プライム', marginType: '貸借' },

  // 通信・ITサービス
  { ticker: '9432.T', name: 'NTT', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9433.T', name: 'KDDI', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9434.T', name: 'ソフトバンク', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9613.T', name: 'NTTデータ', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9984.T', name: 'ソフトバンクグループ', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '6098.T', name: 'リクルート', sectorLarge: '通信・ITサービス', marketSegment: 'プライム', marginType: '貸借' },

  // 銀行・金融
  { ticker: '8306.T', name: '三菱UFJ', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8316.T', name: '三井住友FG', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8411.T', name: 'みずほFG', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8591.T', name: 'オリックス', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8725.T', name: 'MS&AD', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8766.T', name: '東京海上HD', sectorLarge: '銀行・金融', marketSegment: 'プライム', marginType: '貸借' },

  // 商社・小売
  { ticker: '8001.T', name: '伊藤忠商事', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8031.T', name: '三井物産', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8053.T', name: '住友商事', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8058.T', name: '三菱商事', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8267.T', name: 'イオン', sectorLarge: '商社・小売', marketSegment: 'プライム', marginType: '貸借' },

  // 不動産・建設
  { ticker: '8801.T', name: '三井不動産', sectorLarge: '不動産・建設', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '8802.T', name: '三菱地所', sectorLarge: '不動産・建設', marketSegment: 'プライム', marginType: '貸借' },

  // 運輸・物流
  { ticker: '9020.T', name: 'JR東日本', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9021.T', name: 'JR西日本', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9022.T', name: 'JR東海', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9101.T', name: '日本郵船', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9104.T', name: '商船三井', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9201.T', name: 'JAL', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9202.T', name: 'ANA', sectorLarge: '運輸・物流', marketSegment: 'プライム', marginType: '貸借' },

  // エネルギー・素材
  { ticker: '9501.T', name: '東京電力', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9503.T', name: '関西電力', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9531.T', name: '東京ガス', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4063.T', name: '信越化学工業', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '5108.T', name: 'ブリヂストン', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '5401.T', name: '日本製鉄', sectorLarge: 'エネルギー・素材', marketSegment: 'プライム', marginType: '貸借' },

  // 医薬品・ヘルスケア
  { ticker: '4502.T', name: '武田薬品', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4503.T', name: 'アステラス製薬', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4519.T', name: '中外製薬', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4543.T', name: 'テルモ', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4568.T', name: '第一三共', sectorLarge: '医薬品・ヘルスケア', marketSegment: 'プライム', marginType: '貸借' },

  // 食品・生活用品
  { ticker: '4452.T', name: '花王', sectorLarge: '食品・生活用品', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '4901.T', name: '富士フイルム', sectorLarge: '食品・生活用品', marketSegment: 'プライム', marginType: '貸借' },

  // サービス・娯楽
  { ticker: '4661.T', name: 'オリエンタルランド', sectorLarge: 'サービス・娯楽', marketSegment: 'プライム', marginType: '貸借' },
  { ticker: '9735.T', name: 'セコム', sectorLarge: 'サービス・娯楽', marketSegment: 'プライム', marginType: '貸借' },
]

export const ALL_TICKERS: MasterTicker[] = JP_TICKERS

/** 後方互換のため残しているが、現在はすべて JP 銘柄を返す。 */
export function getTickersByMarket(_market?: unknown): MasterTicker[] {
  return JP_TICKERS
}

export function findTicker(ticker: string): MasterTicker | undefined {
  return ALL_TICKERS.find((t) => t.ticker === ticker)
}
