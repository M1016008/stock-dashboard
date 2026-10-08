import { getStageTransitionDirection } from '@/lib/hex-stage'
import { changedStageCodeAxes } from '@/lib/stage-transition-scanner'

const TONES = {
  improving: { background: '#f0fdf4', border: 'rgba(22, 163, 74, 0.35)', color: '#166534', mark: '↑', name: '改善' },
  deteriorating: { background: '#eff6ff', border: 'rgba(37, 99, 235, 0.35)', color: '#1d4ed8', mark: '↓', name: '悪化' },
  mixed: { background: '#f5f5f4', border: 'rgba(120, 113, 108, 0.35)', color: '#57534e', mark: '', name: '' },
} as const

function horizonLabel(fromCode: string, toCode: string): string | null {
  const keys = changedStageCodeAxes(fromCode, toCode).map((axis) => axis.key)
  if (keys.length === 0) return null
  const layers = [
    { label: '日足', hit: keys.some((key) => key.startsWith('daily')) },
    { label: '週足', hit: keys.some((key) => key.startsWith('weekly')) },
    { label: '月足', hit: keys.some((key) => key.startsWith('monthly')) },
  ].filter((layer) => layer.hit)
  return layers.length === 1 ? `${layers[0].label}のみ` : layers.map((layer) => layer.label).join('・')
}

export function StageTransitionAxisChips({
  fromCode,
  toCode,
  showLayer = true,
  className = '',
}: {
  fromCode: string
  toCode: string
  showLayer?: boolean
  className?: string
}) {
  const changes = changedStageCodeAxes(fromCode, toCode).map((axis) => {
    const direction = getStageTransitionDirection(axis.from, axis.to)
    const tone: keyof typeof TONES = direction === 'improve' || direction === 'jump_improve'
      ? 'improving'
      : direction === 'deteriorate' || direction === 'jump_deteriorate'
        ? 'deteriorating'
        : 'mixed'
    return { ...axis, tone }
  })
  if (changes.length === 0) return null
  const layer = showLayer ? horizonLabel(fromCode, toCode) : null

  return (
    <ul className={`m-0 flex list-none flex-wrap items-center gap-1 p-0 ${className}`} aria-label="変化した軸">
      {changes.map((change) => {
        const tone = TONES[change.tone]
        return (
          <li
            key={change.key}
            className="inline-flex items-center whitespace-nowrap rounded-[3px] border px-1.5 text-[10px] font-semibold leading-4 tabular-nums"
            style={{ background: tone.background, borderColor: tone.border, color: tone.color }}
          >
            {change.label} {change.from}→{change.to}
            {tone.mark ? <span aria-hidden> {tone.mark}</span> : null}
            {tone.name ? <span className="sr-only">（{tone.name}）</span> : null}
          </li>
        )
      })}
      {layer ? (
        <li className="whitespace-nowrap pl-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">{layer}</li>
      ) : null}
    </ul>
  )
}
