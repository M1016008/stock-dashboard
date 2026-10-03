import Link from 'next/link'
import { Bot, ChevronRight, Search, ShieldAlert, Sparkles } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
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
      tone: 'border-[rgba(217,119,6,0.24)] bg-[#fff7ed] text-[#b45309]',
      prompt: `${dateText}で、${scope}から初動候補を探してください。PFS、PMS、6ステージ、出来高、ML類似候補を総合し、上位候補を根拠付きでランキングしてください。`,
      note: 'PFS/PMS + ステージ',
    },
    {
      title: '下落警戒を探す',
      icon: ShieldAlert,
      tone: 'border-[rgba(30,64,175,0.24)] bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]',
      prompt: `${dateText}で、${scope}から下落警戒銘柄を探してください。PMS/PFSの悪化、物理ステータス、週足の弱さ、過去類似パターン、ML下落候補を重視して、上昇しにくく下方向へ傾きやすい候補を出してください。`,
      note: '失速/下落リスク',
    },
    {
      title: '決算前後の注意',
      icon: Search,
      tone: 'border-[rgba(185,28,28,0.22)] bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]',
      prompt: `${dateText}で、${scope}の決算・イベント注意銘柄を探してください。近い決算予定、発表後の値動き、出来高、6ステージ、MLシグナルを使い、注意すべき順に整理してください。`,
      note: '決算 + シグナル',
    },
    {
      title: '今の相場で質問',
      icon: Bot,
      tone: 'border-[var(--color-border-soft)] bg-white text-[var(--color-brand-800)]',
      prompt: `${dateText}の${scope}について、初動、継続、失速、下落警戒の観点から、今日見るべき銘柄と確認ポイントを提案してください。必要な条件が足りなければ質問してください。`,
      note: '会話で具体化',
    },
  ]

  return (
    <Card size="lg" className="p-0">
      <CardHeader
        title="AIに探してもらうショートカット"
        hint="ダッシュボードで気になった文脈を、そのままAI銘柄リサーチへ渡します。"
        action={
          <Link href="/ai/research" prefetch={false} className="rounded-full border border-current/25 bg-white px-2.5 py-1 text-[10px] font-black hover:bg-[var(--color-surface-subtle)]">
            AIリサーチ
          </Link>
        }
      />
      <div className="grid gap-3 px-4 pb-4 md:grid-cols-2 xl:grid-cols-4">
        {shortcuts.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.title}
              href={shortcutHref(item.prompt)}
              prefetch={false}
              className={`group rounded-[8px] border p-3 transition hover:translate-y-[-1px] hover:shadow-sm ${item.tone}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-current/20 bg-white/70">
                  <Icon size={16} />
                </span>
                <ChevronRight size={16} className="mt-1 opacity-50 transition group-hover:translate-x-0.5 group-hover:opacity-80" />
              </div>
              <div className="mt-3 text-[13px] font-black">{item.title}</div>
              <div className="mt-1 text-[10px] font-black opacity-65">{item.note}</div>
              <p className="mt-2 line-clamp-3 text-[10px] font-semibold leading-relaxed opacity-78">
                {item.prompt}
              </p>
            </Link>
          )
        })}
      </div>
    </Card>
  )
}
