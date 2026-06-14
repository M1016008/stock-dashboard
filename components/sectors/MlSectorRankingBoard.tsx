'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import type { MlSectorCandidate, MlSectorRanking } from '@/lib/queries/ml-insights'
import { StageTag } from '@/components/ui/StageTag'

type CandidateResponse = {
  asOfDate: string | null
  count: number
  candidates: MlSectorCandidate[]
  error?: string
  message?: string
}

function directionLabel(direction: 'up' | 'down') {
  return direction === 'up' ? '上昇候補' : '下落警戒'
}

function directionTone(direction: 'up' | 'down') {
  return direction === 'up'
    ? {
        text: 'text-[var(--color-price-up)]',
        border: 'border-[rgba(220,38,38,0.24)]',
        bg: 'bg-[rgba(220,38,38,0.05)]',
        accent: 'bg-[rgba(220,38,38,0.72)]',
      }
    : {
        text: 'text-[var(--color-price-down)]',
        border: 'border-[rgba(37,99,235,0.24)]',
        bg: 'bg-[rgba(37,99,235,0.05)]',
        accent: 'bg-[rgba(37,99,235,0.72)]',
      }
}

function fmtScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })
}

function horizonLabel(days: number) {
  if (days <= 15) return `${days}営業日`
  if (days <= 60) return `${days}営業日`
  return `${days}営業日`
}

function keyFor(row: MlSectorRanking) {
  return `${row.asOfDate}:${row.horizonDays}:${row.sectorType}:${row.direction}:${row.sectorName}`
}

function StageCode({ code }: { code: string | null | undefined }) {
  if (!code) {
    return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">------</span>
  }
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`6桁ステージ ${code}`}>
      {code.split('').slice(0, 6).map((digit, index) => {
        const stage = Number(digit)
        return (
          <StageTag
            key={`${digit}-${index}`}
            stage={Number.isFinite(stage) ? stage : null}
            size="xs"
          />
        )
      })}
    </span>
  )
}

export function MlSectorRankingBoard({
  rows,
  asOfDate,
}: {
  rows: MlSectorRanking[]
  asOfDate: string | null
}) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [candidateMap, setCandidateMap] = useState<Record<string, MlSectorCandidate[]>>({})
  const sections = useMemo(() => {
    const horizonGroups = [
      { title: '短期', body: '5/10/15営業日。日足の勢いに、週足・月足の支援/抵抗を重ねます。', horizons: [5, 10, 15] },
      { title: '週足', body: '20/40/60営業日。週足トレンドが効く数週間〜約3か月の候補です。', horizons: [20, 40, 60] },
      { title: '月足', body: '90/180営業日。月足の向きまで含む中長期の候補です。', horizons: [90, 180] },
    ]
    const topRows = (horizons: number[], sectorType: '17' | '33', direction: 'up' | 'down') =>
      rows
        .filter((row) => horizons.includes(row.horizonDays) && row.sectorType === sectorType && row.direction === direction)
        .sort((a, b) => b.candidateCount - a.candidateCount || (b.avgScore ?? 0) - (a.avgScore ?? 0))
        .slice(0, 5)
    return horizonGroups.map((group) => ({
      ...group,
      blocks: [
        { title: '17業種 上昇候補集中', rows: topRows(group.horizons, '17', 'up') },
        { title: '17業種 下落警戒集中', rows: topRows(group.horizons, '17', 'down') },
        { title: '33業種 上昇候補集中', rows: topRows(group.horizons, '33', 'up') },
        { title: '33業種 下落警戒集中', rows: topRows(group.horizons, '33', 'down') },
      ],
    }))
  }, [rows])

  async function toggle(row: MlSectorRanking) {
    const key = keyFor(row)
    if (openKey === key) {
      setOpenKey(null)
      return
    }
    setOpenKey(key)
    if (candidateMap[key]) return
    setLoadingKey(key)
    setErrors((current) => ({ ...current, [key]: '' }))
    const params = new URLSearchParams({
      sectorType: row.sectorType,
      sectorName: row.sectorName,
      direction: row.direction,
      horizonDays: String(row.horizonDays),
      limit: '300',
    })
    if (row.asOfDate) params.set('date', row.asOfDate)
    try {
      const res = await fetch(`/api/ml/sector-candidates?${params.toString()}`, { cache: 'no-store' })
      const data = await res.json() as CandidateResponse
      if (!res.ok || data.error) throw new Error(data.message || data.error || '候補銘柄を取得できませんでした')
      setCandidateMap((current) => ({ ...current, [key]: Array.isArray(data.candidates) ? data.candidates : [] }))
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : '候補銘柄を取得できませんでした',
      }))
    } finally {
      setLoadingKey(null)
    }
  }

  return (
    <section className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 border-b-2 border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="border-l-4 border-[var(--color-market-red)] pl-2">
          <h2 className="text-[14px] font-bold text-[var(--color-brand-900)]">ML業種候補ランキング</h2>
          <p className="mt-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            MLが抽出した上昇候補/下落警戒がどの業種に偏っているかを見るテーマ発見用の集計です。行をクリックすると該当候補銘柄を展開します。
          </p>
          {asOfDate && (
            <p className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
              ML基準日: {asOfDate}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.title} className="space-y-2">
            <div>
              <div className="text-[13px] font-bold text-[var(--color-brand-900)]">{section.title}</div>
              <p className="mt-0.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{section.body}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {section.blocks.map((block) => (
                <div key={`${section.title}-${block.title}`} className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)]">
                  <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[13px] font-bold text-[var(--color-text-primary)]">
                    <span className="inline-flex items-center gap-2">
                      <span className={`h-4 w-1 rounded-full ${block.title.includes('下落') ? 'bg-[rgba(37,99,235,0.72)]' : 'bg-[rgba(220,38,38,0.72)]'}`} />
                      {block.title}
                    </span>
                  </div>
                  <div className="divide-y divide-[var(--color-border-soft)]">
                    {block.rows.map((row, index) => {
                      const key = keyFor(row)
                      const open = openKey === key
                      const candidates = candidateMap[key] ?? []
                      const loading = loadingKey === key
                      const error = errors[key]
                      const tone = directionTone(row.direction)
                      return (
                        <div key={key}>
                          <button
                            type="button"
                            className={`grid w-full grid-cols-[36px_1fr_auto] items-center gap-2 border-l-4 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-subtle)] ${
                              open ? tone.bg : ''
                            } ${tone.border} ${
                              open ? '' : 'border-l-transparent'
                            }`}
                            aria-expanded={open}
                            onClick={() => void toggle(row)}
                          >
                            <span className="font-bold tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
                            <span className="min-w-0">
                              <span className="block truncate font-bold text-[var(--color-text-primary)]">{row.sectorName}</span>
                              <span className="mt-0.5 block truncate text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                                {horizonLabel(row.horizonDays)} / <span className={tone.text}>{directionLabel(row.direction)}</span> / {row.representativeTickers.slice(0, 4).map((item) => item.ticker).join(', ') || '代表銘柄なし'}
                              </span>
                            </span>
                            <span className="flex items-center gap-2 text-right">
                              <span>
                                <span className={`block font-bold tabular-nums ${tone.text}`}>{row.candidateCount}件</span>
                                <span className="block text-[10px] font-bold tabular-nums text-[var(--color-text-tertiary)]">
                                  {fmtScore(row.avgScore)}
                                </span>
                              </span>
                              <ChevronDown
                                size={15}
                                className={`text-[var(--color-brand-700)] transition-transform ${open ? 'rotate-180' : ''}`}
                              />
                            </span>
                          </button>

                          {open && (
                            <div className="border-t border-[var(--color-border-soft)] bg-white px-3 py-3">
                              {loading && (
                                <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 text-[12px] font-bold text-[var(--color-text-tertiary)]">
                                  候補銘柄を取得しています...
                                </div>
                              )}
                              {error && !loading && (
                                <div className="rounded-[6px] border border-[var(--color-price-down)] bg-[rgba(37,99,235,0.06)] px-3 py-3 text-[12px] font-bold text-[var(--color-price-down)]">
                                  {error}
                                </div>
                              )}
                              {!loading && !error && (
                                <>
                                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
                                    <span>{horizonLabel(row.horizonDays)} / {directionLabel(row.direction)} {candidates.length.toLocaleString()}件を表示</span>
                                    {row.candidateCount > candidates.length && <span>上位{candidates.length.toLocaleString()}件まで表示</span>}
                                  </div>
                                  {candidates.length > 0 ? (
                                    <div className="overflow-x-auto">
                                      <table className="w-full min-w-[560px] text-[12px]">
                                        <thead className="text-[10px] font-bold text-[var(--color-text-tertiary)]">
                                          <tr>
                                            <th className="py-1.5 pr-2 text-left">順位</th>
                                            <th className="py-1.5 pr-2 text-left">銘柄</th>
                                            <th className="py-1.5 pr-2 text-right">スコア</th>
                                            <th className="py-1.5 pr-2 text-right">価格</th>
                                            <th className="py-1.5 pr-2 text-left">ステージ</th>
                                            <th className="py-1.5 text-left">MA</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-[var(--color-border-soft)]">
                                          {candidates.map((candidate) => (
                                            <tr key={`${key}-${candidate.ticker}`}>
                                              <td className="py-2 pr-2 font-bold tabular-nums text-[var(--color-text-tertiary)]">
                                                {candidate.rank}
                                              </td>
                                              <td className="py-2 pr-2">
                                                <Link
                                                  href={`/stock/${candidate.ticker}`}
                                                  prefetch={false}
                                                  className="inline-flex items-center gap-1 font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]"
                                                >
                                                  <span className="font-mono">{candidate.ticker}</span>
                                                  <span className="max-w-[180px] truncate">{candidate.name ?? ''}</span>
                                                  <ExternalLink size={12} />
                                                </Link>
                                              </td>
                                              <td className="py-2 pr-2 text-right font-bold tabular-nums text-[var(--color-brand-900)]">
                                                {fmtScore(candidate.candidateScore)}
                                              </td>
                                              <td className="py-2 pr-2 text-right tabular-nums text-[var(--color-text-secondary)]">
                                                {fmtPrice(candidate.close)}
                                              </td>
                                              <td className="py-2 pr-2">
                                                <StageCode code={candidate.stageCode} />
                                              </td>
                                              <td className="py-2 text-[var(--color-text-secondary)]">
                                                {candidate.maOrder ?? '-'}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : (
                                    <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
                                      この業種の候補銘柄は見つかりませんでした
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {block.rows.length === 0 && (
                      <div className="px-3 py-4 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">
                        ML業種ランキングは未作成です
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
