// types/stock.ts
export interface StockQuote {
  ticker: string;
  market: 'JP' | 'US';
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  priceDate?: string;
  previousPriceDate?: string;
  priceQualityWarning?: string;
  isPriceDiscontinuous?: boolean;
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
  adjustedClose?: number | null;
}

export interface Fundamentals {
  pbr?: number;
  roe?: number;
  eps?: number;
  revenue?: number;
  operatingIncome?: number;
  // 業種情報 (PHASE 9)
  sector33?: string;       // 例: "輸送用機器"
  sector17?: string;       // 例: "自動車・輸送機"
  industry?: string;       // 例: "Auto Manufacturers"
  marketSegment?: string;  // 例: "プライム"
}

export interface ScreenerResult extends StockQuote, Fundamentals {}
