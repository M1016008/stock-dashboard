// types/tradingview.d.ts
declare global {
  interface TradingViewWidgetConfig {
    symbol: string
    interval: string
    timezone: string
    theme: 'dark' | 'light'
    style: string
    locale: string
    toolbar_bg?: string
    enable_publishing?: boolean
    hide_top_toolbar?: boolean
    hide_legend?: boolean
    save_image?: boolean
    height?: number | string
    width?: number | string
    container_id?: string
    autosize?: boolean
    studies?: string[]
  }

  interface TradingViewWidgetInstance {
    onChartReady: (callback: () => void) => void
    activeChart: () => {
      createStudy: (
        name: string,
        forceOverlay: boolean,
        lock: boolean,
        inputs: Record<string, unknown>,
        overrides?: Record<string, string>
      ) => void
    }
    remove: () => void
  }

  interface Window {
    TradingView: {
      widget: new (config: TradingViewWidgetConfig) => TradingViewWidgetInstance
    }
  }
}

export {}
