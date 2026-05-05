// types/practice.ts
export interface TradeRecord {
  id: string;
  ticker: string;
  replayDate: string;
  executedAt: string;
  action: 'BUY' | 'SELL' | 'CLOSE';
  price: number;
  qty: number;
  pnl?: number;
  pnlPercent?: number;
}

export interface PracticeSession {
  id: string;
  ticker: string;
  timeframe: string;
  startDate: string;
  endDate?: string;
  trades: TradeRecord[];
  totalPnl: number;
  winRate: number;
  createdAt: string;
}

export interface NewSession {
  ticker: string;
  timeframe: string;
  replayStartDate: string;
}

export interface SessionSummary {
  totalPnl: number;
  totalPnlPercent: number;
  winRate: number;
  totalTrades: number;
  winTrades: number;
  replayEndDate: string;
}
