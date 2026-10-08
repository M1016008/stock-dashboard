import Link from 'next/link'
import { ArrowUpRight, Bot, ChevronRight, Search, ShieldAlert, Sparkles } from 'lucide-react'
import { getUniverseFilterMeta, type UniverseFilterValue } from '@/lib/market-universe'

function shortcutHref(prompt: string): string {
  const sp = new URLSearchParams({
    prompt,
    autoRun: '1',
    reset: '1',
    source: 'dashboard',
  })
  return `/ai/research?${sp.toString()}`
}

/**
 * 次の分析: Dashboard の文脈を AI 銘柄リサーチへ渡すコマンド列。
 * 色は付けず (装飾色を使わない)、アイコンと短い説明だけで区別する。
 * 渡すプロンプト文は従来どおり。全文は title (ホバー) で確認できる。
 */
export function AiResearchShortcuts({
  date = null,
  universe = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
}) {
  const universeMeta = getUniverseFilterMeta(universe)
  const scope = universeMeta?.shortLabel ?? '日本株全体'
  const dateText = date ? `${date}大引け基準` : '最新データ基準'
  const shortcuts = [
    {
      title: '初動候補を探す',
      icon: Sparkles,
      prompt: `${dateText}で、${scope}から初動候補を探してください。PFS、PMS、6ステージ、出来高、ML類似候補を総合し、上位候補を根拠付きでランキングしてください。`,
      note: 'PFS/PMS + ステージ',
    },
    {
      title: '下落警戒を探す',
      icon: ShieldAlert,
      prompt: `${dateText}で、${scope}から下落警戒銘柄を探してください。PMS/PFSの悪化、物理ステータス、週足の弱さ、過去類似パターン、ML下落候補を重視して、上昇しにくく下方向へ傾きやすい候補を出してください。`,
      note: '失速/下落リスク',
    },
    {
      title: '決算前後の注意',
      icon: Search,
      prompt: `${dateText}で、${scope}の決算・イベント注意銘柄を探してください。近い決算予定、発表後の値動き、出来高、6ステージ、MLシグナルを使い、注意すべき順に整理してください。`,
      note: '決算 + シグナル',
    },
    {
      title: '今の相場で質問',
      icon: Bot,
      prompt: `${dateText}の${scope}について、初動、継続、失速、下落警戒の観点から、今日見るべき銘柄と確認ポイントを提案してください。必要な条件が足りなければ質問してください。`,
      note: '会話で具体化',
    },
  ]

  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
        <span>
          {scope} · {dateText} の文脈をそのまま AI 銘柄リサーチへ渡します
        </span>
        <Link href="/ai/research" prefetch={false} className="inline-flex items-center gap-0.5 font-bold text-[var(--color-brand-700)] hover:underline">
          AIリサーチを開く
          <ArrowUpRight size={12} aria-hidden="true" />
        </Link>
      </div>
      <ul className="grid border-y border-[var(--color-border-soft)] sm:grid-cols-2 xl:grid-cols-4 max-sm:divide-y max-sm:divide-[var(--color-border-soft)]">
        {shortcuts.map((item, index) => {
          const Icon = item.icon
          return (
            <li
              key={item.title}
              className={`min-w-0 ${index % 2 === 1 ? 'sm:border-l sm:border-[var(--color-border-soft)]' : ''} ${index >= 2 ? 'sm:max-xl:border-t sm:max-xl:border-[var(--color-border-soft)]' : ''} ${index === 2 ? 'xl:border-l xl:border-[var(--color-border-soft)]' : ''}`}
            >
              <Link
                href={shortcutHref(item.prompt)}
                prefetch={false}
                title={item.prompt}
                className="group flex h-full items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--color-surface-subtle)]"
              >
                <Icon size={16} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-bold text-[var(--color-brand-900)]">{item.title}</span>
                  <span className="block truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.note}</span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-[var(--color-text-tertiary)] transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
