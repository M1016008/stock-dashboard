// types/alert.ts
export type AlertCondition =
  | {
      type: 'PRICE_ABOVE';
      ticker: string;
      market: 'JP' | 'US';
      threshold: number;
    }
  | {
      type: 'PRICE_BELOW';
      ticker: string;
      market: 'JP' | 'US';
      threshold: number;
    }
  | {
      type: 'MA_ORDER';
      ticker: string;
      market: 'JP' | 'US';
      order: 'BULLISH' | 'BEARISH';
    }
  | {
      type: 'GOLDEN_CROSS';
      ticker: string;
      market: 'JP' | 'US';
      shortPeriod: number;
      longPeriod: number;
    }
  | {
      type: 'DEAD_CROSS';
      ticker: string;
      market: 'JP' | 'US';
      shortPeriod: number;
      longPeriod: number;
    }
  | {
      type: 'MACD_DEAD_CROSS';
      ticker: string;
      market: 'JP' | 'US';
    }
  | {
      type: 'MACD_GOLDEN_CROSS';
      ticker: string;
      market: 'JP' | 'US';
    };

export interface Alert {
  id: string;
  condition: AlertCondition;
  notifyRealtime: boolean;
  notifyDaily: boolean;
  email: string;
  enabled: boolean;
  createdAt: string;
  lastTriggeredAt?: string;
  cooldownMinutes: number;
  orderConfig?: {
    enabled: boolean;
    side: 'BUY' | 'SELL';
    cashMargin: 1 | 2 | 3;
    orderType: 'MARKET' | 'LIMIT';
    qty: number;
    requireConfirmation: boolean;
  };
}
