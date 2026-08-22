import {
  Activity,
  BarChart3,
  Building2,
  CalendarDays,
  ChartCandlestick,
  FlaskConical,
  Hexagon,
  LayoutDashboard,
  ListFilter,
  MessageSquareText,
  Radar,
  Search,
  Star,
  type LucideIcon,
} from 'lucide-react'

export type HeaderArea = 'jp' | 'us' | 'commodities'

export type PageDefinition = {
  href: string
  label: string
  description: string
  icon: LucideIcon
  commandVerb: string
  commandBadge: string
  searchTerms?: string
}

export const PAGE_CATALOG = {
  dashboard: {
    href: '/',
    label: 'ダッシュボード',
    description: '今日の市場判断と売買候補',
    icon: LayoutDashboard,
    commandVerb: '開く',
    commandBadge: '機能',
    searchTerms: 'ホーム 市場概要',
  },
  marketMomentum: {
    href: '/market-momentum',
    label: '市場モメンタム',
    description: '市場全体の初動・継続・減速を確認',
    icon: BarChart3,
    commandVerb: '市場',
    commandBadge: '市場',
    searchTerms: '地合い 全体 強弱',
  },
  sectors: {
    href: '/sectors',
    label: '業種分析',
    description: '業種の強弱と6ステージ分布',
    icon: Building2,
    commandVerb: '業種',
    commandBadge: '市場',
    searchTerms: 'セクター 四季報 J-Quants ステージ分布',
  },
  sectorStructure: {
    href: '/sectors?view=structure',
    label: '業種別ステージ分布',
    description: '日・週・月A/Bの偏りを業種別に確認',
    icon: Hexagon,
    commandVerb: '業種',
    commandBadge: '市場',
    searchTerms: '6ステージ 構造 ヒートマップ',
  },
  sectorEtfs: {
    href: '/sector-etfs',
    label: '業界ETF分析',
    description: 'ETFで業界・テーマの流れを確認',
    icon: ChartCandlestick,
    commandVerb: '業種',
    commandBadge: '市場',
    searchTerms: 'TOPIX17 セクターETF',
  },
  themes: {
    href: '/themes',
    label: 'テーマ',
    description: '人気テーマと関連銘柄',
    icon: ListFilter,
    commandVerb: '業種',
    commandBadge: '市場',
    searchTerms: '株探 人気 関連銘柄',
  },
  materials: {
    href: '/materials',
    label: '材料ニュース',
    description: '材料と関連銘柄を確認',
    icon: ListFilter,
    commandVerb: '確認',
    commandBadge: 'イベント',
    searchTerms: 'ニュース 適時開示',
  },
  earnings: {
    href: '/earnings',
    label: '決算カレンダー',
    description: '決算予定と発表後の値動き',
    icon: CalendarDays,
    commandVerb: '確認',
    commandBadge: 'イベント',
    searchTerms: '業績 発表',
  },
  screener: {
    href: '/screener',
    label: 'スクリーナー',
    description: '条件で日本株を抽出',
    icon: Search,
    commandVerb: '探す',
    commandBadge: '探索',
    searchTerms: '日本株 条件検索',
  },
  stageScreener: {
    href: '/stage-screener',
    label: 'ステージスクリーナー',
    description: '日・週・月のステージ行列で抽出',
    icon: Hexagon,
    commandVerb: '探す',
    commandBadge: '探索',
    searchTerms: 'HEX 6ステージ 銘柄抽出',
  },
  aiResearch: {
    href: '/ai/research',
    label: 'AI銘柄リサーチ',
    description: '会話を条件化しDB根拠で候補表示',
    icon: MessageSquareText,
    commandVerb: '相談',
    commandBadge: '探索',
    searchTerms: '自然言語 会話 スクリーニング',
  },
  hexStage: {
    href: '/hex-stage',
    label: '市場6ステージ',
    description: '市場全体の分布と直近遷移',
    icon: Hexagon,
    commandVerb: '分析',
    commandBadge: '6ステージ',
    searchTerms: 'HEX 分布 市場構造',
  },
  maLens: {
    href: '/ai/ma-lens',
    label: 'MA・類似分析',
    description: 'MA形状・物理特徴量・類似候補',
    icon: Activity,
    commandVerb: '分析',
    commandBadge: 'AI',
    searchTerms: 'AI Lens MA構造 クラスタ 類似銘柄',
  },
  historicalPatterns: {
    href: '/ai/ma-lens#historical-pattern-search',
    label: '本質類似局面',
    description: 'MA構造が近い過去局面・現在銘柄',
    icon: ChartCandlestick,
    commandVerb: '分析',
    commandBadge: 'AI',
    searchTerms: '過去パターン検索 アナログ',
  },
  transitions: {
    href: '/ai/transitions',
    label: '過去パターン遷移',
    description: '6軸パターンの過去遷移を分析',
    icon: ChartCandlestick,
    commandVerb: '分析',
    commandBadge: '6ステージ',
    searchTerms: '統計 履歴',
  },
  backtest: {
    href: '/backtest',
    label: '過去検証',
    description: 'シグナルと期待値を検証',
    icon: FlaskConical,
    commandVerb: '検証',
    commandBadge: '分析',
    searchTerms: 'バックテスト',
  },
  chartDrill: {
    href: '/chart-drill',
    label: 'チャートドリル',
    description: '過去チャートで初動察知を練習',
    icon: ChartCandlestick,
    commandVerb: '練習',
    commandBadge: '分析',
    searchTerms: 'トレーニング',
  },
  tradeWorkbench: {
    href: '/trade/workbench',
    label: '売買候補',
    description: '根拠つき注文案の下書き',
    icon: FlaskConical,
    commandVerb: '計画',
    commandBadge: '分析',
    searchTerms: 'トレード ワークベンチ 注文',
  },
  customCharts: {
    href: '/custom-charts',
    label: '合成チャート',
    description: '複数銘柄を数式で合成・比較',
    icon: ChartCandlestick,
    commandVerb: '作成',
    commandBadge: '分析',
    searchTerms: '比較 独自チャート',
  },
  watchlist: {
    href: '/watchlist',
    label: 'ウォッチリスト',
    description: '保存した日本株・米国株を監視',
    icon: Star,
    commandVerb: '監視',
    commandBadge: '監視',
    searchTerms: 'お気に入り 保存',
  },
  ma25mMonitor: {
    href: '/ma25m-monitor',
    label: '月足MA監視',
    description: '3〜25か月線と集中帯を監視',
    icon: Radar,
    commandVerb: '監視',
    commandBadge: '監視',
    searchTerms: '月足 移動平均',
  },
  usDashboard: {
    href: '/us',
    label: '米国株ダッシュボード',
    description: '米国市場の概要と候補',
    icon: LayoutDashboard,
    commandVerb: '開く',
    commandBadge: 'US',
    searchTerms: 'US ホーム 市場概要',
  },
  usScreener: {
    href: '/us/screener',
    label: 'USスクリーナー',
    description: '条件で米国株を抽出',
    icon: Search,
    commandVerb: '探す',
    commandBadge: 'US探索',
    searchTerms: '米国株 条件検索',
  },
  usStageScreener: {
    href: '/us/stage-screener',
    label: 'USステージスクリーナー',
    description: '日・週・月のステージ行列で抽出',
    icon: Hexagon,
    commandVerb: '探す',
    commandBadge: 'US探索',
    searchTerms: '米国株 HEX 6ステージ',
  },
  usAiResearch: {
    href: '/ai/research?market=US',
    label: 'US AI銘柄リサーチ',
    description: '米国株を自然言語で探索',
    icon: MessageSquareText,
    commandVerb: '相談',
    commandBadge: 'US探索',
    searchTerms: '米国株 AI 会話',
  },
  usMlLens: {
    href: '/us/analysis/ml-lens',
    label: 'US AI Lens',
    description: 'US物理特徴量・ML候補・類似局面',
    icon: Activity,
    commandVerb: '分析',
    commandBadge: 'US分析',
    searchTerms: '米国株 MA 類似',
  },
  usTransitions: {
    href: '/us/analysis/transitions',
    label: 'USステージ遷移',
    description: 'US日・週・月の構造を分析',
    icon: ChartCandlestick,
    commandVerb: '分析',
    commandBadge: 'US分析',
    searchTerms: '米国株 6ステージ',
  },
  usBacktest: {
    href: '/us/analysis/backtest',
    label: 'US過去検証',
    description: 'USモデル・物理状態・RLを検証',
    icon: FlaskConical,
    commandVerb: '検証',
    commandBadge: 'US分析',
    searchTerms: '米国株 バックテスト',
  },
  usChartDrill: {
    href: '/chart-drill?market=US',
    label: 'USチャートドリル',
    description: 'US過去チャートで初動を練習',
    icon: ChartCandlestick,
    commandVerb: '練習',
    commandBadge: 'US分析',
    searchTerms: '米国株 トレーニング',
  },
  commoditiesDashboard: {
    href: '/commodities',
    label: 'コモディティ概要',
    description: '商品ETFの市場概要',
    icon: LayoutDashboard,
    commandVerb: '開く',
    commandBadge: '商品',
    searchTerms: '商品 ホーム 金 原油',
  },
  commoditiesScreener: {
    href: '/commodities/screener',
    label: '商品スクリーナー',
    description: 'コモディティETFを条件で探索',
    icon: Search,
    commandVerb: '探す',
    commandBadge: '商品',
    searchTerms: '金 原油 ETF',
  },
} as const satisfies Record<string, PageDefinition>

export type PageId = keyof typeof PAGE_CATALOG

export type NavigationSection = {
  id: string
  label: string
  pageIds: readonly PageId[]
  column?: 1 | 2
}

export type NavigationEntry =
  | {
      kind: 'link'
      pageId: PageId
      label: string
      shortLabel: string
      icon: LucideIcon
    }
  | {
      kind: 'menu'
      id: string
      label: string
      shortLabel: string
      icon: LucideIcon
      sections: readonly NavigationSection[]
    }

export const NAVIGATION_BY_AREA = {
  jp: [
    { kind: 'link', pageId: 'dashboard', label: 'ホーム', shortLabel: 'ホーム', icon: LayoutDashboard },
    {
      kind: 'menu',
      id: 'market',
      label: '市場・業種',
      shortLabel: '市場',
      icon: Building2,
      sections: [
        { id: 'market-overview', label: '市場全体', pageIds: ['marketMomentum'], column: 1 },
        { id: 'industries', label: '業種・テーマ', pageIds: ['sectors', 'sectorEtfs', 'themes'], column: 2 },
        { id: 'events', label: 'イベント', pageIds: ['earnings', 'materials'], column: 1 },
      ],
    },
    {
      kind: 'menu',
      id: 'explore',
      label: '銘柄探索',
      shortLabel: '探索',
      icon: Search,
      sections: [
        { id: 'filters', label: '条件から探す', pageIds: ['screener', 'stageScreener'], column: 1 },
        { id: 'conversation', label: '対話で探す', pageIds: ['aiResearch'], column: 2 },
      ],
    },
    {
      kind: 'menu',
      id: 'analysis',
      label: '分析・AI',
      shortLabel: '分析',
      icon: Activity,
      sections: [
        { id: 'stages', label: '6ステージ', pageIds: ['hexStage', 'transitions'], column: 1 },
        { id: 'ma-similarity', label: 'MA・類似分析', pageIds: ['maLens'], column: 1 },
        { id: 'validation', label: '検証・実践', pageIds: ['backtest', 'chartDrill', 'tradeWorkbench', 'customCharts'], column: 2 },
      ],
    },
    {
      kind: 'menu',
      id: 'monitor',
      label: '監視',
      shortLabel: '監視',
      icon: Star,
      sections: [
        { id: 'continuous-monitoring', label: '継続監視', pageIds: ['watchlist', 'ma25mMonitor'], column: 1 },
      ],
    },
  ],
  us: [
    { kind: 'link', pageId: 'usDashboard', label: 'ホーム', shortLabel: 'ホーム', icon: LayoutDashboard },
    {
      kind: 'menu',
      id: 'us-explore',
      label: '銘柄探索',
      shortLabel: '探索',
      icon: Search,
      sections: [
        { id: 'us-filters', label: '条件から探す', pageIds: ['usScreener', 'usStageScreener'], column: 1 },
        { id: 'us-conversation', label: '対話で探す', pageIds: ['usAiResearch'], column: 2 },
      ],
    },
    {
      kind: 'menu',
      id: 'us-analysis',
      label: '分析・AI',
      shortLabel: '分析',
      icon: Activity,
      sections: [
        { id: 'us-models', label: '構造・AI', pageIds: ['usMlLens', 'usTransitions'], column: 1 },
        { id: 'us-validation', label: '検証・実践', pageIds: ['usBacktest', 'usChartDrill', 'customCharts'], column: 2 },
      ],
    },
    {
      kind: 'menu',
      id: 'us-monitor',
      label: '監視',
      shortLabel: '監視',
      icon: Star,
      sections: [
        { id: 'us-continuous-monitoring', label: '継続監視', pageIds: ['watchlist'], column: 1 },
      ],
    },
  ],
  commodities: [
    { kind: 'link', pageId: 'commoditiesDashboard', label: 'ホーム', shortLabel: 'ホーム', icon: LayoutDashboard },
    { kind: 'link', pageId: 'commoditiesScreener', label: '銘柄探索', shortLabel: '探索', icon: Search },
  ],
} as const satisfies Record<HeaderArea, readonly NavigationEntry[]>

export const PAGE_CATALOG_ENTRIES = Object.entries(PAGE_CATALOG) as Array<
  [PageId, (typeof PAGE_CATALOG)[PageId]]
>

export const QUICK_COMMAND_PAGE_IDS_BY_AREA = {
  jp: ['dashboard', 'marketMomentum', 'screener', 'maLens', 'watchlist'],
  us: ['usDashboard', 'usScreener', 'usMlLens', 'usAiResearch', 'watchlist'],
  commodities: ['commoditiesDashboard', 'commoditiesScreener'],
} as const satisfies Record<HeaderArea, readonly PageId[]>
