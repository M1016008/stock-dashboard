// types/stock.ts
export interface StockQuote {
  ticker: string;
  market: 'JP' | 'US';
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  marketCap?: number;
  currency: 'JPY' | 'USD';
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  averageDailyVolume10Day?: number;
  exchange?: string;
}

export interface OHLCV {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Fundamentals {
  per?: number;
  pbr?: number;
  roe?: number;
  eps?: number;
  dividendYield?: number;
  revenue?: number;
  operatingIncome?: number;
  // 業種情報 (PHASE 9)
  sector33?: string;       // 例: "輸送用機器"（日本株のみ）
  sector17?: string;       // 例: "自動車・輸送機"（日本株のみ）
  sectorEn?: string;       // 例: "Consumer Cyclical"（米国株はYahooから）
  industry?: string;       // 例: "Auto Manufacturers"
  marketSegment?: string;  // 例: "プライム"（日本株のみ）
}

export interface ScreenerResult extends StockQuote, Fundamentals {}
